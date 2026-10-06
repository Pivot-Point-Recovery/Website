// The Monday email: what came in last week, and what is waiting on somebody.
//
// The Board Center shows all of this -- to whoever opens it. By October every
// enquiry sent through the contact form since August still read "New" there,
// so once a week the list now goes to the people who work it.
//
// Callers, and what each may do:
//
//   * The schedule (pg_cron, Mondays -- 20261006220000_board_digest_schedule.sql),
//     presenting the scheduler's token from Vault: the same one
//     donations-reconcile checks. Sends to the staff notification lists.
//     pg_cron runs in UTC, so it calls at 12:50 and at 13:50 UTC and this sends
//     only on the call that lands at 8 o'clock in New York, whichever side of
//     daylight saving it is.
//   * An administrator, from the Board Center: `{ preview: true }` sends this
//     week's summary to that administrator alone, straight away.
//   * Either: `{ dry_run: true }` returns the email instead of sending it. The
//     token holder may also give `{ preview_to }` (one address, the version
//     without donors unless `{ variant: 'full' }`) or `{ force }` (send to the
//     lists now, whatever the hour).
//
// Who sees what. Everybody gets the enquiries, volunteers, intake references,
// events and giving totals -- the same people already get each enquiry and
// sign-up by email as it arrives. Each gift, with the donor's name, goes only
// to the donations list, who already get every gift by email; anybody on the
// forms list alone gets the totals. Never in it: what anybody wrote, a donor's
// note or contact details, or an intake answer.

import { serviceClient } from '../_shared/db.ts';
import { env, healthReport } from '../_shared/env.ts';
import { fail, json, preflight } from '../_shared/http.ts';
import { recipientList, sendStaffHtml } from '../_shared/notify.ts';
import { email as parseEmail, escapeHtml, money } from '../_shared/validate.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const REQUIRED_SECRETS = ['RESEND_API_KEY'];
const TIME_ZONE = 'America/New_York';
const SEND_HOUR = 8;
const LIST_MAX = 12;
const DAY_MS = 86_400_000;
// A gift still waiting on Stripe after this long means the 15-minute check
// against Stripe has stopped -- the dashboard raises the same alarm.
const STUCK_HOURS = 26;

const NAVY = '#1a2b4a';

// The contact form's "I'm reaching out about" values, as people say them.
const ABOUT: Record<string, string> = {
  'recovery-support': 'recovery support',
  'veteran-mentorship': 'veteran mentorship',
  volunteer: 'volunteering',
  donate: 'giving',
  partner: 'a partnership',
  general: 'a general question',
};

// The volunteer form's choices, as the form words them.
const INTERESTS: Record<string, string> = {
  'peer-support': 'peer recovery support',
  mentoring: 'mentoring',
  events: 'events & outreach',
  reentry: 'reentry & reintegration',
  admin: 'administrative support',
  fundraising: 'fundraising',
  other: 'something else',
};
const AVAILABILITY: Record<string, string> = {
  weekdays: 'weekdays',
  weekends: 'weekends',
  evenings: 'evenings',
  flexible: 'flexible hours',
};

// The funds on /donate; older gifts carry only the slug.
const FUNDS: Record<string, string> = {
  general: 'where it’s needed most',
  'peer-support': 'Peer Recovery Support',
  reentry: 'Reentry & Reintegration',
  'veteran-mentorship': 'Veteran Mentorship',
  'family-community': 'Family & Community',
};

type Row = Record<string, unknown>;
type Caller = { kind: 'schedule' } | { kind: 'admin'; email: string; finance: boolean };
type Variant = 'full' | 'summary';

// ---------------------------------------------------------------- callers

/** The scheduler's token is compared inside the database, against the copy in
 *  Vault, so it exists in one place and this function never holds it. */
async function scheduleTokenMatches(token: string): Promise<boolean> {
  if (!token) return false;
  const { data, error } = await serviceClient().rpc('reconcile_token_matches', { token });
  if (error) {
    console.error('schedule_token_check_failed', error);
    return false;
  }
  return data === true;
}

