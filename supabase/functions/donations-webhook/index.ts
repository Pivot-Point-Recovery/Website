// Stripe webhook receiver.
//
// This is the only place a donation becomes `succeeded`. The browser never gets
// to assert that a payment worked -- a donor closing the tab on the Stripe page
// must not leave a gift unrecorded, and a donor replaying the success URL must
// not create one.
//
// verify_jwt is off because Stripe cannot present a Supabase JWT. Two things
// authenticate this endpoint instead:
//
//  1. The HMAC signature check, when STRIPE_WEBHOOK_SECRET is configured.
//  2. An authoritative re-fetch. Nothing from the request body is ever written
//     to the database. The body is read only for an object id; every field we
//     store comes back from a direct authenticated GET against Stripe. So the
//     worst a forged request can achieve is making us re-read a real object and
//     converge on the state Stripe already holds.
//
// That second layer is what lets the endpoint stay correct before the signing
// secret is in place. A webhook that rejected everything until then would lose
// the notification for real, already-charged donations -- a worse failure than
// re-reading an object an attacker named.

import { serviceClient } from '../_shared/db.ts';
import { env, envNamesMatching, envShape, envSourceName, hasEnv, healthReport } from '../_shared/env.ts';
import { stripeRequest, verifySignature } from '../_shared/stripe.ts';
import { recipientCount } from '../_shared/notify.ts';
// The rules for what a session means, and what to do about it, live in
// _shared/donations.ts so this endpoint and the reconciler cannot drift apart.
import { acknowledge, addressFrom, applySession, type Db, id, type Obj } from '../_shared/donations.ts';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY'];
const OPTIONAL_SECRETS = [
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'NOTIFICATION_EMAILS',
  'RESEND_FROM',
];

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** How many Stripe events have ever been applied. Null if unreadable. */
async function eventsApplied(): Promise<number | null> {
  try {
    const { count, error } = await serviceClient()
      .from('stripe_events')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    return count ?? 0;
  } catch (error) {
    console.error('stripe_events_unreadable', error);
    return null;
  }
}

