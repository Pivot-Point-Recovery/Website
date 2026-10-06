// Google Form intake -> Board Center queue + staff notification.
//
// The intake form is a Google Form on purpose: what somebody tells us there is
// protected under 42 CFR Part 2 and stays in Google, never in this database
// (README, "Intake, and the 42 CFR Part 2 boundary"). The cost was that a
// completed intake reached none of the machinery behind the website's own
// forms. Google itself emails only the editors who have each switched on its
// per-person "new responses" setting, so an intake could arrive and tell
// nobody -- and the Board Center queue stayed empty unless someone noticed and
// typed a reference in by hand.
//
// An Apps Script on the form (apps-script/intake-form/Code.gs) now calls this
// on every submission with the response's id and timestamp, and that is all
// that crosses. This function puts a reference on intake_queue that links back
// to the response in Google Forms, and emails the same standing list as every
// other form: notification_recipients unioned with NOTIFICATION_EMAILS.
//
// Server to server, so there is no browser, no Origin and no CORS. verify_jwt
// is off because Apps Script holds no Supabase JWT; the caller proves itself
// with a shared secret instead, and with none configured this refuses
// everything.

import { serviceClient } from '../_shared/db.ts';
import { env, healthReport } from '../_shared/env.ts';
import { recipientCount, sendNotification } from '../_shared/notify.ts';
import { str } from '../_shared/validate.ts';

const REQUIRED_SECRETS = ['INTAKE_WEBHOOK_SECRET', 'RESEND_API_KEY'];
const OPTIONAL_SECRETS = ['NOTIFICATION_EMAILS', 'RESEND_FROM', 'NOTIFICATION_PREFIX', 'SITE_URL'];

const TIME_ZONE = 'America/New_York';

// /contact and the form's own confirmation page both promise a reply within
// 1-2 business days. The far end of that is when the queue calls it overdue.
const FOLLOW_UP_BUSINESS_DAYS = 2;

// Drive file ids: letters, digits, underscore, hyphen.
const FORM_ID = /^[A-Za-z0-9_-]{10,200}$/;
// Forms response ids are opaque. The ones seen so far are base64url, but
// nothing here depends on that -- refusing an id would push every intake onto
// the fallback path -- so anything printable is accepted and URL-encoded.
const RESPONSE_ID = /^[\x21-\x7E]{6,300}$/;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Compares digests rather than the strings, so neither the length of the
 *  secret nor the position of the first wrong character shows in the timing. */
async function secretMatches(presented: string, expected: string): Promise<boolean> {
  if (!presented || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** When Google recorded the response. Anything unreadable, or more than a few
 *  minutes ahead of our clock, becomes "now" rather than an intake filed in
 *  the future. */
function submittedAt(value: unknown): Date {
  const parsed = new Date(str(value, 40));
  const now = Date.now();
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now + 5 * 60_000) return new Date(now);
  return parsed;
}

/** YYYY-MM-DD of the day `when` falls on in New York -- the organisation's
 *  calendar, not the server's UTC one. */
function newYorkDate(when: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when);
}

/** `days` working days after a YYYY-MM-DD date. Weekends are skipped; public
 *  holidays are not known here, so a Monday holiday reads one day early. */
function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  for (let added = 0; added < days;) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) added++;
  }
  return date.toISOString().slice(0, 10);
}

/** "Mon, Oct 5, 2026, 3:53 PM EDT" */
function formatMoment(when: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(when);
}

/** "Wednesday, October 7" for a YYYY-MM-DD date. */
function formatDay(isoDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

/**
 * INT-20261005-7F3A9C: the New York date it arrived, then the leading hex
 * digits of a hash of Google's response id. Derived rather than stored, so the
 * same submission always maps to the same reference and a re-delivery finds
 * the row it already made. No part of it comes from anything the person wrote.
 */
async function referenceFor(responseId: string, day: string, digits: number): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(responseId));
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `INT-${day.replaceAll('-', '')}-${hex.slice(0, digits)}`;
}

/** The response itself, in the Forms editor. It opens only for people the form
 *  is shared with; anyone else gets Google's sign-in wall, not the answers. */
function responseUrl(formId: string, responseId: string): string {
  return `https://docs.google.com/forms/d/${formId}/edit#response=${encodeURIComponent(responseId)}`;
}

type Db = ReturnType<typeof serviceClient>;

interface QueueEntry {
  /** Null when the row could not be written. Staff are still told. */
  id: string | null;
  ref: string;
  notified: boolean;
  duplicate: boolean;
}

/**
 * Adds the intake to the queue, or finds the row an earlier delivery of the
 * same response already made.
 *
 * Six hex digits keep the reference short enough to read off a phone. A
 * different response hashing to the same six on the same day is told apart by
 * its source_url and falls through to twelve, rather than being mistaken for a
 * re-delivery and dropped.
 */
