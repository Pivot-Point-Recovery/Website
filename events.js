// Shared event data + formatting for /events, /event and /admin.
//
// Reads the public `events` table straight from PostgREST with the publishable
// key. That key is meant to be in a page: RLS on the table only exposes rows
// where published is true, and the RSVP table it cannot read at all.
//
// No build step and no SDK -- plain fetch against the REST endpoint, which also
// keeps the site's CSP free of a third-party script host.

const SUPABASE_URL = 'https://ihgwhglatsbhngbsezuj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LY1v9wC3FAjEREPvwaRbUw_p9nDwIiB';

// The organisation is in Northern Virginia and so is every event. Formatting in
// the venue's timezone means a visitor in another one is told when to turn up,
// not when their own clock says it starts.
const EVENT_TZ = 'America/New_York';

const EVENT_FIELDS = [
  'id', 'slug', 'title', 'tagline', 'summary', 'description',
  'starts_at', 'ends_at', 'when_text',
  'location_name', 'address', 'city', 'state', 'postal_code',
  'image_url', 'cost_text', 'detail_url',
  'rsvp_enabled', 'published', 'featured',
].join(',');

async function restGet(path) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Could not load events (' + res.status + ')');
  return await res.json();
}

/** Every published event, soonest first. */
async function fetchEvents() {
  return await restGet('events?select=' + EVENT_FIELDS + '&published=is.true&order=starts_at.asc');
}

/** One published event by slug, or null. */
async function fetchEvent(slug) {
  const rows = await restGet(
    'events?select=' + EVENT_FIELDS + '&published=is.true&slug=eq.' + encodeURIComponent(slug) + '&limit=1',
  );
  return rows.length ? rows[0] : null;
}

/** An event is over once its end time passes -- or, with no end time, once the
 *  day it starts on is done, so a same-day event never reads as "past" while
 *  people are still in the room. */
function isPast(ev) {
  const end = ev.ends_at ? new Date(ev.ends_at) : null;
  if (end) return end.getTime() < Date.now();
  if (!ev.starts_at) return false;
  const start = new Date(ev.starts_at);
  return start.getTime() + 24 * 60 * 60 * 1000 < Date.now();
}

function fmt(date, opts) {
  return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: EVENT_TZ }, opts)).format(date);
}

/** "Saturday, August 29, 2026" */
function formatDate(ev) {
  if (!ev.starts_at) return '';
  return fmt(new Date(ev.starts_at), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** "6:00pm – 9:00pm", or just the start time when there is no end. */
function formatTime(ev) {
  if (!ev.starts_at) return '';
  const time = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' }).replace(' AM', 'am').replace(' PM', 'pm');
  const start = time(new Date(ev.starts_at));
  if (!ev.ends_at) return start;
  return start + ' – ' + time(new Date(ev.ends_at));
}

/** The one-line "when", preferring whatever a human typed into when_text. */
function formatWhen(ev) {
  if (ev.when_text) return ev.when_text;
  const date = formatDate(ev);
  const time = formatTime(ev);
  return date && time ? date + ' · ' + time : date || time;
}

/** "Ashburn Recreation and Community Center, 21105 Cooper's Hawk Drive, Ashburn, VA 20148" */
function formatWhere(ev) {
  const cityLine = [ev.city, ev.state].filter(Boolean).join(', ');
  return [ev.location_name, ev.address, [cityLine, ev.postal_code].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

/** Where a visitor should be sent for this event: its own page if it has one,
 *  otherwise the generic template. */
function eventHref(ev) {
  return ev.detail_url || ('/event?slug=' + encodeURIComponent(ev.slug));
}

/** Escape before inserting anything an editor typed into the page. Event copy
 *  is written by a person in /admin, and it is rendered as text, never markup. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Editor-entered image URLs only, and only over https. Blocks javascript: and
 *  data: URIs from reaching an attribute. */
function safeImageUrl(url) {
  const value = String(url || '').trim();
  return /^https:\/\//i.test(value) ? value : '';
}
