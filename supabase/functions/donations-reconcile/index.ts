// Ask Stripe what actually happened to gifts we never got told about.
//
// The webhook is the live path and stays the only thing that needs to work. But
// a webhook is a delivery, and deliveries are lost: an endpoint registered
// against the wrong URL, a signing secret rotated in one place and not the
// other, an outage longer than Stripe's retry window. When that happens the
// donation sits at `pending` forever -- out of the board's totals, and with no
// thank-you sent to somebody who has already been charged.
//
// This endpoint closes that gap. It takes every unresolved gift, asks Stripe
// directly what became of its checkout session, and applies the answer through
// exactly the same code the webhook uses. Nothing is invented: a gift becomes
// `succeeded` only because Stripe said it was paid.
//
// Two things make it safe to run repeatedly:
//
//   * `acknowledge` is guarded by `receipt_sent_at` and `notified`, so a donor
//     who has already been thanked is not thanked again.
//   * A dry run is the DEFAULT. Nothing is written and no email is sent unless
//     the caller explicitly passes apply: true. Sending a month of backdated
//     receipts is not something that should be one stray request away.

import { serviceClient } from '../_shared/db.ts';
import { hasEnv, healthReport } from '../_shared/env.ts';
import { stripeRequest } from '../_shared/stripe.ts';
import { applySession, type Obj, sessionOutcome } from '../_shared/donations.ts';
import { fail, json, preflight } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY'];
const MAX_BATCH = 200;

/** The database decides, using the caller's own token -- never this function.
 *  Reconciling moves money into the board's reported totals and sends mail to
 *  donors, so it is held to the finance role rather than to membership. */
async function callerHandlesMoney(authHeader: string): Promise<boolean> {
  if (!authHeader) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_role`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ wanted: 'finance' }),
  });
  if (!res.ok) return false;
  return (await res.json().catch(() => false)) === true;
}

interface Line {
  id: string;
  donor_email: string | null;
  amount_cents: number | null;
  created_at: string;
  was: string;
  now: string;
  receipt: 'sent' | 'would send' | 'already sent' | 'no email' | 'not applicable';
  note?: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return json(req, { service: 'donations-reconcile', ...healthReport(REQUIRED_SECRETS) });
    }
    return fail(req, 'Method not allowed', 405);
  }
  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);
  if (!hasEnv('STRIPE_SECRET_KEY')) return fail(req, 'Stripe is not configured', 503);

  if (!(await callerHandlesMoney(req.headers.get('Authorization') ?? ''))) {
    return fail(req, 'You do not have access to reconcile donations.', 403);
  }

  const body = await req.json().catch(() => ({}));
  // Opt in, not out. A missing or malformed body reconciles nothing.
  const apply = body?.apply === true;
  const limit = Math.min(Number(body?.limit) || 50, MAX_BATCH);

  const db = serviceClient();

  const { data: stuck, error } = await db
    .from('donations')
    .select('id, donor_email, donor_name, amount_cents, created_at, status, stripe_session_id, receipt_sent_at')
    .in('status', ['pending', 'processing'])
    .not('stripe_session_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('reconcile_query_failed', error);
    return fail(req, 'Could not read the donations table.', 500);
  }

  const lines: Line[] = [];
  let changed = 0;
  let receipts = 0;

  for (const row of stuck ?? []) {
    const fetched = await stripeRequest('GET', `/checkout/sessions/${row.stripe_session_id}`, {
      expand: ['payment_intent.latest_charge'],
    });

    if (!fetched.ok) {
      lines.push({
        id: row.id,
        donor_email: row.donor_email,
        amount_cents: row.amount_cents,
        created_at: row.created_at,
        was: row.status,
        now: row.status,
        receipt: 'not applicable',
        // A 404 here means the session is not on the account this key belongs
        // to -- almost always live-vs-test mode, which is worth saying plainly
        // rather than reporting as a generic failure.
        note: fetched.status === 404
          ? 'Stripe does not know this session — check the key is for the same mode (live/test) the gift was taken in'
          : `Stripe said ${fetched.status}: ${fetched.error ?? 'unknown error'}`,
      });
      continue;
    }

    const session: Obj = fetched.data;
    const outcome = sessionOutcome(session);
    const next = outcome === 'succeeded' ? 'succeeded' : outcome;
    const alreadyThanked = Boolean((row as Obj).receipt_sent_at);

    const line: Line = {
      id: row.id,
      donor_email: session.customer_details?.email ?? row.donor_email,
      amount_cents: session.amount_total ?? row.amount_cents,
      created_at: row.created_at,
      was: row.status,
      now: next,
      receipt: outcome !== 'succeeded'
        ? 'not applicable'
        : alreadyThanked
        ? 'already sent'
        : !(session.customer_details?.email ?? row.donor_email)
        ? 'no email'
        : apply
        ? 'sent'
        : 'would send',
    };

    if (outcome === 'open') {
      line.now = row.status;
      line.note = 'Still open on Stripe — the donor never completed the payment';
      lines.push(line);
      continue;
    }

    if (apply) {
      try {
        await applySession(db, session);
        changed += 1;
        if (line.receipt === 'sent') receipts += 1;
      } catch (err) {
        console.error('reconcile_apply_failed', row.id, err);
        line.now = row.status;
        line.receipt = 'not applicable';
        line.note = 'Could not be written — left untouched';
      }
    }
    lines.push(line);
  }

  const wouldChange = lines.filter((l) => l.was !== l.now).length;

  return json(req, {
    ok: true,
    mode: apply ? 'applied' : 'dry run — nothing was written and no email was sent',
    examined: lines.length,
    changed: apply ? changed : 0,
    would_change: apply ? undefined : wouldChange,
    receipts_sent: apply ? receipts : 0,
    receipts_pending: apply ? 0 : lines.filter((l) => l.receipt === 'would send').length,
    gifts: lines,
  });
});