async function queueEntry(
  db: Db,
  intake: { responseId: string; day: string; received: Date; followUpDue: string; sourceUrl: string },
): Promise<QueueEntry> {
  let ref = '';
  for (const digits of [6, 12]) {
    ref = await referenceFor(intake.responseId, intake.day, digits);

    const { data, error } = await db
      .from('intake_queue')
      .insert({
        ref,
        received_at: intake.received.toISOString(),
        follow_up_due: intake.followUpDue,
        source_url: intake.sourceUrl,
        created_by: 'intake form',
      })
      .select('id')
      .single();

    if (!error) return { id: data.id, ref, notified: false, duplicate: false };

    // Anything but a unique violation is the database failing, not a repeat.
    if (error.code !== '23505') {
      console.error('intake_queue_insert_failed', error);
      return { id: null, ref, notified: false, duplicate: false };
    }

    const { data: existing, error: lookupError } = await db
      .from('intake_queue')
      .select('id, notified, source_url')
      .eq('ref', ref)
      .maybeSingle();

    if (lookupError) {
      console.error('intake_queue_lookup_failed', lookupError);
      return { id: null, ref, notified: false, duplicate: false };
    }
    if (existing && existing.source_url === intake.sourceUrl) {
      return { id: existing.id, ref, notified: Boolean(existing.notified), duplicate: true };
    }
  }

  console.error('intake_queue_ref_exhausted', ref);
  return { id: null, ref, notified: false, duplicate: false };
}

async function handleIntake(payload: Record<string, unknown>, formId: string): Promise<Response> {
  const responseId = str(payload.response_id, 300);
  if (!RESPONSE_ID.test(responseId)) {
    return reply({ ok: false, error: 'Missing or malformed response_id' }, 400);
  }

  const received = submittedAt(payload.submitted_at);
  const day = newYorkDate(received);
  const followUpDue = addBusinessDays(day, FOLLOW_UP_BUSINESS_DAYS);
  const sourceUrl = responseUrl(formId, responseId);
  const db = serviceClient();

  const entry = await queueEntry(db, { responseId, day, received, followUpDue, sourceUrl });

  // Delivered twice and staff were already told the first time.
  if (entry.notified) {
    return reply({ ok: true, ref: entry.ref, duplicate: true, queued: true, notified: true });
  }

  const site = env('SITE_URL', 'https://pivotpointrecovery.org').replace(/\/+$/, '');
  const rows: Array<[string, string]> = [
    ['Reference', entry.ref],
    ['Received', formatMoment(received)],
    ['Follow up by', formatDay(followUpDue)],
  ];
  if (!entry.id) {
    // The email matters more than the queue row, so a database failure does
    // not stop it -- it just says where the gap is.
    rows.push(['Board Center', 'Could not be added to the intake queue automatically. Add this reference by hand.']);
  }

  const result = await sendNotification(`New intake: ${entry.ref}`, rows, {
    intro: 'Someone completed the intake form on the website. Their answers stay in Google Forms, ' +
      'protected under 42 CFR Part 2, so none of them are in this email.',
    links: [
      ['Open in Google Forms', sourceUrl],
      ['Board Center', `${site}/admin`],
    ],
  });

  if (result.notified && entry.id) {
    const { error } = await db.from('intake_queue').update({ notified: true }).eq('id', entry.id);
    if (error) console.error('intake_notified_flag_failed', error);
  }
  if (!result.notified) console.warn('intake_not_notified', entry.ref, result.reason);

  return reply({
    ok: true,
    ref: entry.ref,
    duplicate: entry.duplicate,
    queued: entry.id !== null,
    notified: result.notified,
    // The caller is authenticated, and the reasons are configuration states
    // ("RESEND_API_KEY not set"), not secrets. The script's fallback email
    // quotes it so whoever reads it knows where to look.
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

/** A real email to the real list, and no queue row. What setup ends with, so
 *  the person installing the script sees the whole path work. */
async function handleTest(formId: string): Promise<Response> {
  const result = await sendNotification(
    'Test: intake notifications are connected',
    [['Sent', formatMoment(new Date())]],
    {
      intro: 'This is a test from the intake form. When someone completes it, an email like this ' +
        'goes to everyone on this list with a reference number, a follow-up date and a link to ' +
        'their answers — never the answers themselves.',
      links: [['Open the form’s responses', `https://docs.google.com/forms/d/${formId}/edit#responses`]],
    },
  );

  return reply({
    ok: true,
    test: true,
    notified: result.notified,
    // A count, never the addresses.
    recipients: await recipientCount('forms'),
    ...(result.reason ? { reason: result.reason } : {}),
  });
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    if (new URL(req.url).searchParams.has('health')) {
      return reply({
        service: 'intake-webhook',
        ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS),
        // Count only, never the addresses.
        recipients: await recipientCount('forms'),
      });
    }
    return reply({ ok: false, error: 'Method not allowed' }, 405);
  }

  if (req.method !== 'POST') return reply({ ok: false, error: 'Method not allowed' }, 405);

  const expected = env('INTAKE_WEBHOOK_SECRET');
  if (!expected) {
    // Fail closed. The script falls back to Google's own mail on any refusal,
    // so no intake goes unannounced -- whereas accepting unauthenticated
    // writes to the queue would let anyone fill it.
    console.error('intake_webhook_secret_unset');
    return reply({ ok: false, error: 'INTAKE_WEBHOOK_SECRET is not set on the project' }, 503);
  }
  if (!(await secretMatches(req.headers.get('x-intake-secret') ?? '', expected))) {
    console.warn('intake_webhook_bad_secret');
    return reply({ ok: false, error: 'Unauthorized' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return reply({ ok: false, error: 'Invalid request body' }, 400);
  }
  if (!payload || typeof payload !== 'object') {
    return reply({ ok: false, error: 'Invalid request body' }, 400);
  }

  const formId = str(payload.form_id, 200);
  if (!FORM_ID.test(formId)) return reply({ ok: false, error: 'Missing or malformed form_id' }, 400);

  if (payload.test === true) return await handleTest(formId);
  return await handleIntake(payload, formId);
});
