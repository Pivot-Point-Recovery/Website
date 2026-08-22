// Public contact + volunteer + event RSVP handler.
//
// Wire-compatible with the payloads contact.html and volunteer.html already
// send. Saves with the service role, then notifies staff via Resend.
//
// The save and the notification are deliberately independent: a submission is
// never lost because email failed. The response reports `notified` so a silent
// mail failure is visible rather than invisible.

import { fail, json, preflight } from '../_shared/http.ts';
import { serviceClient } from '../_shared/db.ts';
import { recipientCount, sendNotification } from '../_shared/notify.ts';
import { healthReport } from '../_shared/env.ts';
import { email as parseEmail, int, str, strList } from '../_shared/validate.ts';

// Where an event RSVP goes when the event row does not name an organiser.
// Events created at /admin carry their own rsvp_email; this is the floor, so a
// missing one routes to the person who runs events rather than to the general
// enquiries list.
const DEFAULT_RSVP_RECIPIENT = 'steve@pivotpointrecovery.org';

const REQUIRED_SECRETS = ['RESEND_API_KEY'];
// NOTIFICATION_EMAILS is no longer required: recipients can come from the
// notification_recipients table instead. `recipients` in the health output is
// the number that actually matters -- if it is 0, nobody gets told.
const OPTIONAL_SECRETS = [
  'NOTIFICATION_EMAILS',
  'RESEND_FROM',
  'NOTIFICATION_PREFIX',
  'ALLOWED_ORIGINS',
];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.has('health')) {
      return json(req, {
        service: 'public-forms',
        ...healthReport(REQUIRED_SECRETS, OPTIONAL_SECRETS),
        // Count only, never the addresses.
        recipients: await recipientCount('forms'),
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

  // Honeypot. Bots fill the off-screen field; humans never see it. Report
  // success and drop the submission so the bot has no signal to adapt to.
  if (str(payload._honeypot, 200)) {
    console.log('honeypot_triggered');
    return json(req, { ok: true, notified: false });
  }

  const formType = str(payload.form_type, 40);
  const userAgent = str(req.headers.get('user-agent') ?? '', 500);
  const db = serviceClient();

  if (formType === 'contact') {
    const name = str(payload.name, 200);
    const email = parseEmail(payload.email);
    if (!name) return fail(req, 'Please enter your name.');
    if (!email) return fail(req, 'Please enter a valid email address.');

    const record = {
      name,
      email,
      phone: str(payload.phone, 40),
      interest: str(payload.interest, 200),
      message: str(payload.message, 5000),
      source: 'website',
      user_agent: userAgent,
    };

    const { data, error } = await db
      .from('contact_submissions')
      .insert(record)
      .select('id')
      .single();

    if (error) {
      console.error('contact_insert_failed', error);
      return fail(req, 'We could not save your message. Please try again.', 500);
    }

    const result = await sendNotification(
      'New contact message',
      [
        ['Name', record.name],
        ['Email', record.email],
        ['Phone', record.phone],
        ['Interest', record.interest],
        ['Message', record.message],
      ],
      { replyTo: record.email, intro: `${record.name} sent a message through the website.` },
    );

    if (result.notified) {
      await db.from('contact_submissions').update({ notified: true }).eq('id', data.id);
    } else {
      console.warn('contact_not_notified', result.reason);
    }

    return json(req, { ok: true, notified: result.notified });
  }

  if (formType === 'volunteer') {
    const firstName = str(payload.first_name, 100);
    const lastName = str(payload.last_name, 100);
    const email = parseEmail(payload.email);
    if (!firstName) return fail(req, 'Please enter your first name.');
    if (!lastName) return fail(req, 'Please enter your last name.');
    if (!email) return fail(req, 'Please enter a valid email address.');

    const record = {
      first_name: firstName,
      last_name: lastName,
      email,
      phone: str(payload.phone, 40),
      city: str(payload.city, 120),
      interests: strList(payload.interests),
      availability: str(payload.availability, 200),
      experience: str(payload.experience, 5000),
      source: 'website',
      user_agent: userAgent,
    };

    const { data, error } = await db
      .from('volunteer_interests')
      .insert(record)
      .select('id')
      .single();

    if (error) {
      console.error('volunteer_insert_failed', error);
      return fail(req, 'We could not save your interest. Please try again.', 500);
    }

    const result = await sendNotification(
      'New volunteer interest',
      [
        ['Name', `${record.first_name} ${record.last_name}`],
        ['Email', record.email],
        ['Phone', record.phone],
        ['City', record.city],
        ['Interests', record.interests.join(', ')],
        ['Availability', record.availability],
        ['Experience', record.experience],
      ],
      { replyTo: record.email, intro: `${record.first_name} ${record.last_name} wants to volunteer.` },
    );

    if (result.notified) {
      await db.from('volunteer_interests').update({ notified: true }).eq('id', data.id);
    } else {
      console.warn('volunteer_not_notified', result.reason);
    }

    return json(req, { ok: true, notified: result.notified });
  }

  if (formType === 'event_rsvp') {
    const slug = str(payload.event_slug, 120).toLowerCase();
    const name = str(payload.name, 200);
    const email = parseEmail(payload.email);
    if (!slug) return fail(req, 'Missing event.');
    if (!name) return fail(req, 'Please enter your name.');
    if (!email) return fail(req, 'Please enter a valid email address.');

    // The event decides whether it is still taking RSVPs and who hears about
    // them -- never the browser. A payload cannot nominate its own recipient.
    const { data: event, error: eventError } = await db
      .from('events')
      .select('id, slug, title, starts_at, rsvp_enabled, rsvp_email, published')
      .eq('slug', slug)
      .maybeSingle();

    if (eventError) {
      console.error('event_lookup_failed', eventError);
      return fail(req, 'We could not take your RSVP just now. Please try again.', 500);
    }
    if (!event || !event.published) return fail(req, 'We could not find that event.', 404);
    if (event.rsvp_enabled === false) {
      return fail(req, 'RSVPs for this event are closed. Please contact us instead.');
    }

    const record = {
      event_id: event.id,
      event_slug: event.slug,
      event_title: event.title,
      name,
      email,
      phone: str(payload.phone, 40),
      party_size: int(payload.party_size, 1, 20, 1),
      participation: str(payload.participation, 40),
      act_type: strList(payload.act_type, 10, 60),
      notes: str(payload.notes, 5000),
      source: 'website',
      user_agent: userAgent,
    };

    const { data, error } = await db
      .from('event_rsvps')
      .insert(record)
      .select('id')
      .single();

    if (error) {
      console.error('event_rsvp_insert_failed', error);
      return fail(req, 'We could not save your RSVP. Please try again.', 500);
    }

    const partyLabel = record.party_size === 1
      ? 'Just them'
      : `${record.party_size} people (including them)`;
    const participationLabel = record.participation === 'perform'
      ? 'Wants to perform'
      : record.participation === 'listen'
      ? 'Coming to watch and listen'
      : record.participation === 'undecided'
      ? 'Undecided about performing'
      : record.participation;

    const result = await sendNotification(
      `New RSVP: ${event.title}`,
      [
        ['Event', event.title],
        ['Name', record.name],
        ['Email', record.email],
        ['Phone', record.phone],
        ['Party size', partyLabel],
        ['Taking part', participationLabel],
        ['Would perform', record.act_type.join(', ')],
        ['Notes', record.notes],
      ],
      {
        replyTo: record.email,
        intro: `${record.name} RSVP'd for ${event.title}.`,
        to: [str(event.rsvp_email, 254) || DEFAULT_RSVP_RECIPIENT],
      },
    );

    if (result.notified) {
      await db.from('event_rsvps').update({ notified: true }).eq('id', data.id);
    } else {
      console.warn('event_rsvp_not_notified', result.reason);
    }

    return json(req, { ok: true, notified: result.notified });
  }

  return fail(req, 'Unknown form type.');
});