/** What the database says this session may do -- never what the token says. */
async function hasRole(headers: Record<string, string>, wanted: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_role`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ wanted }),
  });
  return res.ok && (await res.json().catch(() => false)) === true;
}

/** An administrator's own session. Returns their address -- where a preview
 *  goes -- and whether they may see donors. */
async function administrator(authHeader: string): Promise<{ email: string; finance: boolean } | null> {
  if (!authHeader) return null;
  const headers = { apikey: ANON_KEY, Authorization: authHeader, 'Content-Type': 'application/json' };
  if (!(await hasRole(headers, 'admin'))) return null;
  const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers });
  if (!user.ok) return null;
  const email = parseEmail((await user.json().catch(() => ({})))?.email);
  if (!email) return null;
  return { email, finance: await hasRole(headers, 'finance') };
}

async function identify(req: Request): Promise<Caller | null> {
  const token = req.headers.get('x-schedule-token') ?? '';
  if (token) return (await scheduleTokenMatches(token)) ? { kind: 'schedule' } : null;
  const admin = await administrator(req.headers.get('Authorization') ?? '');
  return admin ? { kind: 'admin', ...admin } : null;
}

// ------------------------------------------------------------------- time

/** New York's date (YYYY-MM-DD) and hour, now. */
function newYorkNow(at = new Date()): { date: string; hour: number } {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) parts[part.type] = part.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Mon, Oct 12" for a YYYY-MM-DD date. */
function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}

/** "Mon, Oct 12" for a moment, in New York. */
function dayOf(iso: unknown): string {
  return new Date(String(iso)).toLocaleDateString('en-US', {
    timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric',
  });
}

function waited(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
  return days < 1 ? 'less than a day' : days === 1 ? '1 day' : `${days} days`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fullName(...parts: unknown[]): string {
  return parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(' ') || 'No name given';
}

// ----------------------------------------------------------------- layout

/** One block of the email. `items` are plain text and escaped here. */
function section(title: string, lead: string, items: string[] = []): string {
  const shown = items.slice(0, LIST_MAX);
  const more = items.length - shown.length;
  const list = shown.length
    ? `<ul style="margin:8px 0 0;padding-left:20px;color:#333;font-size:14px;line-height:1.6">${
      shown.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
    }${more > 0 ? `<li style="color:#718096">and ${more} more in the Board Center</li>` : ''}</ul>`
    : '';
  return `<div style="margin:0 0 22px">
    <h2 style="margin:0 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${NAVY}">${
    escapeHtml(title)
  }</h2>
    <p style="margin:0;color:#4a5568;font-size:14px">${escapeHtml(lead)}</p>${list}
  </div>`;
}

// ---------------------------------------------------------------- compose

export interface Digest {
  subject: string;
  heading: string;
  /** With each gift and its donor -- for the donations list only. */
  full: string;
  /** Giving as totals. */
  summary: string;
  counts: Record<string, number>;
}

function rows(result: { data: unknown; error: unknown }): Row[] {
  if (result.error) throw result.error;
  return (result.data as Row[] | null) ?? [];
}

async function compose(): Promise<Digest> {
  const db = serviceClient();
  const now = Date.now();
  const { date: today } = newYorkNow();
  const weekAgo = new Date(now - 7 * DAY_MS).toISOString();
  const weekAhead = addDays(today, 6);

  const [enquiries, volunteers, intake, gifts, events, rsvps, monthStart] = await Promise.all([
    db.from('contact_submissions').select('name, interest, status, created_at')
      .order('created_at', { ascending: true }).limit(5000),
    db.from('volunteer_interests')
      .select('first_name, last_name, city, interests, availability, status, created_at')
      .order('created_at', { ascending: true }).limit(5000),
    db.from('intake_queue')
      .select('ref, stage, owner_email, follow_up_due, first_contact_at, received_at').limit(5000),
    db.from('donations')
      .select('status, amount_cents, created_at, receipt_sent_at, donor_email, donor_name, is_recurring, ' +
        'fund_designation, metadata')
      .limit(10000),
    db.from('events').select('id, title, starts_at, ends_at, published').limit(1000),
    db.from('event_rsvps').select('event_id, party_size').limit(10000),
    db.rpc('ppr_period_start', { unit: 'month' }),
  ]);
  if (monthStart.error) throw monthStart.error;
  const monthFrom = Date.parse(String(monthStart.data));
  const thisWeekOnly = (r: Row, key = 'created_at') => String(r[key]) >= weekAgo;

  // Enquiries nobody has answered, longest-waiting first.
  const allEnquiries = rows(enquiries);
  const waiting = allEnquiries.filter((r) => (r.status ?? 'new') === 'new');
  const enquiriesThisWeek = allEnquiries.filter((r) => thisWeekOnly(r)).length;

  // Volunteers: everybody who signed up this week -- bar anyone already set
  // aside as inactive (spam, a test) -- then anybody older still waiting to be
  // screened.
  const allVolunteers = rows(volunteers);
  const newVolunteers = allVolunteers.filter((r) => thisWeekOnly(r) && r.status !== 'inactive');
  const unscreened = allVolunteers.filter((r) => (r.status ?? 'new') === 'new');
  const olderUnscreened = unscreened.filter((r) => !thisWeekOnly(r));

  // Intake: reference numbers and dates only. The follow-up date is the
  // deadline for first contact, so only someone nobody has reached yet can be
  // late for it -- the same rule as board_summary's overdue count.
  const open = rows(intake).filter((r) => r.stage !== 'closed');
  const notReached = open.filter((r) => r.stage === 'awaiting_contact' && !r.first_contact_at && r.follow_up_due);
  const overdue = notReached.filter((r) => String(r.follow_up_due) < today)
    .sort((a, b) => String(a.follow_up_due).localeCompare(String(b.follow_up_due)));
  const dueSoon = notReached.filter((r) => String(r.follow_up_due) >= today && String(r.follow_up_due) <= weekAhead)
    .sort((a, b) => String(a.follow_up_due).localeCompare(String(b.follow_up_due)));
  const unassigned = open.filter((r) => !r.owner_email).length;
  const intakeThisWeek = rows(intake).filter((r) => thisWeekOnly(r, 'received_at')).length;

  // Giving.
  const allGifts = rows(gifts);
  const received = allGifts.filter((r) => r.status === 'succeeded');
  const sum = (list: Row[]) => list.reduce((total, r) => total + (Number(r.amount_cents) || 0), 0);
  const thisWeek = received.filter((r) => thisWeekOnly(r))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const thisMonth = received.filter((r) => Date.parse(String(r.created_at)) >= monthFrom);
  const owed = received.filter((r) => !r.receipt_sent_at);
  const owedLarge = owed.filter((r) => (Number(r.amount_cents) || 0) >= 25_000).length;
  const owedUnsendable = owed.filter((r) => !parseEmail(r.donor_email)).length;
  const failed = allGifts.filter((r) => r.status === 'failed' && Date.parse(String(r.created_at)) >= monthFrom).length;
  const unfinished = allGifts.filter((r) => r.status === 'expired' && thisWeekOnly(r)).length;
  const stuck = allGifts.filter((r) => (r.status === 'pending' || r.status === 'processing') &&
    now - Date.parse(String(r.created_at)) > STUCK_HOURS * 3_600_000).length;

  // The next published event that has not finished.
  const tally = new Map<string, { rsvps: number; people: number }>();
  for (const r of rows(rsvps)) {
    const key = String(r.event_id);
    const c = tally.get(key) ?? { rsvps: 0, people: 0 };
    c.rsvps += 1;
    c.people += Number(r.party_size) || 1;
    tally.set(key, c);
  }
  const allEvents = rows(events);
  const next = allEvents
    .filter((e) => e.published && e.starts_at &&
      Date.parse(String(e.ends_at ?? e.starts_at)) + (e.ends_at ? 0 : DAY_MS) >= now)
    .sort((a, b) => Date.parse(String(a.starts_at)) - Date.parse(String(b.starts_at)))[0];
  const drafts = allEvents.filter((e) => !e.published).length;

  // ------------------------------------------------------------- the email
  const enquiryBlock = section('People who wrote in',
    waiting.length
      ? `${plural(waiting.length, 'enquiry has', 'enquiries have')} had no reply` +
        (enquiriesThisWeek ? `; ${enquiriesThisWeek} came in this week` : '') +
        '. Open each in the Board Center and use Reply — it marks them Contacted.'
      : 'Every enquiry has had a reply.' +
        (enquiriesThisWeek ? ` ${plural(enquiriesThisWeek, 'came', 'came')} in this week.` : ''),
    waiting.map((r) =>
      `${fullName(r.name)} — about ${ABOUT[String(r.interest)] ?? 'a general question'} — waiting ${
        waited(String(r.created_at))
      }`
    ));

  const describeVolunteer = (r: Row) => {
    const interests = Array.isArray(r.interests)
      ? (r.interests as unknown[]).map((i) => INTERESTS[String(i)] ?? String(i)).join(', ')
      : '';
    return [
      fullName(r.first_name, r.last_name) + (r.city ? ` (${String(r.city)})` : ''),
      interests,
      AVAILABILITY[String(r.availability)] ?? (r.availability ? String(r.availability) : ''),
    ].filter(Boolean).join(' — ');
  };
  const volunteerBlock = section('Volunteers',
    (newVolunteers.length
      ? `${plural(newVolunteers.length, 'person', 'people')} signed up this week`
      : 'Nobody signed up this week') +
      (unscreened.length ? `; ${unscreened.length} waiting to be screened in all.` : '; nobody is waiting to be screened.'),
    [
      ...newVolunteers.map((r) =>
        `${describeVolunteer(r)} — signed up ${dayOf(r.created_at)}${(r.status ?? 'new') === 'new' ? '' : ', already screened'}`
      ),
      ...olderUnscreened.map((r) => `${describeVolunteer(r)} — still to screen, signed up ${waited(String(r.created_at))} ago`),
    ]);

  const intakeBlock = section('Intake',
    open.length
      ? `${plural(open.length, 'intake is', 'intakes are')} open` +
        (overdue.length
          ? `, ${overdue.length} not yet contacted and past ${overdue.length === 1 ? 'its' : 'their'} follow-up date`
          : '') +
        (unassigned ? `, ${unassigned} with nobody assigned` : '') + '.' +
        (intakeThisWeek ? ` ${plural(intakeThisWeek, 'new intake', 'new intakes')} this week.` : '')
      : 'No intake is open.' +
        (intakeThisWeek ? ` ${plural(intakeThisWeek, 'intake', 'intakes')} came in this week.` : ''),
    [
      ...overdue.map((r) => `${String(r.ref)} — follow-up was due ${dayLabel(String(r.follow_up_due))}`),
      ...dueSoon.map((r) => `${String(r.ref)} — follow-up due ${dayLabel(String(r.follow_up_due))}`),
    ]);

  const givingLead = `${money(sum(thisWeek)) || '$0.00'} from ${plural(thisWeek.length, 'gift', 'gifts')} this ` +
    `week; ${money(sum(thisMonth)) || '$0.00'} so far this month.`;
  const givingNotes: string[] = [];
  if (owed.length) {
    givingNotes.push(`${plural(owed.length, 'gift has', 'gifts have')} no receipt yet` +
      (owedLarge ? ` (${owedLarge} of $250 or more, which the donor needs to claim the deduction)` : '') +
      (owedUnsendable ? ` — ${owedUnsendable} with an email address that looks mistyped` : ''));
  }
  if (failed) givingNotes.push(`${plural(failed, 'payment', 'payments')} failed this month`);
  if (unfinished) givingNotes.push(`${plural(unfinished, 'gift was', 'gifts were')} started this week but not finished`);
  if (stuck) {
    givingNotes.push(`${plural(stuck, 'gift has', 'gifts have')} been waiting on Stripe for over a day — ` +
      'the automatic check against Stripe may have stopped');
  }
  const giftLine = (r: Row) => {
    const label = (r.metadata as Row | null)?.fund_label;
    const fund = label ? String(label) : FUNDS[String(r.fund_designation)] ?? 'where it’s needed most';
    return `${String(r.donor_name ?? '').trim() || 'Anonymous'} — ${money(Number(r.amount_cents))}` +
      `${r.is_recurring ? ' a month' : ''} — ${fund} — ${dayOf(r.created_at)} — ` +
      (r.receipt_sent_at ? 'receipt sent' : 'no receipt yet');
  };
  const givingFull = section('Giving', givingLead, [...thisWeek.map(giftLine), ...givingNotes]);
  const givingSummary = section('Giving', givingLead + ' Donors are listed in the Board Center under Giving.',
    givingNotes);

  const eventsBlock = section('Events',
    next
      ? `Next: ${String(next.title ?? 'Untitled')}, ${
        new Date(String(next.starts_at)).toLocaleString('en-US', {
          timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        })
      } — ${plural(tally.get(String(next.id))?.rsvps ?? 0, 'RSVP', 'RSVPs')}` +
        ((tally.get(String(next.id))?.people ?? 0) > (tally.get(String(next.id))?.rsvps ?? 0)
          ? ` (${tally.get(String(next.id))?.people} people)` : '') + '.'
      : 'No published event is coming up.',
    drafts ? [`${plural(drafts, 'event is', 'events are')} still a draft and not on the website`] : []);

  // The subject carries what most needs a person, then what came in.
  const headline: string[] = [];
  if (waiting.length) headline.push(plural(waiting.length, 'enquiry waiting', 'enquiries waiting'));
  if (overdue.length) headline.push(plural(overdue.length, 'intake follow-up overdue', 'intake follow-ups overdue'));
  if (stuck) headline.push('gifts stuck at Stripe');
  if (newVolunteers.length) headline.push(plural(newVolunteers.length, 'new volunteer', 'new volunteers'));
  if (thisWeek.length) headline.push(`${money(sum(thisWeek))} in gifts`);
  if (unscreened.length && !newVolunteers.length) {
    headline.push(plural(unscreened.length, 'volunteer to screen', 'volunteers to screen'));
  }
  if (owed.length) headline.push(plural(owed.length, 'receipt to send', 'receipts to send'));
  const subject = `Week of ${dayLabel(today)}: ${headline.slice(0, 3).join(', ') || 'nothing waiting'}`;

  const intro = `<p style="margin:0 0 20px;color:#4a5568;font-size:14px">Good morning. Here is what came in ` +
    `over the last seven days and what is waiting on somebody. Contact details and messages are in the ` +
    `Board Center.</p>`;
  const body = (giving: string) => intro + enquiryBlock + volunteerBlock + intakeBlock + giving + eventsBlock;

  return {
    subject,
    heading: `The week of ${dayLabel(today)}`,
    full: body(givingFull),
    summary: body(givingSummary),
    counts: {
      enquiries_waiting: waiting.length,
      enquiries_this_week: enquiriesThisWeek,
      volunteers_this_week: newVolunteers.length,
      volunteers_unscreened: unscreened.length,
      intake_open: open.length,
      intake_overdue: overdue.length,
      intake_due_this_week: dueSoon.length,
      gifts_this_week: thisWeek.length,
      gift_cents_this_week: sum(thisWeek),
      receipts_owed: owed.length,
      payments_failed: failed,
      checkouts_unfinished: unfinished,
      gifts_stuck: stuck,
    },
  };
}

// ---------------------------------------------------------------- handler

/** Who gets which version: each gift only to people already on the
 *  donations list; everybody else on the forms list gets the totals. */
async function audiences(): Promise<{ full: string[]; summary: string[] }> {
  const [forms, donations] = await Promise.all([recipientList('forms'), recipientList('donations')]);
  const seesGifts = new Set(donations.map((address) => address.toLowerCase()));
  return { full: donations, summary: forms.filter((address) => !seesGifts.has(address.toLowerCase())) };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      const lists = await audiences();
      return json(req, {
        service: 'board-digest',
        ...healthReport(REQUIRED_SECRETS),
        // Counts only, never the addresses.
        recipients: lists.full.length + lists.summary.length,
        recipients_with_gifts: lists.full.length,
      });
    }
    return fail(req, 'Method not allowed', 405);
  }
  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);

  const caller = await identify(req);
  if (!caller) return fail(req, 'You do not have access to the weekly summary.', 403);

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dry_run === true;

  // One address and one version for a preview; the standing lists otherwise.
  let preview: { to: string; variant: Variant } | null = null;
  if (caller.kind === 'admin') {
    if (!dryRun && body?.preview !== true) {
      return fail(req, 'From the Board Center the summary can only be previewed.');
    }
    preview = { to: caller.email, variant: caller.finance ? 'full' : 'summary' };
  } else if (body?.preview_to !== undefined) {
    const address = parseEmail(body.preview_to);
    if (!address) return fail(req, 'preview_to is not an email address.');
    preview = { to: address, variant: body?.variant === 'full' ? 'full' : 'summary' };
  } else if (!dryRun && body?.force !== true) {
    const { hour } = newYorkNow();
    if (hour !== SEND_HOUR) {
      return json(req, { ok: true, sent: false, skipped: `It is ${hour}:00 in New York; the summary goes at ${SEND_HOUR}.` });
    }
  }

  let digest: Digest;
  try {
    digest = await compose();
  } catch (error) {
    console.error('digest_compose_failed', error);
    return fail(req, 'Could not put the summary together.', 500);
  }

  const lists = preview
    ? { full: preview.variant === 'full' ? [preview.to] : [], summary: preview.variant === 'summary' ? [preview.to] : [] }
    : await audiences();

  if (dryRun) {
    return json(req, {
      ok: true,
      sent: false,
      subject: digest.subject,
      counts: digest.counts,
      recipients: { with_gifts: lists.full.length, totals_only: lists.summary.length },
      html: digest.full,
      summary_html: digest.summary,
    });
  }

  const site = env('SITE_URL', 'https://pivotpointrecovery.org').replace(/\/+$/, '');
  const options = { heading: digest.heading, links: [['Open the Board Center', `${site}/admin`]] as Array<[string, string]> };
  // An empty `to` would fall back to the whole forms list, so a version with
  // nobody to receive it is simply not sent.
  const sends: Array<{ variant: Variant; result: { notified: boolean; reason?: string; recipients: number } }> = [];
  for (const variant of ['full', 'summary'] as Variant[]) {
    if (lists[variant].length === 0) continue;
    sends.push({
      variant,
      result: await sendStaffHtml(digest.subject, digest[variant], { ...options, to: lists[variant] }),
    });
  }
  const sent = sends.length > 0 && sends.every((s) => s.result.notified);
  const recipients = sends.reduce((n, s) => n + (s.result.notified ? s.result.recipients : 0), 0);
  const reason = sends.length === 0
    ? 'nobody is on the notification lists'
    : sends.filter((s) => !s.result.notified).map((s) => `${s.variant}: ${s.result.reason ?? 'unknown'}`).join('; ');

  // On the record either way: a summary that did not go out is worth knowing.
  const { error: logError } = await serviceClient().from('activity_log').insert({
    actor_email: caller.kind === 'admin' ? caller.email : 'system',
    action: preview ? 'digest_preview' : 'digest',
    entity: 'board_digest',
    detail: { recipients, sent, reason: sent ? null : reason, ...digest.counts },
  });
  if (logError) console.error('digest_log_failed', logError);

  if (!sent) return fail(req, `The summary did not send: ${reason}.`, 502);
  return json(req, { ok: true, sent: true, recipients, subject: digest.subject });
});
