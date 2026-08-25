-- Seed data: the first event, and the people allowed to edit events.
--
-- Kept in its own migration so the schema above stays reviewable on its own,
-- and so re-running it cannot duplicate anything: both inserts are idempotent
-- on the natural key (event slug, editor email).

-- Julie maintains the events calendar from /admin; Erica keeps access as the
-- executive director. Adding someone later is one insert -- no deploy, no
-- secret edit, no code change.
insert into public.event_editors (email, label)
values
  ('jbathel6365@gmail.com',        'Julie — events'),
  ('erica@pivotpointrecovery.org', 'Erica — Executive Director')
on conflict (lower(email)) do update
   set active = true,
       label  = excluded.label;

-- Open Mic Night, 29 August 2026. Already advertised on a printed flyer whose
-- QR code points at /openmic, so this row carries detail_url: the events list
-- links to that hand-built page rather than the generic /event template.
insert into public.events (
  slug, title, tagline, summary, description,
  starts_at, ends_at,
  location_name, address, city, state, postal_code,
  image_url, cost_text, detail_url,
  rsvp_enabled, rsvp_email, published, featured, created_by
) values (
  'open-mic-night',
  'Open Mic Night',
  'Share your voice. Inspire change. Build community.',
  'An evening of authentic stories, music, poetry, and creativity as we come together to raise awareness and build a stronger recovery community.',
  'All voices. All stories. All welcome.

Join us for an evening of authentic stories, music, poetry, and creativity as we come together to raise awareness and build a stronger recovery community.

Come out to perform or just come to listen and show your support. There is no pressure to take the microphone — half of what makes a night like this work is the people in the seats.

This event is sponsored by Pivot Point Recovery, a peer led, community based recovery hub providing clinical services, mentorship, and wraparound support.',
  '2026-08-29 18:00:00-04'::timestamptz,
  '2026-08-29 21:00:00-04'::timestamptz,
  'Ashburn Recreation and Community Center',
  '21105 Cooper''s Hawk Drive',
  'Ashburn',
  'VA',
  '20148',
  'https://images.pexels.com/photos/16727451/pexels-photo-16727451.jpeg?auto=compress&cs=tinysrgb&w=1600',
  'Open to the community',
  '/openmic',
  true,
  'steve@pivotpointrecovery.org',
  true,
  true,
  'seed'
)
on conflict (lower(slug)) do nothing;

-- The row above was first seeded as 'Open Mike Night' / 'open-mike-night',
-- following the printed flyer. The spelling was corrected to "Mic" afterwards,
-- so bring an already-seeded database in line with the values above rather than
-- leaving the live row and a freshly built one disagreeing.
update public.events
   set slug  = 'open-mic-night',
       title = 'Open Mic Night'
 where slug = 'open-mike-night';