/** A Stripe id we are willing to look up, by object kind. */
const ID_PREFIX: Record<string, string> = {
  session: 'cs_',
  invoice: 'in_',
  subscription: 'sub_',
};

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return reply({
        service: 'donations-webhook',
        ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS),
        // How this request would be authenticated right now. `refetch_only`
        // still writes nothing it did not read back from Stripe, but signature
        // verification is the intended posture -- set STRIPE_WEBHOOK_SECRET.
        verification: hasEnv('STRIPE_WEBHOOK_SECRET') ? 'signature' : 'refetch_only',
        // Which variable actually supplied each secret, and what shape it is.
        // Names and prefixes only -- no value, or any part of one, is returned.
        //
        // "configured: true" was never proof the *right* secret was set. The
        // alias lists in env.ts are generous by design, so a leftover
        // WEBHOOK_SECRET satisfies the check while every real delivery fails
        // its HMAC, which looks identical from outside to Stripe never calling.
        // These three fields separate those cases without a Stripe login.
        resolved: {
          STRIPE_SECRET_KEY: envSourceName('STRIPE_SECRET_KEY'),
          STRIPE_WEBHOOK_SECRET: envSourceName('STRIPE_WEBHOOK_SECRET'),
        },
        shape: {
          STRIPE_SECRET_KEY: envShape('STRIPE_SECRET_KEY'),
          STRIPE_WEBHOOK_SECRET: envShape('STRIPE_WEBHOOK_SECRET'),
        },
        // A signing secret that is not `whsec_...` cannot verify anything.
        signing_secret_well_formed:
          (envShape('STRIPE_WEBHOOK_SECRET')?.prefix ?? null) === 'whsec_',
        stripe_env_names: envNamesMatching(/STRIPE/i),
        // Has any Stripe delivery ever been applied? Empty means the endpoint
        // has never once been reached successfully -- a registration problem in
        // the Stripe dashboard, not a problem with any individual gift.
        events_applied: await eventsApplied(),
        // Count only, never the addresses.
        recipients: await recipientCount('donations'),
      });
    }
    return reply({ error: 'Method not allowed' }, 405);
  }

  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  if (!hasEnv('STRIPE_SECRET_KEY')) {
    console.error('missing_stripe_secret_key');
    return reply({ error: 'Webhook not configured' }, 503);
  }

  // --- Authenticate ---------------------------------------------------------
  // Raw text, not req.json(): the signature covers the exact bytes sent.

  const rawBody = await req.text();
  const secret = env('STRIPE_WEBHOOK_SECRET');

  if (secret) {
    const signature = req.headers.get('stripe-signature') ?? '';
    if (!(await verifySignature(rawBody, signature, secret))) {
      console.warn('webhook_signature_invalid');
      return reply({ error: 'Invalid signature' }, 400);
    }
  } else {
    console.warn('webhook_unverified_refetch_only');
  }

  let event: Obj;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return reply({ error: 'Invalid payload' }, 400);
  }

  const type = typeof event?.type === 'string' ? event.type : '';
  const objectId = typeof event?.data?.object?.id === 'string' ? event.data.object.id : '';
  if (!type || !objectId) return reply({ error: 'Invalid payload' }, 400);

  // Route by object kind, not by the specific event name. The re-fetched object
  // says what actually happened; the event name is only a hint about where to
  // look, and in the unsigned case it is not even trustworthy as that.
  let kind: keyof typeof ID_PREFIX | null = null;
  if (type.startsWith('checkout.session.')) kind = 'session';
  else if (type.startsWith('invoice.')) kind = 'invoice';
  else if (type.startsWith('customer.subscription.')) kind = 'subscription';

  if (!kind) {
    console.log('webhook_ignored', type);
    return reply({ received: true, ignored: type });
  }
  if (!objectId.startsWith(ID_PREFIX[kind])) {
    console.warn('webhook_id_kind_mismatch', type, objectId.slice(0, 12));
    return reply({ error: 'Invalid payload' }, 400);
  }

  // --- Re-fetch the object --------------------------------------------------
  // Everything written below comes from this response, never from the request.

  const fetched = await refetch(kind, objectId);
  if (!fetched.ok) {
    // A 404 means the id does not exist on this account: forged, or from
    // another account's endpoint pointed here by mistake. Either way, nothing
    // is written -- which also keeps junk out of the idempotency ledger.
    const status = fetched.status === 404 ? 400 : 502;
    console.warn('webhook_refetch_failed', type, fetched.status, fetched.error);
    return reply({ error: 'Could not verify event against Stripe' }, status);
  }
  const object = fetched.data;

  const db = serviceClient();

  // --- Idempotency ----------------------------------------------------------
  // Stripe delivers at least once. The primary key conflict is the guard. This
  // runs after the re-fetch so only events tied to a real object get recorded.

  const eventId = typeof event.id === 'string' && event.id ? event.id : `${type}:${objectId}`;
  const { error: ledgerError } = await db
    .from('stripe_events')
    .insert({ id: eventId, type });

  if (ledgerError) {
    if (ledgerError.code === '23505') {
      console.log('webhook_duplicate', eventId, type);
      return reply({ received: true, duplicate: true });
    }
    // Ledger unavailable: 500 so Stripe retries rather than risk double-applying.
    console.error('webhook_ledger_failed', ledgerError);
    return reply({ error: 'Could not record event' }, 500);
  }

  try {
    if (kind === 'session') await applySession(db, object);
    else if (kind === 'invoice') await handleInvoice(db, object);
    else await handleSubscription(db, object);
  } catch (error) {
    // Roll the ledger entry back so Stripe's retry is actually reprocessed.
    console.error('webhook_handler_threw', type, error);
    await db.from('stripe_events').delete().eq('id', eventId);
    return reply({ error: 'Handler failed' }, 500);
  }

  return reply({ received: true });
});

// --- Re-fetch ---------------------------------------------------------------

function refetch(kind: keyof typeof ID_PREFIX, objectId: string) {
  if (kind === 'session') {
    // latest_charge rides along so the donor's receipt link costs no extra call.
    return stripeRequest('GET', `/checkout/sessions/${objectId}`, {
      expand: ['payment_intent.latest_charge'],
    });
  }
  if (kind === 'invoice') return stripeRequest('GET', `/invoices/${objectId}`);
  return stripeRequest('GET', `/subscriptions/${objectId}`);
}

