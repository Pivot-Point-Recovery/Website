// Ask Stripe what actually happened to gifts we never got told about.
//
// The webhook is the live path and stays the only thing that needs to work. But
// a webhook is a delivery, and deliveries are lost: an endpoint registered
// against the wrong URL, a signing secret rotated in one place and not the
// other, an outage longer than Stripe's retry window. When that happens the
// donation sits at `pending` forever -- out of the board's totals, and with no
// thank-you sent to somebody who has already been charged.
//
// That is not hypothetical. Stripe disabled the site's first webhook endpoint
// after its deliveries kept failing, and every gift between 2026-08-20 and the
// replacement endpoint on 2026-09-25 stayed `pending` -- charged, absent from
// the dashboard, never receipted. This endpoint existed by then, but only a
// person could run it, and nobody did.
//
// So it now runs itself: pg_cron calls it every 15 minutes
// (20261006192000_reconcile_schedule.sql). It takes every unresolved gift, asks
// Stripe directly what became of its checkout session, and applies the answer
// through exactly the same code the webhook uses. Nothing is invented: a gift
// becomes `succeeded` only because Stripe said it was paid.
//
// Callers, and what each may do:
//
//   * The schedule, holding the token kept in Vault. Applies, and receipts a
//     recovered gift only while it is fresh (RECEIPT_WINDOW_HOURS). Anything
//     older is recorded and left for a person -- a receipt weeks late is a
//     judgement call, not a side effect -- and staff get one email saying so.
//   * Finance, with their own Board Center session. Dry run by default; apply
//     and acknowledge only when asked. Also `send_receipt` for one gift.
//
// Safe to run repeatedly: `acknowledge` is guarded by `receipt_sent_at` and
// `notified`, so a donor who has already been thanked is not thanked again.

import { serviceClient } from '../_shared/db.ts';
import { env, hasEnv, healthReport } from '../_shared/env.ts';
import { stripeRequest } from '../_shared/stripe.ts';
import { applySession, type Obj, sendReceipt, sessionOutcome } from '../_shared/donations.ts';
import { recipientCount, sendNotification } from '../_shared/notify.ts';
import { fail, json, preflight } from '../_shared/http.ts';
import { money, str } from '../_shared/validate.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const REQUIRED_SECRETS = ['STRIPE_SECRET_KEY'];
const MAX_BATCH = 200;

// A scheduled run leaves alone anything younger than this: the webhook
// normally settles a gift within seconds, and the donor may still be on
// Stripe's page.
const SETTLE_MINUTES = 10;

// How old a gift may be and still get its receipt automatically when the
// schedule finds it. Inside this, the donor is still expecting one.
const RECEIPT_WINDOW_HOURS = 72;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Caller = 'schedule' | 'finance';

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

/** The scheduled job's token is compared inside the database, against the
 *  copy in Vault, so it exists in exactly one place and this function never
 *  holds it. */
async function scheduleTokenMatches(token: string): Promise<boolean> {
  if (!token) return false;
  const { data, error } = await serviceClient().rpc('reconcile_token_matches', { token });
  if (error) {
    console.error('reconcile_token_check_failed', error);
    return false;
  }
  return data === true;
}

async function identify(req: Request): Promise<Caller | null> {
  const token = req.headers.get('x-reconcile-token') ?? '';
  if (token) return (await scheduleTokenMatches(token)) ? 'schedule' : null;
  return (await callerHandlesMoney(req.headers.get('Authorization') ?? '')) ? 'finance' : null;
}

interface Line {
  id: string;
  donor_email: string | null;
  amount_cents: number | null;
  created_at: string;
  was: string;
  now: string;
  receipt: 'sent' | 'would send' | 'already sent' | 'no email' | 'held for review' | 'not applicable';
  note?: string;
}

function hoursSince(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 3_600_000;
}

/** One gift's receipt, on request from the Board Center. */
async function handleSendReceipt(req: Request, body: Obj): Promise<Response> {
  const donationId = str(body?.donation_id, 64);
  if (!UUID.test(donationId)) return fail(req, 'Missing gift.');

  const db = serviceClient();
  const { data: gift, error } = await db.from('donations').select('*').eq('id', donationId).maybeSingle();
  if (error) {
    console.error('receipt_lookup_failed', error);
    return fail(req, 'Could not read that gift.', 500);
  }
  if (!gift) return fail(req, 'No such gift.', 404);
  if (gift.status !== 'succeeded') return fail(req, 'Only a completed gift gets a receipt.', 409);
  // Sending twice is allowed -- a donor who lost theirs asks -- but only on
  // purpose. The Board Center asks before it passes `again`.
  if (gift.receipt_sent_at && body?.again !== true) {
    return fail(req, 'A receipt was already sent for this gift.', 409);
  }

  const result = await sendReceipt(db, gift);
  if (!result.notified) {
    console.warn('receipt_not_sent', donationId, result.reason);
    return fail(req, `The receipt did not send: ${result.reason ?? 'unknown reason'}.`, 502);
  }
  return json(req, { ok: true, sent: true });
}

