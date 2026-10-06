// Donation checkout.
//
// Replaces the portal's /api/donations/checkout, which answered 405 from this
// origin -- the donate page has had no working backend since the site moved to
// standalone Cloudflare Pages. With this function the website owns its own
// giving path and needs nothing else mounted on the same host.
//
// Records a pending donation, opens a Stripe Checkout session, and hands back
// the URL to redirect to. The row is written *before* Stripe is called so every
// attempt is attributable even if Stripe errors; the webhook later promotes the
// row to succeeded. Card data never touches our infrastructure.
//
// Deliberately carries no participant identifiers into Stripe metadata. Donors
// and program participants are separate populations and must stay that way.

import { fail, json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/db.ts';
import { env, envNamesMatching, healthReport } from '../_shared/env.ts';
import { bool, email as parseEmail, str } from '../_shared/validate.ts';
import { stripeRequest } from '../_shared/stripe.ts';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY'];
const OPTIONAL_SECRETS = ['STRIPE_WEBHOOK_SECRET', 'SITE_URL', 'ALLOWED_ORIGINS'];

// Stripe's own floor is $0.50. $5 is ours -- below it, card fees eat the gift.
// donate.html enforces the same floor client-side; keep the two in step.
const MIN_CENTS = 500;
// Above this, a card is the wrong instrument. Route to a conversation instead.
const MAX_CENTS = 5_000_000;

// The note box on donate.html carries the same maxlength.
const NOTE_MAX = 500;

// Mirrors the <select id="fund"> options on donate.html. Unknown slugs fall
// back to general support rather than rejecting an otherwise valid gift.
const FUNDS: Record<string, string> = {
  '': 'Where it’s needed most',
  'peer-support': 'Peer Recovery Support',
  'reentry': 'Reentry & Reintegration',
  'veteran-mentorship': 'Veteran Mentorship',
  'family-community': 'Family & Community',
};

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      const report = healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS);
      return json(req, {
        service: 'donations-checkout',
        ...report,
        // Surfaces a test key left in production without exposing the key.
        mode: env('STRIPE_SECRET_KEY').startsWith('sk_live_')
          ? 'live'
          : env('STRIPE_SECRET_KEY')
          ? 'test'
          : 'unset',
        // Diagnostic: which Stripe-ish env var NAMES exist on this project.
        // Names only -- never values. Distinguishes "secret not set at all"
        // from "secret set under a name this code does not look for".
        stripe_env_names: envNamesMatching(/stripe|whsec/i),
        min_gift_cents: MIN_CENTS,
        max_gift_cents: MAX_CENTS,
      });
    }
    return fail(req, 'Method not allowed', 405);
  }

  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return fail(req, 'Invalid request body');
  }

  // Honeypot. Report success and send the bot back to the front page, so it
  // gets no signal to adapt to.
  if (str(payload._honeypot, 200)) {
    console.log('honeypot_triggered');
    return json(req, { ok: true, url: env('SITE_URL', 'https://pivotpointrecovery.org') });
  }

  // --- Validate -------------------------------------------------------------
  // The client's amount is a suggestion. What is chargeable is decided here.

  const rawAmount = typeof payload.amount === 'string'
    ? Number(payload.amount.replace(/[$,\s]/g, ''))
    : Number(payload.amount);

  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    return fail(req, 'Please enter a donation amount greater than zero.');
  }

  const cents = Math.round(rawAmount * 100);
  if (cents < MIN_CENTS) return fail(req, 'The minimum online gift is $5.');
  if (cents > MAX_CENTS) {
    return fail(req, 'For gifts above $50,000, please contact us directly so we can arrange the transfer.');
  }

  const donorName = str(payload.donor_name, 200);
  const donorEmail = parseEmail(payload.donor_email);
  if (!donorName) return fail(req, 'Please enter your name.');
  if (!donorEmail) return fail(req, 'Please enter a valid email address.');

  const fundSlug = str(payload.fund_designation, 60);
  const fundLabel = FUNDS[fundSlug] ?? FUNDS[''];
  const isRecurring = bool(payload.is_recurring);
  const employerMatch = bool(payload.employer_match);
  // Both optional, both ours: neither is sent to Stripe. A note is free text --
  // "in memory of my brother" can name somebody we serve -- and Stripe metadata
  // carries donor-scoped facts only (see the note on `metadata` below).
  const donorPhone = str(payload.donor_phone, 40);
  const donorNote = str(payload.donor_note, NOTE_MAX);

  // --- Record the attempt ---------------------------------------------------

  const db = serviceClient();

  const { data: donation, error: insertError } = await db
    .from('donations')
    .insert({
      donor_name: donorName,
      donor_email: donorEmail,
      donor_phone: donorPhone || null,
      donor_note: donorNote || null,
      amount_cents: cents,
      currency: 'usd',
      is_recurring: isRecurring,
      frequency: isRecurring ? 'monthly' : 'one-time',
      fund_designation: fundSlug || 'general',
      employer_match: employerMatch,
      status: 'pending',
      source: 'website',
      metadata: { fund_label: fundLabel },
    })
    .select('id')
    .single();

  if (insertError || !donation) {
    console.error('donation_insert_failed', insertError);
    return fail(req, 'We could not start your donation. Please try again.', 500);
  }

  // --- Open Checkout --------------------------------------------------------

  const siteUrl = env('SITE_URL', 'https://pivotpointrecovery.org').replace(/\/$/, '');
  const productName = isRecurring
    ? `Monthly donation — ${fundLabel}`
    : `Donation — ${fundLabel}`;

  // Donor-scoped only. No participant or constituent identifiers, ever.
  const metadata = {
    donation_id: donation.id,
    fund_designation: fundSlug || 'general',
    fund_label: fundLabel,
    employer_match: String(employerMatch),
    source: 'website',
  };

  const session: Record<string, unknown> = {
    mode: isRecurring ? 'subscription' : 'payment',
    success_url: `${siteUrl}/donate?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/donate?status=cancelled`,
    customer_email: donorEmail,
    client_reference_id: donation.id,
    // A full mailing address, not just the postcode a card check needs: it is
    // where a thank-you letter or a year-end giving statement goes. Stripe
    // shows it on its own page and the webhook copies it to donor_address.
    billing_address_collection: 'required',
    // Renders a "Donate" button rather than "Pay". Payment mode only.
    submit_type: isRecurring ? undefined : 'donate',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: cents,
        product_data: { name: productName },
        ...(isRecurring ? { recurring: { interval: 'month' } } : {}),
      },
    }],
    metadata,
    // Metadata has to be attached to the durable object too, not just the
    // session -- the session is gone by the time renewals bill.
    ...(isRecurring
      ? { subscription_data: { metadata } }
      : { payment_intent_data: { metadata, description: productName } }),
  };

  // The donation row id doubles as the idempotency key: a retried submit that
  // reuses it can never double-charge.
  const result = await stripeRequest('POST', '/checkout/sessions', session, donation.id);

  if (!result.ok || !result.data?.url) {
    console.error('checkout_session_failed', result.error);
    await db
      .from('donations')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', donation.id);
    return fail(req, 'We could not reach our payment processor. Please try again in a moment.', 502);
  }

  await db
    .from('donations')
    .update({
      stripe_session_id: result.data.id,
      stripe_customer_id: typeof result.data.customer === 'string' ? result.data.customer : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', donation.id);

  return json(req, { ok: true, url: result.data.url, donation_id: donation.id });
});