// --- Field extraction -------------------------------------------------------
//
// Stripe moves fields between API versions -- an invoice's subscription and
// payment intent both moved out from under `invoice` in later versions. Reads
// here are pinned by _shared/stripe.ts, so the flat form is what arrives; the
// nested fallbacks mean bumping that pin does not silently stop recording
// monthly renewals.

function invoiceSubscriptionId(invoice: Obj): string | null {
  return id(invoice.subscription) ??
    id(invoice.parent?.subscription_details?.subscription) ??
    id(invoice.lines?.data?.[0]?.subscription) ??
    null;
}

function invoicePaymentIntentId(invoice: Obj): string | null {
  return id(invoice.payment_intent) ??
    id(invoice.payments?.data?.[0]?.payment?.payment_intent) ??
    null;
}

// --- Handlers ---------------------------------------------------------------

async function handleInvoice(db: Db, invoice: Obj): Promise<void> {
  // The first invoice of a subscription is already covered by the checkout
  // session. Only later cycles create a new row.
  if (invoice.billing_reason !== 'subscription_cycle') {
    console.log('invoice_ignored', invoice.id, invoice.billing_reason);
    return;
  }
  if (invoice.status !== 'paid') {
    console.log('invoice_not_paid', invoice.id, invoice.status);
    return;
  }

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    console.warn('invoice_without_subscription', invoice.id);
    return;
  }

  // Inherit donor details from the original gift in this subscription. Not the
  // note: that was written about the first gift, not every one after it.
  const { data: original } = await db
    .from('donations')
    .select('donor_name, donor_email, donor_phone, donor_address, fund_designation, employer_match, metadata')
    .eq('stripe_subscription_id', subscriptionId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: renewal, error } = await db
    .from('donations')
    .insert({
      donor_name: original?.donor_name ?? invoice.customer_name ?? null,
      donor_email: original?.donor_email ?? invoice.customer_email ?? null,
      donor_phone: original?.donor_phone ?? invoice.customer_phone ?? null,
      donor_address: original?.donor_address ?? addressFrom(invoice.customer_address),
      amount_cents: invoice.amount_paid ?? null,
      currency: invoice.currency ?? 'usd',
      is_recurring: true,
      frequency: 'monthly',
      fund_designation: original?.fund_designation ?? 'general',
      employer_match: original?.employer_match ?? false,
      status: 'succeeded',
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: id(invoice.customer),
      stripe_payment_intent_id: invoicePaymentIntentId(invoice),
      receipt_url: invoice.hosted_invoice_url ?? null,
      source: 'website',
      metadata: { ...(original?.metadata ?? {}), renewal: true },
      updated_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) {
    // The unique index on stripe_invoice_id is the real exactly-once guard for
    // renewals: one invoice, one row, however many times Stripe delivers it.
    if (error.code === '23505') {
      console.log('renewal_already_recorded', invoice.id);
      return;
    }
    throw error;
  }

  await acknowledge(db, renewal, 'Monthly donation renewed');
}

/**
 * A cancelled subscription does not un-happen the gifts already given. Past rows
 * keep `status = 'succeeded'`; only the originating row is annotated, so a
 * lapsed monthly donor is visible without rewriting giving history.
 */
async function handleSubscription(db: Db, subscription: Obj): Promise<void> {
  if (subscription.status !== 'canceled') {
    console.log('subscription_ignored', subscription.id, subscription.status);
    return;
  }

  const { data: original, error: lookupError } = await db
    .from('donations')
    .select('id, metadata')
    .eq('stripe_subscription_id', subscription.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (!original) {
    console.log('subscription_cancelled_no_match', subscription.id);
    return;
  }

  const cancelledAt = subscription.canceled_at
    ? new Date(subscription.canceled_at * 1000).toISOString()
    : new Date().toISOString();

  const { error } = await db
    .from('donations')
    .update({
      metadata: {
        ...(original.metadata ?? {}),
        subscription_status: 'cancelled',
        subscription_cancelled_at: cancelledAt,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', original.id);

  if (error) throw error;
}
