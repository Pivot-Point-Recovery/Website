// What a Stripe checkout session means, and what to do about it.
//
// Extracted so that the webhook and the reconciler apply *identical* rules. Two
// copies of "did this gift succeed?" is how a donation ends up recorded one way
// by the live path and another by the repair path, and the difference only ever
// shows up in the bank reconciliation months later.
//
// Every function here is idempotent. `acknowledge` is guarded by two marker
// columns, so running the reconciler over a gift the webhook already handled
// sends nothing a second time -- which is what makes it safe to run on a
// schedule.

import { type NotifyResult, sendDonorReceipt, sendNotification } from './notify.ts';
import { money } from './validate.ts';

// deno-lint-ignore no-explicit-any
export type Obj = any;
// deno-lint-ignore no-explicit-any
export type Db = any;

/** A Stripe id, whether the field arrived expanded or as a bare string. */
export function id(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as Obj).id === 'string') {
    return (value as Obj).id;
  }
  return null;
}

/** What Stripe says the money actually did. */
export function sessionOutcome(
  session: Obj,
): 'succeeded' | 'processing' | 'failed' | 'expired' | 'open' {
  if (session.status === 'expired') return 'expired';

  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (paid) return 'succeeded';

  if (session.status !== 'complete') return 'open';

  // Completed but unpaid: a delayed method (ACH debit) is still clearing, or it
  // already bounced. The payment intent is the only thing that knows which.
  const intentStatus = typeof session.payment_intent === 'object'
    ? session.payment_intent?.status
    : null;
  if (intentStatus === 'succeeded') return 'succeeded';
  if (intentStatus === 'canceled' || intentStatus === 'requires_payment_method') return 'failed';
  return 'processing';
}

export function sessionReceiptUrl(session: Obj): string | null {
  const intent = typeof session.payment_intent === 'object' ? session.payment_intent : null;
  const charge = intent && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  return charge?.receipt_url ?? null;
}

const ADDRESS_PARTS = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'];

/** The billing address Stripe collected, or null. Stripe sends every key back
 *  as null when it collected nothing, which is not worth storing. */
export function addressFrom(value: Obj): Record<string, string> | null {
  if (!value || typeof value !== 'object') return null;
  const address: Record<string, string> = {};
  for (const part of ADDRESS_PARTS) {
    const text = typeof value[part] === 'string' ? value[part].trim() : '';
    if (text) address[part] = text;
  }
  return Object.keys(address).length > 0 ? address : null;
}

/** "18 Main St, Leesburg, VA 20176" -- one line, for an email row. */
export function formatAddress(address: Obj): string {
  if (!address || typeof address !== 'object') return '';
  const region = [address.state, address.postal_code].filter(Boolean).join(' ');
  return [
    address.line1,
    address.line2,
    [address.city, region].filter(Boolean).join(', '),
    address.country && address.country !== 'US' ? address.country : '',
  ].filter(Boolean).join(', ');
}

function fundLabel(donation: Obj): string {
  return donation.metadata?.fund_label ?? donation.fund_designation ?? 'General support';
}

/** The database patch a session implies. Split out so the reconciler can show a
 *  human what *would* change before anything is written. */
export function sessionPatch(session: Obj): Record<string, unknown> {
  const outcome = sessionOutcome(session);
  const patch: Record<string, unknown> = {
    status: outcome === 'succeeded' ? 'succeeded' : outcome,
    stripe_session_id: session.id,
    stripe_payment_intent_id: id(session.payment_intent),
    stripe_subscription_id: id(session.subscription),
    stripe_customer_id: id(session.customer),
    updated_at: new Date().toISOString(),
  };
  if (typeof session.amount_total === 'number' && session.amount_total > 0) {
    patch.amount_cents = session.amount_total;
  }
  if (session.customer_details?.email) patch.donor_email = session.customer_details.email;
  if (session.customer_details?.name) patch.donor_name = session.customer_details.name;
  // Only ever adds: a phone the donor typed on our form is not overwritten by
  // the null Stripe returns when it did not ask for one.
  if (session.customer_details?.phone) patch.donor_phone = session.customer_details.phone;
  const address = addressFrom(session.customer_details?.address);
  if (address) patch.donor_address = address;
  if (outcome === 'succeeded') patch.receipt_url = sessionReceiptUrl(session);
  return patch;
}

/**
 * Apply a session to the donations table, and acknowledge it if it was paid.
 * Returns the row as it now stands, or null when the session has not resolved
 * into anything worth writing yet.
 *
 * `acknowledge: false` records the gift without emailing anybody -- for gifts
 * found long after the fact, where whether to send a late receipt is a
 * person's decision rather than a side effect.
 */
