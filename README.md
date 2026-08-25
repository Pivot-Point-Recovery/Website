# Pivot Point Recovery — Public Website

The public marketing site for [pivotpointrecovery.org](https://pivotpointrecovery.org).

Plain static HTML + CSS + a little vanilla JS. No build step, no framework, no
dependencies. Open a file in a browser and it works.

This repo is **only** the public website. The staff portal, CRM, accounting,
and donation processing live in the separate `nonprofitportal` application.

## Pages

| Path | File | Notes |
| --- | --- | --- |
| `/` | `index.html` | Home |
| `/about` | `about.html` | Our Story — founder bio, board |
| `/services` | `services.html` | Programs and continuum of care |
| `/resources` | `resources.html` | Searchable local resource directory |
| `/get-involved` | `get-involved.html` | Ways to help |
| `/volunteer` | `volunteer.html` | Volunteer interest form |
| `/donate` | `donate.html` | Giving page → Stripe Checkout |
| `/contact` | `contact.html` | Contact form |
| `/events` | `events.html` | Event calendar, read from the database |
| `/event?slug=…` | `event.html` | Generic event page, rendered from the database |
| `/openmic` | `openmic.html` | Open Mic Night — hand-built, because a printed flyer's QR code points here |
| `/admin` | `admin.html` | Staff event editor (`noindex`, password) |

Shared assets: `styles.css`, `main.js`, `events.js`, `logo-color.svg`,
`logo-white.svg`, `favicon.svg`, `veteran.jpeg`.

## Design system

Defined as CSS custom properties at the top of `styles.css`.

- **Blue** `#005191` · **Navy** `#1a2b4a` · **Gold** `#ffb81c` (CTA accent)
- **Display font** Antonio (uppercase headings) · **Body font** Palanquin
- 1200px container, 12px radius

Reuse the existing classes rather than adding new ones where possible:
`page-hero`, `content-section`, `section-title`, `section-label`,
`involve-card`, `service-detail`, `split-section`, `check-list`, `cta-banner`,
`contact-form`, `form-group`, `btn btn-primary|btn-blue|btn-outline|btn-ghost`.

## Forms

All three public forms POST to the same Supabase edge function, which validates the
payload, writes it to the database with the service role, and emails staff via
Resend. The function answers preflight with an explicit origin allowlist —
`pivotpointrecovery.org`, `www.pivotpointrecovery.org`, any `*.pages.dev`
preview, and localhost — overridable with the `ALLOWED_ORIGINS` secret:

```
https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/public-forms
```

| Form | `form_type` | Table |
| --- | --- | --- |
| Contact | `contact` | `contact_submissions` |
| Volunteer | `volunteer` | `volunteer_interests` |
| Event RSVP | `event_rsvp` | `event_rsvps` |

An RSVP is the one form whose recipient is not the standing staff list. The
browser sends only `event_slug`; the function looks the event up and mails
whoever `events.rsvp_email` names, falling back to
`steve@pivotpointrecovery.org`. A payload cannot nominate its own recipient,
and an event that is unpublished or has `rsvp_enabled = false` is refused.

All three include an off-screen honeypot field (`_honeypot`); the function
silently accepts and drops any submission that fills it.

### Who receives the notification emails

Two sources, unioned — the `notification_recipients` table and the
`NOTIFICATION_EMAILS` secret. Adding a person is an insert, not a privileged
secret edit plus a redeploy:

```sql
insert into public.notification_recipients (email, label)
values ('steve@pivotpointrecovery.org', 'Steve');

-- Stop mailing someone without losing the record that they were on the list
update public.notification_recipients set active = false where email = '…';

-- Donations and enquiries can go to different people
update public.notification_recipients
   set receives_donations = false where email = '…';
```

The table is an addition, never a replacement: an empty table changes nothing,
and if it cannot be read at all, whoever the secret names is still mailed.
Matching is case-insensitive, so one person cannot appear twice and get every
notification twice.

`?health=1` reports a `recipients` **count** (never the addresses — the
endpoint is unauthenticated). That count is the number that matters: `notified:
true` never revealed that the list omitted someone, because from outside, one
recipient and five look identical. It is how the omission below went unnoticed.

> **Worth knowing:** for months the list did not include
> `erica@pivotpointrecovery.org` — the person asking where the notifications
> were. Nothing reported this, because a send to the addresses that *were*
> listed succeeds and returns `notified: true`.

The secret still works and is still read:

```sh
supabase secrets set RESEND_API_KEY="re_..." \
  NOTIFICATION_EMAILS="steve@pivotpointrecovery.org,info@pivotpointrecovery.org" \
  RESEND_FROM="Pivot Point Recovery <info@pivotpointrecovery.org>" \
  NOTIFICATION_PREFIX="PPR"
```

If either `RESEND_API_KEY` or `NOTIFICATION_EMAILS` is unset, the submission is
still saved to the database but **no email goes out**. The function returns
`{ ok: true, notified: false }` and logs the reason.

> **Half-fixed, and the remaining half is worse than it looks (2026-08-20).**
>
> The *sending* problem is genuinely gone. `pivotpointrecovery.org` is verified
> in Resend — DKIM (`resend._domainkey`) and the `send.` bounce subdomain both
> resolve — `RESEND_FROM` is on-domain, and the old
> `403 validation_error` is no longer returned. Live submissions come back
> `{"ok":true,"notified":true}`.
>
> **But the mail is not arriving.** Over three hours, across repeated live
> submissions, nothing from this sender reached
> `erica@pivotpointrecovery.org` — checked with `in:anywhere`, so spam and
> trash included — while Stripe, Supabase and other external mail to the same
> address arrived normally. The mailbox is fine; our mail is not getting to it.
>
> `notified: true` means *Resend accepted the API call*. It says nothing about
> delivery, which is exactly the blind spot that let this sit unnoticed.
>
> Two checks pinpoint which side is dropping it:
>
> 1. **[resend.com/emails](https://resend.com/emails)** — per-message status.
>    `delivered` vs `bounced` / `blocked` decides everything below.
> 2. **Google Admin → spam quarantine** (`admin.google.com`) — if Resend says
>    delivered, the message is being held before the mailbox.
>
> The likely cause, if it is the Google side: the notification is sent **from
> an address on `pivotpointrecovery.org` to recipients on
> `pivotpointrecovery.org`**, via an external provider. Google Workspace
> quarantines same-domain mail arriving from outside by default ("protect
> against spoofing of your domain"), and that rule is applied independently of
> SPF/DKIM/DMARC — all of which pass here (DKIM signs as the org domain, so
> alignment is fine under `p=quarantine`).
>
> If that is it, this affects **every staff recipient**, not one person —
> `steve@` and `info@` are on the same domain as the sender.
>
> Two ways out:
>
> - Allow the sender in Google Admin (Gmail → Spam, Phishing and Malware).
> - Or send from a **subdomain** — e.g. `no-reply@send.pivotpointrecovery.org`
>   — which sidesteps the same-domain heuristic entirely. That subdomain
>   already carries SPF and an SES MX; add it in Resend as a sending domain and
>   point `RESEND_FROM` at it.

Verify with:

```sh
# Config presence (booleans only, never values)
curl -s "https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/public-forms?health=1"

# A real submission
curl -s -X POST https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/public-forms \
  -H 'Content-Type: application/json' -H 'Origin: https://pivotpointrecovery.org' \
  -d '{"form_type":"volunteer","first_name":"Test","last_name":"Test","email":"you@example.com","phone":"5555550100"}'
```

`notified` must come back `true`.

## Events

Events are **data, not markup**. They live in the `events` table and are edited
at `/admin` by staff, because the calendar changes weekly and the person who
knows the next date does not edit HTML.

| Page | Reads |
| --- | --- |
| `/events` | Every published event, split into upcoming and past |
| `/event?slug=…` | One published event, rendered from its row |
| `/openmic` | Nothing — hand-built HTML |

`/events` and `/event` read PostgREST directly with the **publishable** key,
which is meant to sit in a page: RLS exposes only rows where `published` is
true, and `event_rsvps` is not readable with it at all. No SDK and no build
step — `events.js` is plain `fetch`, so the CSP needs no third-party script
host.

Times are formatted in `America/New_York` rather than the visitor's timezone.
Every event is in Northern Virginia, so a visitor in Denver needs to know when
to turn up at the venue, not what their own clock will say.

### Two ways an event can have a page

Most events use the generic `/event?slug=…` template. An event with its own
hand-built page sets `detail_url`, and the events list links there instead —
which is why Open Mic Night has both a row in the table *and* `openmic.html`:
a printed flyer's QR code points at `/openmic`, so that URL must work without
depending on JavaScript or a database read.

### /admin — the Board Center

`/admin` is the staff and board workspace: `admin.html` (shell and the event
form), `board-center.css` (app shell) and `board-center.js` (everything else).
Still no build step and no dependencies — plain files served by Pages, talking
to Supabase Auth and PostgREST over `fetch`.

| Section | What it holds |
| --- | --- |
| Dashboard | Counts, what needs a person, next event, giving by fund |
| Enquiries | Every contact-form submission, with stage, owner and notes |
| People → Directory | One row per person, matched on email across enquiries, volunteers and RSVPs |
| People → Volunteers | Sign-ups with a pipeline: new → screened → onboarding → active |
| People → Intake | The intake work queue. Reference numbers only — see below |
| People → Team & access | Who can sign in and as what (administrators only) |
| Events | The event editor, with each event's RSVPs and guest-list export under it |
| Giving | Totals for everyone; donor names and amounts for finance only |
| Board room → Documents | Labelled links into Drive, grouped by section |
| Activity log | Every change, and every read of a confidential record (administrators only) |

#### Roles

`staff_members` replaced the flat `event_editors` list. Three roles, and a
person can hold more than one:

| Role | Grants |
| --- | --- |
| `member` | Everything above except donor-level giving and the two admin-only sections |
| `finance` | Donor names and amounts. Erica and Steve only, by the board's decision |
| `admin` | Invite people, change roles, read the activity log |

```sql
-- Invite someone (or do it from People → Team & access)
insert into public.staff_members (email, label, roles)
values ('someone@example.org', 'Their name', array['member'])
on conflict (lower(email)) do update set active = true;

-- Revoke, without losing the record that they had access
update public.staff_members set active = false where email = '…';
```

Authorisation is **not** decided in the browser. Hiding a nav item is a
courtesy to the person using the page; the reason a board member cannot read a
donor row is that Postgres refuses to send it. `is_member()` and
`has_role()` read the JWT's email claim and check it on every statement, and
`is_event_editor()` now delegates to them so nothing that worked before broke.

Two details in that migration are load-bearing and easy to undo by accident:

- **`people_directory` is declared `with (security_invoker = true)`.** A view
  otherwise runs with its *owner's* rights, which would bypass RLS on the three
  tables underneath and hand the whole directory to any authenticated account —
  and anyone can create one of those. With it on, a non-member sees zero rows.
- **`protect_submission_content()`** pins every submitted column on update for
  the `authenticated` role, so nothing signed in to `/admin` can rewrite what
  somebody wrote. Stage, owner and notes are the writable layer on top; a
  promise kept only by the UI is not kept. It is scoped to that role
  deliberately — the service role, migrations and the SQL editor are exempt, so
  a genuine correction is still possible rather than silently doing nothing. If
  the public forms start collecting a new field, add it to the pinned list.

#### Intake, and the 42 CFR Part 2 boundary

`intake_queue` holds a reference number, a stage, an owner and a follow-up date.
It holds **no intake answers**, deliberately: those are protected under 42 CFR
Part 2 and HIPAA, and this database sits behind a public, internet-facing
surface — the reason it was split from the portal in the first place
(`docs/MIGRATION.md`). The board gets counts and response times; the record
itself stays in the system that collected it. Do not add answer columns to this
table without a compliance decision that is written down somewhere.

> **A PostgREST trap worth knowing.** An `UPDATE` or `DELETE` that RLS filters
> to zero rows answers **204, no error** — indistinguishable from success. A
> revoked editor would have been told "Saved" while nothing was written. Every
> write in `board-center.js` therefore goes through `writeRows()`, which sends
> `Prefer: return=representation` and treats an empty array as the failure it
> is. If you add a write path, use that helper — it lives in `board-center.js`.

Event copy is rendered as **escaped text, never markup** — `esc()` in
`events.js` — so a non-technical editor cannot put HTML on a public page by
accident. Image URLs are refused unless they start with `https://`; the CSP's
`img-src` is `https:` rather than a host list precisely because an editor
pastes those URLs and they cannot be enumerated in advance.

## Donations

`donate.html` collects the amount and donor details, then POSTs to the site's
own checkout function — the same Supabase project as the forms:

```
POST https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/donations-checkout
  →  { url }  →  redirect to Stripe Checkout
```

It no longer posts to `/api/donations/checkout`. That route belonged to the
portal, stopped resolving when this site moved to standalone Cloudflare Pages,
and answered **405** — which is what left the donate page dead. Nothing but the
static site needs to be mounted on this host any more.

Card data never touches this site. Both functions run with `verify_jwt` off
because they are public endpoints; they authenticate by origin, honeypot, and
(for the webhook) Stripe's own signature.

| Function | Job |
| --- | --- |
| `donations-checkout` | Validates the gift, writes a `pending` row, opens a Stripe Checkout session |
| `donations-webhook` | Confirms the gift from Stripe, emails the donor a receipt and staff a notification |

### What the checkout function decides, not the browser

The amount in the request body is a suggestion. The function re-derives what is
chargeable: a **$5 floor** (below it card fees eat the gift) and a **$50,000
ceiling** (above it, a card is the wrong instrument — the donor is asked to get
in touch). `donate.html` enforces the same floor client-side so the donor is
told before a round trip; `MIN_GIFT` there and `MIN_CENTS` in the function have
to stay in step.

The `donations` row is written *before* Stripe is called, so every attempt is
attributable even if Stripe errors, and its id is used as the Stripe
idempotency key — a double-submitted form cannot double-charge. Stripe metadata
carries donor and fund fields only; no participant identifiers ever cross into
it.

### The webhook

Stripe posts to `donations-webhook`, which is subscribed to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`invoice.paid`, and `customer.subscription.deleted`.

Two independent defences, because money is on the line:

1. **Signature check** against `STRIPE_WEBHOOK_SECRET`, with a 5-minute
   timestamp tolerance and a constant-time compare.
2. **Re-fetch.** Every object is read back from the Stripe API before anything
   is written, so amounts and payment status come from Stripe rather than from
   the request body.

`STRIPE_WEBHOOK_SECRET` **is set**, so `?health=1` reports
`"verification":"signature"` and a forged event is rejected outright with
`400 Invalid signature`. If the secret were ever removed the function stays up
in re-fetch-only mode (`"verification":"refetch_only"`) rather than failing
closed — a forged event still could not book a gift, since the amount is never
taken from the payload, but signature checking is the intended posture.

Redelivery is handled by a `stripe_events` table keyed on the Stripe event id,
so a replayed event returns `{"received":true,"duplicate":true}` and writes
nothing. Monthly renewals — the one donation with no checkout session behind it
— are keyed on the invoice id instead, which is what stops a redelivered
`invoice.paid` booking the same gift twice.

### Receipts

On a confirmed gift the webhook sends the donor a 501(c)(3) acknowledgement
(amount, date, fund, EIN 41-4331928, and the no-goods-or-services language the
IRS wants) and notifies staff separately. The two are tracked in different
columns — `receipt_sent_at` and `notified` — so if one send fails the retry
only repeats the half that failed, and no donor is thanked twice. Set
`DONOR_RECEIPTS=0` to suppress donor receipts and keep staff notifications.

## Backend

The backend now lives in this repo rather than only in the dashboard, so a
deploy is reproducible and reviewable:

```
supabase/
  config.toml
  migrations/            schema, applied in filename order
                         (incl. notification_recipients, events,
                          event_rsvps, event_editors, and the Board
                          Center: staff_members, activity_log,
                          record_notes, intake_queue, board_documents)
  functions/
    _shared/             http (CORS), db, env, validate, notify, stripe
    public-forms/        contact + volunteer + event RSVP
    donations-checkout/  opens Stripe Checkout
    donations-webhook/   confirms gifts, sends receipts
```

Deploy with the Supabase CLI:

```sh
supabase link --project-ref ihgwhglatsbhngbsezuj
supabase db push
supabase functions deploy public-forms      --no-verify-jwt
supabase functions deploy donations-checkout --no-verify-jwt
supabase functions deploy donations-webhook  --no-verify-jwt
```

`--no-verify-jwt` is required: these are public endpoints called by anonymous
visitors and by Stripe, neither of which carries a Supabase JWT.

> The events schema, its seed row, and the `public-forms` function carrying the
> `event_rsvp` handler were applied to the live project on 2026-08-22 and
> verified end to end: `{"ok":true,"notified":true}` for an RSVP, contact still
> working, anon blocked from `event_rsvps`, and a de-listed editor blocked from
> every write.

### Secrets

Set on the Supabase project, not in this repo. `env.ts` resolves each through a
short alias list, so a name that is *close* still works — but check
`?health=1` rather than assuming, because a missed secret fails silently.

| Secret | Used by | Effect if unset |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | checkout, webhook | Checkout returns 502; no gift can be made |
| `STRIPE_WEBHOOK_SECRET` | webhook | **Set.** If removed, falls back to re-fetch-only verification |
| `RESEND_API_KEY` | all three | Rows save, no mail |
| `NOTIFICATION_EMAILS` | all three | Only the `notification_recipients` table is used; if that is empty too, staff are not told |
| `RESEND_FROM` | all three | Falls back to Resend's sandbox sender (403 to anyone but the account owner) |
| `SITE_URL` | checkout, webhook | Defaults to `https://pivotpointrecovery.org` |
| `DONOR_RECEIPTS` | webhook | Receipts on; set `0` to suppress |
| `ALLOWED_ORIGINS` | all three | Defaults to the production hosts + `*.pages.dev` + localhost |

Health-check every function at once:

```sh
for fn in public-forms donations-checkout donations-webhook; do
  echo -n "$fn: "
  curl -s "https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/$fn?health=1"; echo
done
```

`donations-checkout` also reports `"mode":"live"|"test"|"unset"`, so a test key
left in production is visible without exposing the key.

## Local development

No build step. Serve the directory over HTTP so root-relative paths resolve:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

`/donate` works from `localhost` — the checkout function's CORS allowlist
covers localhost and `*.pages.dev` previews alongside the production hosts. Use
a [Stripe test card](https://docs.stripe.com/testing) rather than a real one,
and note the deployed function is on **live** keys, so a gift made from a local
page is a real charge.

## Deployment

Cloudflare Pages, served from the repository root. `_headers` sets the security
and CSP policy; extend the CSP there if you add a new external asset host.

`img-src` is `https:` rather than a host allowlist because event photos are
pasted in at `/admin` by a non-technical editor, so their hosts cannot be known
in advance. `events.js` refuses any image URL that is not `https://`, which is
what keeps `data:`/`javascript:` URIs out of an attribute.

> **Error 1000 outage: resolved (verified 2026-08-20).** `https://pivotpointrecovery.org/`
> and `/donate` both return `200`. The apex no longer resolves to Cloudflare's
> own anycast addresses.

`/portal` still needs to reach the portal application — the footer "PPR Login"
link depends on it. `/api/*` does **not**: the donate page now calls the
Supabase function directly, so nothing on this host has to proxy an API any
more.