/** After a scheduled run, one email covering every gift it recorded without
 *  thanking -- so a late recovery is noticed, and the receipts get decided. */
async function reportHeld(held: Line[]): Promise<void> {
  if (held.length === 0) return;
  const total = held.reduce((sum, line) => sum + (line.amount_cents ?? 0), 0);
  const site = env('SITE_URL', 'https://pivotpointrecovery.org').replace(/\/+$/, '');
  const result = await sendNotification(
    `${held.length} ${held.length === 1 ? 'gift' : 'gifts'} recovered from Stripe — receipts not sent`,
    [
      ['Gifts', String(held.length)],
      ['Total', money(total)],
      ['Oldest', held.map((line) => line.created_at).sort()[0].slice(0, 10)],
    ],
    {
      intro: `Stripe took ${held.length === 1 ? 'this gift' : 'these gifts'} but the website was never ` +
        `told, so ${held.length === 1 ? 'it was' : 'they were'} missing from the dashboard until now. ` +
        `They are recorded. Their donors have not been sent a receipt, because they are more than ` +
        `${RECEIPT_WINDOW_HOURS / 24} days old — open each one under Giving to send it.`,
      links: [['Open Giving in the Board Center', `${site}/admin`]],
      audience: 'donations',
    },
  );
  if (!result.notified) console.warn('reconcile_report_not_sent', result.reason);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return json(req, {
        service: 'donations-reconcile',
        ...healthReport(REQUIRED_SECRETS),
        // Count only, never the addresses.
        recipients: await recipientCount('donations'),
      });
    }
    return fail(req, 'Method not allowed', 405);
  }
  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);
  if (!hasEnv('STRIPE_SECRET_KEY')) return fail(req, 'Stripe is not configured', 503);

  const caller = await identify(req);
  if (!caller) return fail(req, 'You do not have access to reconcile donations.', 403);

  const body = await req.json().catch(() => ({}));
  if (body?.action === 'send_receipt') return await handleSendReceipt(req, body);

  const scheduled = caller === 'schedule';
  // Opt in, not out. A missing or malformed body reconciles nothing -- except
  // for the schedule, which exists to apply.
  const apply = scheduled || body?.apply === true;
  // Thanking is the default once applying; `acknowledge: false` records only.
  const acknowledge = body?.acknowledge !== false;
  const limit = Math.min(Number(body?.limit) || 50, MAX_BATCH);

  const db = serviceClient();

  let query = db
    .from('donations')
    .select('id, donor_email, donor_name, amount_cents, created_at, status, stripe_session_id, receipt_sent_at')
    .in('status', ['pending', 'processing'])
    .not('stripe_session_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (scheduled) {
    query = query.lt('created_at', new Date(Date.now() - SETTLE_MINUTES * 60_000).toISOString());
  }
  const { data: stuck, error } = await query;

  if (error) {
    console.error('reconcile_query_failed', error);
    return fail(req, 'Could not read the donations table.', 500);
  }

  const lines: Line[] = [];
  const held: Line[] = [];
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
    const thank = acknowledge && (!scheduled || hoursSince(row.created_at) <= RECEIPT_WINDOW_HOURS);

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
        : !thank
        ? 'held for review'
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
        await applySession(db, session, { acknowledge: thank });
        changed += 1;
        if (line.receipt === 'sent') receipts += 1;
        if (line.receipt === 'held for review') held.push(line);
      } catch (err) {
        console.error('reconcile_apply_failed', row.id, err);
        line.now = row.status;
        line.receipt = 'not applicable';
        line.note = 'Could not be written — left untouched';
      }
    }
    lines.push(line);
  }

  if (scheduled) await reportHeld(held);

  const wouldChange = lines.filter((l) => l.was !== l.now).length;
  if (scheduled && (changed > 0 || lines.length > 0)) {
    console.log('reconcile_scheduled', { examined: lines.length, changed, receipts, held: held.length });
  }

  return json(req, {
    ok: true,
    mode: apply ? 'applied' : 'dry run — nothing was written and no email was sent',
    caller,
    examined: lines.length,
    changed: apply ? changed : 0,
    would_change: apply ? undefined : wouldChange,
    receipts_sent: apply ? receipts : 0,
    receipts_pending: apply ? 0 : lines.filter((l) => l.receipt === 'would send').length,
    receipts_held: held.length,
    // Counts only for the schedule: pg_net keeps every response body in
    // net._http_response for hours, and donor addresses do not belong there.
    ...(scheduled ? {} : { gifts: lines }),
  });
});