export async function applySession(
  db: Db,
  session: Obj,
  opts: { acknowledge?: boolean } = {},
): Promise<Obj | null> {
  const outcome = sessionOutcome(session);
  if (outcome === 'open') {
    // Nothing has happened yet -- the donor is still on Stripe's page.
    console.log('session_still_open', session.id);
    return null;
  }

  const patch = sessionPatch(session);
  const donationId = session.client_reference_id ?? session.metadata?.donation_id ?? null;
  const thank = outcome === 'succeeded' && opts.acknowledge !== false;

  // Match the row the checkout function created. Falling back to the session id
  // covers a session created outside our flow (a payment link, say).
  const query = donationId
    ? db.from('donations').update(patch).eq('id', donationId)
    : db.from('donations').update(patch).eq('stripe_session_id', session.id);

  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw error;

  if (data) {
    if (thank) await acknowledge(db, data);
    return data;
  }

  // Nothing matched -- record the gift rather than lose it. A gift Stripe took
  // that we have no row for is the one outcome with no acceptable excuse.
  const { data: inserted, error: insertError } = await db
    .from('donations')
    .insert({
      ...patch,
      donor_name: session.customer_details?.name ?? null,
      donor_email: session.customer_details?.email ?? null,
      amount_cents: session.amount_total ?? null,
      currency: session.currency ?? 'usd',
      is_recurring: Boolean(id(session.subscription)),
      frequency: id(session.subscription) ? 'monthly' : 'one-time',
      fund_designation: session.metadata?.fund_designation ?? 'general',
      employer_match: session.metadata?.employer_match === 'true',
      source: 'stripe',
      metadata: {
        reconstructed: true,
        fund_label: session.metadata?.fund_label ?? null,
      },
    })
    .select('*')
    .single();
  if (insertError) throw insertError;

  if (thank) await acknowledge(db, inserted);
  return inserted;
}

/**
 * Tell the donor, then tell staff. Neither is ever allowed to fail the caller:
 * the card is already charged, and throwing here would only make Stripe
 * redeliver an event we have already applied.
 *
 * Each side has its own marker column -- `receipt_sent_at` and `notified` -- so
 * a half-success retries only the half that failed rather than double-sending
 * the half that worked. That is also what makes this safe to run again over
 * gifts that were already acknowledged.
 */
export async function acknowledge(db: Db, donation: Obj, subject?: string): Promise<void> {
  if (!donation) return;

  const label = fundLabel(donation);
  const amount = money(donation.amount_cents);

  if (!donation.receipt_sent_at && donation.donor_email) {
    const receipt = await sendReceipt(db, donation);
    if (!receipt.notified) console.warn('donor_receipt_not_sent', donation.id, receipt.reason);
  }

  if (donation.notified) return;

  const heading = subject ?? (donation.is_recurring ? 'New monthly donation' : 'New donation');

  const result = await sendNotification(
    `${heading} — ${amount}`,
    [
      ['Amount', donation.is_recurring ? `${amount} per month` : amount],
      ['Frequency', donation.is_recurring ? 'Monthly recurring' : 'One-time'],
      ['Donor', donation.donor_name ?? ''],
      ['Email', donation.donor_email ?? ''],
      ['Phone', donation.donor_phone ?? ''],
      ['Address', formatAddress(donation.donor_address)],
      ['Their note', donation.donor_note ?? ''],
      ['Designation', label],
      ['Employer match', donation.employer_match ? 'Yes — donor will submit paperwork' : 'No'],
      ['Receipt', donation.receipt_url ?? ''],
    ],
    {
      replyTo: donation.donor_email ?? undefined,
      intro: `${donation.donor_name ?? 'A donor'} gave ${amount} through the website.`,
      // A gift, not an enquiry -- goes to whoever reconciles donations.
      audience: 'donations',
    },
  );

  if (result.notified) {
    await db.from('donations').update({ notified: true }).eq('id', donation.id);
  } else {
    console.warn('donation_not_notified', donation.id, result.reason);
  }
}

/**
 * The donor's tax receipt on its own, stamped with when it went. Used by
 * `acknowledge`, and by the Board Center's "Send receipt" for a gift that was
 * recorded without one.
 */
export async function sendReceipt(db: Db, donation: Obj): Promise<NotifyResult> {
  const result = await sendDonorReceipt({
    donorName: donation.donor_name ?? '',
    donorEmail: donation.donor_email ?? '',
    amountCents: donation.amount_cents,
    isRecurring: Boolean(donation.is_recurring),
    fundLabel: fundLabel(donation),
    receiptUrl: donation.receipt_url,
    date: (donation.created_at ?? new Date().toISOString()).slice(0, 10),
  });
  if (result.notified) {
    await db.from('donations')
      .update({ receipt_sent_at: new Date().toISOString() })
      .eq('id', donation.id);
  }
  return result;
}
