/* ============================================================================
   Board Center — the workspace at /admin.
   Supabase Auth + PostgREST over plain fetch, so the site keeps its no build
   step, no dependencies shape and its CSP needs no extra script host.

   Access is decided in the database, not here. Hiding a nav item is a courtesy
   to the person using the page; the reason a board member cannot read a donor
   row is that Postgres refuses to send it. Never treat a check in this file as
   the thing keeping data safe.
   ========================================================================== */
(function () {
  'use strict';

  var AUTH = SUPABASE_URL + '/auth/v1';
  var REST = SUPABASE_URL + '/rest/v1';
  var SESSION_KEY = 'ppr_admin_session';
  var ADMIN_FN = SUPABASE_URL + '/functions/v1/admin-users';
  var RECONCILE_FN = SUPABASE_URL + '/functions/v1/donations-reconcile';
  var DIGEST_FN = SUPABASE_URL + '/functions/v1/board-digest';
  var NOT_ALLOWED = 'Nothing was saved — your account is not allowed to make that change. Ask Erica to check your access.';

  var session = null;
  var me = { email: '', roles: [], canGiving: false, canAdmin: false };
  var summary = null;
  var events = [];
  var rsvpRows = [];
  var rsvpEventTitle = '';
  var editingId = null;
  var view = 'dashboard';
  var sub = '';
  var cache = {};

  // ------------------------------------------------------------------ utils
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function money(cents) {
    return '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');
  }
  function days(n) {
    return Number(n) === 1 ? '1 day' : (Math.round(Number(n) * 10) / 10) + ' days';
  }
  function ago(iso) {
    if (!iso) return '—';
    var mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + ' minutes ago';
    var h = Math.floor(mins / 60);
    if (h < 24) return h === 1 ? 'an hour ago' : h + ' hours ago';
    var d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 30) return d + ' days ago';
    var mo = Math.floor(d / 30);
    return mo === 1 ? 'a month ago' : mo + ' months ago';
  }
  function whenLine(iso) {
    if (!iso) return 'Date not set';
    return new Date(iso).toLocaleString('en-US', {
      timeZone: EVENT_TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit' });
  }
  /** Today -- or the day of `when` -- where the organization is, as
   *  YYYY-MM-DD. The browser's UTC date is a day ahead every evening after
   *  8pm Eastern, which marked follow-ups overdue a day early and made
   *  "Spoken to today" record tomorrow. */
  function localDate(when) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: EVENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(when ? new Date(when) : new Date());
  }
  /** A calendar day for people: "Tue, Oct 6, 2026". */
  function dayLine(iso) {
    return new Date(iso).toLocaleDateString('en-US', {
      timeZone: EVENT_TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  /** A typed date as YYYY-MM-DD: '' for blank, null when it is not a date.
   *  Takes 2026-10-14 and 10/14/2026, the two ways people here write them. */
  function parseDay(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    var y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/))) {
      mo = +m[1]; d = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    } else return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // The funds on /donate. Older gifts carry only the slug, so the label comes
  // from here when the gift itself does not have one.
  var FUND_LABELS = {
    general: 'Where it’s needed most',
    'peer-support': 'Peer Recovery Support',
    reentry: 'Reentry & Reintegration',
    'veteran-mentorship': 'Veteran Mentorship',
    'family-community': 'Family & Community',
  };
  /** The fund as the donor saw it on the page, rather than its slug. */
  function fundName(r) {
    return (r.metadata && r.metadata.fund_label) || fundLabel(r.fund_designation);
  }
  function fundLabel(slug) {
    return FUND_LABELS[slug] || slug || FUND_LABELS.general;
  }
  // The same test the receipt function applies (supabase/functions/_shared/
  // validate.ts), so the page can say up front that a receipt cannot go.
  var EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;
  /** Stripe's billing address on one line. */
  function addressLine(a) {
    if (!a || typeof a !== 'object') return '';
    var region = [a.state, a.postal_code].filter(Boolean).join(' ');
    return [a.line1, a.line2, [a.city, region].filter(Boolean).join(', '),
      a.country && a.country !== 'US' ? a.country : ''].filter(Boolean).join(', ');
  }
  function showToast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + (type || 'success') + ' show';
    setTimeout(function () { t.classList.remove('show'); }, 4500);
  }
  function initials(nameOrEmail) {
    var parts = String(nameOrEmail || '').split('@')[0]
      .split(/[^A-Za-z]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  // --------------------------------------------------------------- session
  function loadSession() {
    try { var raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; }
    catch (err) { return null; }
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (err) { /* private browsing: this tab only */ }
  }
  async function refresh() {
    try {
      var res = await fetch(AUTH + '/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) { saveSession(null); return false; }
      var data = await res.json();
      saveSession({ access_token: data.access_token, refresh_token: data.refresh_token,
                    email: (data.user && data.user.email) || session.email });
      return true;
    } catch (err) { return false; }
  }
  async function authFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, opts.headers || {});
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    // One transparent refresh, so a returning editor is not bounced to the
    // login screen just because an hour passed.
    if (res.status === 401 && session && session.refresh_token && !opts._retried) {
      if (await refresh()) return await authFetch(path, Object.assign({}, opts, { _retried: true }));
    }
    return res;
  }

  // ------------------------------------------------------------------- api
  async function get(path) {
    var res = await authFetch(REST + path);
    if (!res.ok) throw new Error('Could not load that. Please try again.');
    return await res.json();
  }
  async function rpc(fn, body) {
    var res = await authFetch(REST + '/rpc/' + fn, { method: 'POST', body: JSON.stringify(body || {}) });
    if (!res.ok) throw new Error('Could not load that. Please try again.');
    return await res.json();
  }
  /** PostgREST answers an UPDATE or DELETE that RLS filtered out with 204 and no
   *  rows -- indistinguishable from success unless the affected rows are asked
   *  for. Without this, someone whose access was revoked would be told "Saved"
   *  while nothing was written. */
  async function writeRows(path, method, body) {
    var res = await authFetch(path, {
      method: method,
      headers: { Prefer: 'return=representation' },
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      var err = data || {};
      if (err.code === '23505') {
        throw new Error(path.indexOf('/events') !== -1
          ? 'Another event already uses that web address name. Change it under Advanced.'
          : 'Something with that name or reference already exists. Try a different one.');
      }
      if (res.status === 401 || res.status === 403 || err.code === '42501') throw new Error(NOT_ALLOWED);
      // Class 22 is "data exception": a date or number Postgres cannot read.
      // Its own wording ("invalid input syntax for type date") means nothing
      // to the person who typed it.
      if (/^22/.test(err.code || '')) {
        throw new Error('Nothing was saved — one of the values is not in a form the database understands. ' +
          'Check any dates and numbers.');
      }
      throw new Error(err.message || 'That did not save. Please try again.');
    }
    if (Array.isArray(data) && data.length === 0) throw new Error(NOT_ALLOWED);
    return data;
  }
  /** The one endpoint that is not PostgREST. It holds the service-role key,
   *  so everything it does is gated on the database's own answer to
   *  has_role('admin') -- see the function's own header. */
  async function callAdminFn(body) {
    var res = await authFetch(ADMIN_FN, { method: 'POST', body: JSON.stringify(body) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'That did not work. Please try again.');
    }
    return data;
  }

  /** Fire and forget: a failed audit write must never block the work itself,
   *  but it is logged to the console so a systematic failure is findable. */
  function logActivity(action, entity, id, detail) {
    authFetch(REST + '/rpc/log_activity', {
      method: 'POST',
      body: JSON.stringify({ p_action: action, p_entity: entity, p_entity_id: id || null, p_detail: detail || {} }),
    }).catch(function (e) { console.warn('activity log failed', e); });
  }

  // ------------------------------------------------------------------- nav
  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/>',
    enquiries: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.6 6.5 8.4 6 8.4-6"/>',
    people: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.2 2.5-5.2 5.5-5.2s5.5 2 5.5 5.2"/><path d="M16 5.5a3 3 0 0 1 0 5.6"/><path d="M17.5 14.6c2 .7 3.2 2.4 3.2 4.4"/>',
    events: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    giving: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.5 10h5M9.5 14h5"/>',
    boardroom: '<path d="M3 20h18"/><path d="M5 20V9l7-5 7 5v11"/><path d="M10 20v-6h4v6"/>',
    activity: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  };
  var NAV = [
    { group: 'Overview', items: [
      { id: 'dashboard', label: 'Dashboard' },
    ] },
    { group: 'Who we know', items: [
      { id: 'people', label: 'People' },
    ] },
    { group: 'Programs', items: [
      { id: 'events', label: 'Events' },
      { id: 'giving', label: 'Giving' },
    ] },
    { group: 'The board', items: [
      { id: 'boardroom', label: 'Board room' },
      { id: 'activity', label: 'Activity log', admin: true },
    ] },
  ];
  var SUBS = {
    people: [
      { id: 'contacts',   label: 'Contacts' },
      { id: 'volunteers', label: 'Volunteers' },
      { id: 'intake',     label: 'Intake' },
      { id: 'team',       label: 'Team & access' },
    ],
    boardroom: [
      { id: 'documents', label: 'Documents' },
    ],
  };

  function renderNav() {
    $('bcNav').innerHTML = NAV.map(function (g) {
      var items = g.items.filter(function (it) { return !it.admin || me.canAdmin; });
      if (!items.length) return '';
      return '<div class="bc-navgroup"><p>' + esc(g.group) + '</p>' + items.map(function (it) {
        var badge = '';
        if (it.id === 'people' && summary && summary.enquiries.unanswered > 0) {
          badge = '<span class="count">' + summary.enquiries.unanswered + '</span>';
        }
        return '<button class="bc-navitem" data-view="' + it.id + '"' +
          (view === it.id ? ' aria-current="page"' : '') + '>' +
          '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[it.id] || '') + '</svg>' +
          '<span>' + esc(it.label) + '</span>' + badge + '</button>';
      }).join('') + '</div>';
    }).join('');
  }

  // ------------------------------------------------------------- fragments
  function head(title, subtitle, actions) {
    return '<div class="bc-head"><div><h1>' + esc(title) + '</h1>' +
      (subtitle ? '<p class="sub">' + subtitle + '</p>' : '') + '</div>' +
      (actions ? '<div class="bc-actions">' + actions + '</div>' : '') + '</div>';
  }
  function tabs(group) {
    var list = SUBS[group] || [];
    if (list.length < 2) return '';
    return '<div class="bc-tabs">' + list.map(function (t) {
      return '<button class="bc-tab" data-sub="' + t.id + '"' +
        (sub === t.id ? ' aria-current="true"' : '') + '>' + esc(t.label) + '</button>';
    }).join('') + '</div>';
  }
  function tile(lab, big, foot, alert) {
    return '<div class="bc-tile' + (alert ? ' alert' : '') + '"><p class="lab">' + esc(lab) + '</p>' +
      '<p class="big">' + esc(big) + '</p><p class="foot">' + (foot || '') + '</p></div>';
  }
  function card(title, note, body, actions) {
    return '<section class="bc-card"><div class="bc-cardhead"><h2>' + esc(title) + '</h2>' +
      (note ? '<p class="note">' + note + '</p>' : '') + (actions || '') + '</div>' + body + '</section>';
  }
  function table(headRow, bodyRows, emptyMsg) {
    if (!bodyRows) return '<p class="bc-none">' + esc(emptyMsg || 'Nothing here yet.') + '</p>';
    // Focusable so a keyboard can scroll a table wider than the screen.
    return '<div class="bc-scroll" tabindex="0"><table class="bc-table"><thead><tr>' + headRow +
      '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
  }
  var STAGE_STYLE = {
    new: 'new', contacted: 'info', referred: 'ok', closed: 'flat',
    screened: 'info', onboarding: 'info', active: 'ok', inactive: 'flat',
    awaiting_contact: 'new', in_assessment: 'info', enrolled: 'ok',
    succeeded: 'ok', pending: 'warn', failed: 'stop', processing: 'info', expired: 'flat',
  };
  var STAGE_LABEL = {
    new: 'New', contacted: 'Contacted', referred: 'Referred', closed: 'Closed',
    screened: 'Screened', onboarding: 'Onboarding', active: 'Active', inactive: 'Inactive',
    awaiting_contact: 'Awaiting contact', in_assessment: 'In assessment', enrolled: 'Enrolled',
    // A gift's status is Stripe's word for it; these are what it means here.
    succeeded: 'Received', pending: 'Waiting on Stripe', processing: 'Clearing',
    failed: 'Failed', expired: 'Not completed',
  };
  function stagePill(s) {
    var key = String(s || 'new').toLowerCase();
    return '<span class="bc-pill ' + (STAGE_STYLE[key] || 'flat') + '">' +
      esc(STAGE_LABEL[key] || s || 'New') + '</span>';
  }
  /** The record's name as a real button: rows open on click anywhere, and
   *  this is what makes them reachable from the keyboard too. */
  function rowLink(kind, id, inner) {
    return '<button type="button" class="nm bc-rowlink" data-drawer="' + kind + '" data-id="' + esc(id) + '">' +
      inner + '</button>';
  }
  function owner(email) {
    return email
      ? '<span style="font-size:.85rem;color:var(--color-text-mid)">' + esc(String(email).split('@')[0]) + '</span>'
      : '<span style="font-size:.85rem;color:var(--bc-stop-fg);font-weight:600">Nobody</span>';
  }
  function hbars(rows, totalLabel, totalValue) {
    var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
    return '<div class="bc-hbars">' + rows.map(function (r) {
      return '<div class="bc-hbar"><span>' + esc(r.f) + '</span><div class="track">' +
        '<div class="fill" style="width:' + Math.round(r.v / max * 100) + '%"></div></div>' +
        '<span class="v">' + esc(r.label) + '</span></div>';
    }).join('') + (totalLabel
      ? '<div class="bc-hbar total"><span style="font-weight:600">' + esc(totalLabel) +
        '</span><span></span><span class="v">' + esc(totalValue) + '</span></div>'
      : '') + '</div>';
  }

  // ----------------------------------------------------------------- views
  var V = {};

  V.dashboard = function () {
    var s = summary;
    var tiles = tile('Unanswered enquiries', String(s.enquiries.unanswered),
        s.enquiries.oldest_unanswered
          ? 'Oldest arrived <strong>' + esc(ago(s.enquiries.oldest_unanswered)) + '</strong>'
          : 'Nothing waiting',
        s.enquiries.unanswered > 0) +
      tile('Volunteer sign-ups', String(s.volunteers.total),
        s.volunteers.unscreened + ' waiting to be screened') +
      tile('Intake open', String(s.intake.open),
        s.intake.median_days_to_contact != null
          ? 'Median first contact <strong>' + esc(days(s.intake.median_days_to_contact)) + '</strong>'
          : 'No response times recorded yet') +
      tile('Given this month', money(s.giving.month_cents),
        s.giving.gift_count + (s.giving.gift_count === 1 ? ' gift' : ' gifts') +
        ' · ' + money(s.giving.year_cents) + ' this year');

    var attn = [];
    if (s.enquiries.unanswered > 0) {
      attn.push({ k: 'crit', sev: 'Needs action',
        t: s.enquiries.unanswered + (s.enquiries.unanswered === 1 ? ' enquiry has' : ' enquiries have') + ' had no reply',
        s: 'Somebody asked for help through the contact form',
        w: ago(s.enquiries.oldest_unanswered), go: 'people', goSub: 'contacts' });
    }
    if (s.intake.overdue > 0) {
      attn.push({ k: 'crit', sev: 'Needs action',
        t: s.intake.overdue + ' intake follow-' + (s.intake.overdue === 1 ? 'up is' : 'ups are') + ' overdue',
        s: 'Past the follow-up date on the queue', w: 'overdue', go: 'people', goSub: 'intake' });
    }
    if (s.volunteers.unscreened > 0) {
      attn.push({ k: 'warn', sev: 'Watch',
        t: s.volunteers.unscreened + ' volunteer sign-' + (s.volunteers.unscreened === 1 ? 'up is' : 'ups are') + ' unscreened',
        s: 'Nobody has been in touch with them yet', w: '', go: 'people', goSub: 'volunteers' });
    }
    if (s.giving.failed > 0) {
      attn.push({ k: 'warn', sev: 'Watch',
        t: plural(s.giving.failed, 'payment', 'payments') + ' failed this month',
        s: 'A card was declined or a monthly gift did not go through', w: '', go: 'giving' });
    }
    // Somebody opened Stripe's page and left. Not a failure -- nothing was
    // charged -- but sometimes worth a friendly note.
    if (s.giving.unfinished > 0) {
      attn.push({ k: '', sev: 'For info',
        t: plural(s.giving.unfinished, 'gift was', 'gifts were') + ' started but not finished this month',
        s: 'The donor reached the payment page and left without paying', w: '', go: 'giving' });
    }
    // Every gift is checked against Stripe every 15 minutes, and an abandoned
    // checkout expires after a day -- so anything still waiting past that means
    // the check itself has stopped, which is how gifts went missing before.
    var oldestWait = s.giving.oldest_pending
      ? (Date.now() - new Date(s.giving.oldest_pending).getTime()) / 3600000 : 0;
    if (s.giving.pending_count > 0 && oldestWait > 26) {
      attn.push({ k: 'crit', sev: 'Needs action',
        t: 'Gifts have been waiting on Stripe for over a day',
        s: 'The automatic check against Stripe may not be running — ask whoever looks after the website',
        w: ago(s.giving.oldest_pending), go: 'giving' });
    }
    if (s.events.drafts > 0) {
      attn.push({ k: '', sev: 'For info',
        t: plural(s.events.drafts, 'event is', 'events are') + ' still a draft',
        s: 'Not visible on the website yet', w: '', go: 'events' });
    }
    if (!attn.length) {
      attn.push({ k: '', sev: 'All clear', t: 'Nothing is waiting on anybody',
        s: 'Every enquiry has a reply and no follow-up is overdue', w: '', go: null });
    }

    var next = s.events.next;
    var right = next
      ? card('Next event', null, '<div class="bc-pad" style="display:flex;flex-direction:column;gap:.5rem">' +
          '<h3 style="font-family:var(--font-display);font-size:1.1rem;text-transform:uppercase;margin:0">' +
          esc(next.title) + '</h3>' +
          '<p style="font-size:.88rem;color:var(--color-text-mid);margin:0">' + esc(whenLine(next.starts_at)) + '</p>' +
          '<p style="font-size:.85rem;color:var(--bc-ink-soft);margin:0">' + next.rsvps +
          (next.rsvps === 1 ? ' RSVP' : ' RSVPs') + ' so far</p>' +
          '<div class="bc-actions" style="margin-top:.3rem">' +
          '<button class="btn btn-outline btn-small" data-view="events">Open events</button></div></div>')
      : card('Next event', null, '<p class="bc-none">No published event is coming up. ' +
          'Add one under Events.</p>');

    var funds = (s.giving.by_fund || []).map(function (f) {
      return { f: fundLabel(f.fund), v: Number(f.cents), label: money(Number(f.cents)) };
    });

    return head('This week', 'Signed in as ' + esc(me.email) + '.',
        // The same list goes to the team by email every Monday morning.
        me.canAdmin ? '<button class="btn btn-outline btn-small" data-digest-preview="1">' +
          'Email me the Monday summary</button>' : '') +
      '<div class="bc-grid bc-g4">' + tiles + '</div>' +
      '<div class="bc-split"><div style="display:flex;flex-direction:column;gap:1rem">' +
      card('Needs a person', 'Most urgent first', '<div class="bc-attn">' + attn.map(function (a) {
        var pill = a.k === 'crit' ? '<span class="bc-pill stop">' + esc(a.sev) + '</span>'
                 : a.k === 'warn' ? '<span class="bc-pill warn">' + esc(a.sev) + '</span>'
                 : '<span class="bc-pill flat">' + esc(a.sev) + '</span>';
        return '<button class="bc-attnrow ' + a.k + '"' +
          (a.go ? ' data-view="' + a.go + '"' + (a.goSub ? ' data-gosub="' + a.goSub + '"' : '') : '') + '>' +
          '<span class="bar"></span><span class="b"><b>' + esc(a.t) + '</b><span>' + esc(a.s) + '</span></span>' +
          '<span class="when">' + pill + (a.w ? '<span>' + esc(a.w) + '</span>' : '') + '</span></button>';
      }).join('') + '</div>') + '</div><div style="display:flex;flex-direction:column;gap:1rem">' +
      right +
      (funds.length
        ? card('Giving by fund', 'This month', hbars(funds, 'Total', money(s.giving.month_cents)))
        : card('Giving by fund', 'This month', '<p class="bc-none">No gifts recorded this month.</p>')) +
      '</div></div>';
  };

  /** Contact-form submissions. No longer a section of its own -- they are the
   *  same thing as an intake enquiry from the organization's point of view, so
   *  they sit above the intake queue under People. */
  function enquiriesCard() {
    var rows = cache.enquiries || [];
    var waiting = rows.filter(function (r) { return (r.status || 'new') === 'new'; }).length;
    return card('People who wrote in',
      rows.length + (rows.length === 1 ? ' enquiry' : ' enquiries') +
      (waiting ? ' · <strong style="color:var(--bc-stop-fg)">' + waiting + ' with no reply yet</strong>' : ''),
      table('<th>Person</th><th>About</th><th>Stage</th><th>Owner</th><th>Received</th>',
        rows.length ? rows.map(function (r) {
          return '<tr class="click" data-drawer="enquiry" data-id="' + esc(r.id) + '">' +
            '<td>' + rowLink('enquiry', r.id, esc(r.name || 'No name given')) +
            '<span class="sc">' + esc(r.email || '') + '</span></td>' +
            '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.interest || '—') + '</td>' +
            '<td>' + stagePill(r.status) + '</td><td>' + owner(r.owner_email) + '</td>' +
            '<td class="ago">' + esc(ago(r.created_at)) + '</td></tr>';
        }).join('') : '',
        'Nobody has used the contact form yet. When somebody does, they appear here.'),
      '<button class="btn btn-outline btn-small" data-export="enquiries">Download as spreadsheet</button>');
  }

  V.people = function () {
    if (sub === 'volunteers') return peopleVolunteers();
    if (sub === 'intake') return peopleIntake();
    if (sub === 'team') return peopleTeam();
    return peopleContacts();
  };

  function peopleContacts() {
    return head('People', 'Everyone who has given us their details through the website.') +
      tabs('people') +
      enquiriesCard() +
      '<div class="bc-gate"><h2>Newsletter sign-ups will land here too</h2>' +
      '<p>There is no newsletter sign-up anywhere on the website yet, so there is nothing to collect. ' +
      'Once one exists, its sign-ups appear in this list alongside the contact form, marked by where ' +
      'they came from.</p></div>';
  }

  function peopleVolunteers() {
    var rows = cache.volunteers || [];
    return head('People', 'Volunteer sign-ups and where each person has got to.',
        '<button class="btn btn-outline btn-small" data-export="volunteers">Download as spreadsheet</button>') +
      tabs('people') +
      card('Volunteer sign-ups', rows.length + (rows.length === 1 ? ' person' : ' people'),
        table('<th>Person</th><th>Town</th><th>Interests</th><th>Availability</th><th>Stage</th><th>Owner</th>',
          rows.length ? rows.map(function (r) {
            var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'No name given';
            return '<tr class="click" data-drawer="volunteer" data-id="' + esc(r.id) + '">' +
              '<td>' + rowLink('volunteer', r.id, esc(name)) + '<span class="sc">' + esc(r.email || '') + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.city || '—') + '</td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc((r.interests || []).join(', ') || '—') + '</td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.availability || '—') + '</td>' +
              '<td>' + stagePill(r.status) + '</td><td>' + owner(r.owner_email) + '</td></tr>';
          }).join('') : '', 'No volunteer sign-ups yet.'));
  }

  function peopleIntake() {
    var rows = cache.intake || [];
    var today = localDate();
    var overdue = rows.filter(function (r) {
      return r.stage !== 'closed' && r.follow_up_due && r.follow_up_due < today;
    }).length;
    return head('People', 'The intake work queue — reference numbers, stages and follow-up dates.',
        '<button class="btn btn-primary btn-small" data-intake-new="1">+ Add to the queue</button>') +
      tabs('people') +
      '<div class="bc-grid bc-g4">' +
        tile('Open', String(rows.filter(function (r) { return r.stage !== 'closed'; }).length), 'Not yet closed') +
        tile('Overdue follow-ups', String(overdue), overdue ? 'Past the date on the queue' : 'All on time', overdue > 0) +
        tile('Enrolled', String(rows.filter(function (r) { return r.stage === 'enrolled'; }).length), 'All time') +
        tile('Median first contact',
          summary.intake.median_days_to_contact != null ? days(summary.intake.median_days_to_contact) : '—',
          'Last 90 days, against a 1–2 day promise') +
      '</div>' +
      '<div class="bc-gate"><h2>No intake answers are stored here, by design</h2>' +
      '<p>Intake responses are protected under 42 CFR Part 2 and HIPAA and stay in the system that collects ' +
      'them. This queue holds a reference number, a stage and a follow-up date — enough to run the work and to ' +
      'tell the board how fast we answer, and no part of anybody&rsquo;s story.</p></div>' +
      card('The queue', rows.length + (rows.length === 1 ? ' entry' : ' entries'),
        table('<th>Reference</th><th>Received</th><th>Stage</th><th>Owner</th><th>Follow-up due</th>',
          rows.length ? rows.map(function (r) {
            var late = r.stage !== 'closed' && r.follow_up_due && r.follow_up_due < today;
            return '<tr class="click" data-drawer="intake" data-id="' + esc(r.id) + '">' +
              '<td>' + rowLink('intake', r.id, '<span style="font-variant-numeric:tabular-nums">' + esc(r.ref) + '</span>') + '</td>' +
              '<td class="ago">' + esc(ago(r.received_at)) + '</td>' +
              '<td>' + stagePill(r.stage) + '</td><td>' + owner(r.owner_email) + '</td>' +
              '<td style="font-size:.85rem;' + (late ? 'color:var(--bc-stop-fg);font-weight:600' : 'color:var(--color-text-mid)') + '">' +
              esc(r.follow_up_due || '—') + '</td></tr>';
          }).join('') : '',
          'The queue is empty. Add an entry each time an intake form comes in.'));
  }

  /** What a set of roles amounts to, in the words the page uses. */
  function accessPills(roles) {
    roles = roles || [];
    var giving = roles.indexOf('finance') !== -1;
    return '<span class="bc-pill info" style="margin-right:.2rem">' +
        (giving ? 'Everything' : 'Everything but giving') + '</span>' +
      (roles.indexOf('admin') !== -1
        ? '<span class="bc-pill warn" style="margin-right:.2rem">Manage access</span>' : '');
  }
  /** "Erica and Steve": the active people holding a role, by first name. */
  function whoHas(role) {
    var names = (cache.team || []).filter(function (t) {
      return t.active && (t.roles || []).indexOf(role) !== -1;
    }).map(function (t) {
      return String(t.label || t.email.split('@')[0]).split(/\s+[–—-]\s+/)[0];
    });
    if (!names.length) return 'nobody yet';
    return names.length === 1 ? names[0]
      : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function peopleTeam() {
    var rows = cache.team || [];
    return head('People', 'Everyone who can sign in, and what each of them can see.',
        me.canAdmin ? '<button class="btn btn-primary btn-small" data-team-new="1">+ Invite someone</button>' : '') +
      tabs('people') +
      card('People with access', rows.length + (rows.length === 1 ? ' account' : ' accounts'),
        table('<th>Person</th><th>Can see</th><th>Status</th>' + (me.canAdmin ? '<th>Account</th>' : ''),
          rows.length ? rows.map(function (r) {
            var name = esc(r.label || r.email);
            // No row-wide click here: the row's own buttons (Password, Switch
            // off) would open the drawer instead of doing their job.
            return '<tr><td>' + (me.canAdmin ? rowLink('person', r.id, name) : '<span class="nm">' + name + '</span>') +
              '<span class="sc">' + esc(r.email) + '</span></td>' +
              '<td>' + accessPills(r.roles) + '</td>' +
              '<td>' + (r.active ? '<span class="bc-pill ok">Active</span>' : '<span class="bc-pill flat">Switched off</span>') + '</td>' +
              (me.canAdmin
                ? '<td class="r" style="white-space:nowrap">' +
                  '<button class="btn btn-blue btn-small" data-drawer="person" data-id="' + esc(r.id) + '">Access</button> ' +
                  '<button class="btn btn-outline btn-small" data-team-password="' + esc(r.email) + '">Password</button> ' +
                  // Switching yourself off locks you out with nobody to let
                  // you back in, so your own row does not offer it.
                  (String(r.email).toLowerCase() === me.jwtEmail
                    ? '<span style="font-size:.82rem;color:var(--bc-ink-soft);padding:0 .6rem">That’s you</span>'
                    : '<button class="btn btn-ghost btn-small" data-team-toggle="' + esc(r.id) + '" ' +
                      'data-active="' + (r.active ? '1' : '0') + '" data-label="' + esc(r.label || r.email) + '">' +
                      (r.active ? 'Switch off' : 'Switch on') + '</button>') + '</td>'
                : '') + '</tr>';
          }).join('') : '', 'Nobody yet.')) +
      (me.canAdmin
        ? '<div class="bc-gate"><h2>Giving is limited to ' + esc(whoHas('finance')) + '</h2><p>Everyone invited ' +
          'sees everything else — enquiries, volunteers, the intake queue, events and documents. ' +
          '<em>Giving</em> adds donor names, contact details, amounts and notes, so keep it with the people who ' +
          'acknowledge gifts and reconcile the bank unless the board decides otherwise. Choose ' +
          '<strong>Access</strong> on anybody’s row to change what they can see.</p></div>'
        : '');
  }

  V.giving = function () {
    var s = summary;
    var funds = (s.giving.by_fund || []).map(function (f) {
      return { f: fundLabel(f.fund), v: Number(f.cents), label: money(Number(f.cents)) };
    });
    var unfinished = s.giving.unfinished || 0;
    var tiles = '<div class="bc-grid bc-g4">' +
      tile('This month', money(s.giving.month_cents), plural(s.giving.gift_count, 'gift', 'gifts')) +
      tile('This year', money(s.giving.year_cents), 'Since 1 January') +
      tile('Recurring donors', String(s.giving.recurring), 'Monthly gifts on file') +
      tile('Failed payments', String(s.giving.failed),
        s.giving.failed ? 'Worth a nudge'
          : unfinished ? plural(unfinished, 'checkout', 'checkouts') + ' started and not finished'
          : 'None this month', s.giving.failed > 0) +
      '</div>';

    if (!me.canGiving) {
      return head('Giving', 'Totals and the fund split.') + tiles +
        '<div class="bc-split"><div>' +
        (funds.length ? card('By fund', 'This month', hbars(funds, 'Total', money(s.giving.month_cents)))
                      : card('By fund', 'This month', '<p class="bc-none">No gifts recorded this month.</p>')) +
        '</div><div><div class="bc-gate"><h2>Donor names are limited to ' + esc(whoHas('finance')) + '</h2>' +
        '<p>Who gave and how much stays with the executive director and the treasurer, who acknowledge gifts ' +
        'and reconcile the bank. The totals above are the same ones they see, and are what the board reports ' +
        'on.</p><p style="font-size:.83rem;color:var(--bc-ink-soft)">Enforced in the database, not by hiding ' +
        'this page — the donor rows are never sent to your browser.</p></div></div></div>';
    }

    var rows = cache.gifts || [];
    var owed = rows.filter(function (r) { return r.status === 'succeeded' && !r.receipt_sent_at; });
    return head('Giving', 'Every gift, and every attempt that did not complete. Open one for the donor’s details.',
        '<button class="btn btn-outline btn-small" data-export="gifts">Download as spreadsheet</button>') + tiles +
      (owed.length
        ? '<div class="bc-gate"><h2>' + owed.length + (owed.length === 1 ? ' gift has' : ' gifts have') +
          ' no receipt yet</h2><p>The donor has not been sent their tax acknowledgement — usually because the ' +
          'gift was found after the fact rather than recorded as it happened. Open each one to send it. A donor ' +
          'who gave $250 or more needs it to claim the deduction.</p></div>'
        : '') +
      card('Recent gifts', rows.length + ' shown',
        table('<th>Donor</th><th>Fund</th><th>Type</th><th>Amount</th><th>Status</th>',
          rows.length ? rows.map(function (r) {
            return '<tr class="click" data-drawer="gift" data-id="' + esc(r.id) + '">' +
              '<td>' + rowLink('gift', r.id, esc(r.donor_name || 'Anonymous') +
              (r.donor_note ? ' <span class="bc-pill info" title="Left a note">Note</span>' : '')) +
              '<span class="sc">' + esc([r.donor_email, ago(r.created_at)].filter(Boolean).join(' · ')) + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(fundName(r)) + '</td>' +
              '<td><span class="bc-pill flat">' + (r.is_recurring ? 'Monthly' : 'One-time') + '</span></td>' +
              '<td class="r" style="font-weight:600">' + esc(money(r.amount_cents)) + '</td>' +
              '<td>' + stagePill(r.status) + '</td></tr>';
          }).join('') : '', 'No gifts recorded yet.')) +
      (funds.length ? card('By fund', 'This month', hbars(funds, 'Total', money(s.giving.month_cents)))
                    : card('By fund', 'This month', '<p class="bc-none">No gifts this month.</p>'));
  };

  V.boardroom = function () {
    var rows = cache.documents || [];
    // The shared drive is the thing people actually want, so it gets its own
    // card at the top rather than being one row in a list.
    var drives = rows.filter(function (r) { return r.category === 'Shared drive'; });
    var byCat = {};
    rows.filter(function (r) { return r.category !== 'Shared drive'; })
        .forEach(function (r) { (byCat[r.category || 'General'] = byCat[r.category || 'General'] || []).push(r); });
    var cats = Object.keys(byCat).sort();

    var driveCard = drives.length
      ? '<section class="bc-card"><div class="bc-cardhead"><h2>Shared drive</h2>' +
        '<p class="note">Everything the team works on, in Google Drive</p></div>' +
        '<div class="bc-pad" style="display:flex;flex-direction:column;gap:.75rem">' +
        drives.map(function (d) {
          return '<div style="display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;' +
            'justify-content:space-between">' +
            '<div style="min-width:0"><p style="font-weight:600;margin:0">' + esc(d.label) + '</p>' +
            '<p style="font-size:.82rem;color:var(--bc-ink-soft);margin:0">' +
            'Upload and download happen in Drive itself</p></div>' +
            '<a class="btn btn-primary btn-small" href="' + esc(d.url) + '" target="_blank" ' +
            'rel="noopener">Open the shared drive</a></div>';
        }).join('') +
        '<p style="font-size:.83rem;color:var(--color-text-mid);margin:0;border-top:1px solid ' +
        'var(--color-light);padding-top:.7rem">Who can add files is set in Drive, not here. ' +
        'If somebody can open the folder but not upload to it, their Drive access needs to be ' +
        '<strong>Editor</strong> rather than Viewer.</p></div></section>'
      : '';

    return head('Board room', 'Papers and files the board needs, kept in Drive.',
        '<button class="btn btn-primary btn-small" data-doc-new="1">+ Add a link</button>') +
      tabs('boardroom') + driveCard +
      (cats.length ? cats.map(function (c) {
        return card(c, byCat[c].length + (byCat[c].length === 1 ? ' item' : ' items'),
          table('<th>Name</th><th>Added by</th><th>Added</th>' +
              (me.canAdmin ? '<th><span class="bc-sr">Actions</span></th>' : ''),
            byCat[c].map(function (r) {
              return '<tr><td><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
                esc(r.label) + '</a>' + (r.is_folder ? ' <span class="bc-pill flat">Folder</span>' : '') + '</td>' +
                '<td style="font-size:.85rem;color:var(--color-text-mid)">' +
                esc(String(r.added_by || '').split('@')[0] || '—') + '</td>' +
                '<td class="ago">' + esc(ago(r.created_at)) + '</td>' +
                (me.canAdmin
                  ? '<td class="r"><button class="btn btn-ghost btn-small admin-danger" data-doc-del="' +
                    esc(r.id) + '">Remove</button></td>' : '') + '</tr>';
            }).join('')));
      }).join('') : (drives.length ? '' : card('Documents', null, '<p class="bc-none">No links yet. ' +
          'Add a link to a Drive folder or file and it appears here for everyone on the team.</p>'))) +
      '<div class="bc-gate"><h2>These are links, not copies</h2><p>Files stay in Drive, so Google keeps ' +
      'doing the sharing, version history and virus scanning, and no board paper ends up in a second place ' +
      'you have to secure. Nothing is uploaded through this page.</p>' +
      '<p style="font-size:.83rem;color:var(--bc-ink-soft)">One thing worth checking in Google: a folder ' +
      'held in somebody&rsquo;s personal My Drive belongs to them and goes with them if they leave. A ' +
      '<strong>shared drive</strong> belongs to the organization instead.</p></div>';
  };

  V.activity = function () {
    var rows = cache.activity || [];
    return head('Activity log', 'Every change, and every look at a record somebody trusted us with.') +
      card('Recent activity', rows.length + ' most recent',
        table('<th>Who</th><th>Did what</th><th>To</th><th>When</th>',
          rows.length ? rows.map(function (r) {
            return '<tr><td><span class="nm">' + esc(String(r.actor_email || '').split('@')[0]) + '</span></td>' +
              '<td><span class="bc-pill ' + (r.action === 'read' || r.action === 'open' ? 'info' : r.action === 'delete' ? 'stop' : 'flat') +
              '">' + esc(r.action) + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.entity) +
              (r.entity_id ? ' <span style="color:var(--bc-ink-soft)">' + esc(String(r.entity_id).slice(0, 8)) + '</span>' : '') + '</td>' +
              '<td class="ago">' + esc(ago(r.at)) + '</td></tr>';
          }).join('') : '', 'Nothing logged yet.'));
  };

  // ------------------------------------------------------------ event list
  V.events = function () {
    return head('Events', 'Tick published and it appears on the website. RSVPs are under each event.',
        '<button class="btn btn-primary btn-small" id="newEventBtn">+ Add an event</button>') +
      '<div id="eventList"></div>';
  };

  function formatWhen(ev) {
    if (ev.when_text) return ev.when_text;
    if (!ev.starts_at) return '';
    var d = new Date(ev.starts_at);
    return d.toLocaleString('en-US', {
      timeZone: EVENT_TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit' });
  }

  function renderEvents() {
    var list = $('eventList');
    if (!list) return;
    if (!events.length) {
      list.innerHTML = '<div class="bc-card"><p class="bc-none">No events yet. ' +
        'Choose <strong>Add an event</strong> to create the first one.</p></div>';
      return;
    }
    list.innerHTML = events.map(function (ev) {
      var when = formatWhen(ev) || 'Date not set';
      var where = [ev.location_name, ev.city].filter(Boolean).join(' · ');
      var count = (ev.rsvp_count == null) ? '' : ' (' + ev.rsvp_count + ')';
      return '<div class="admin-card">' +
        '<h2>' + esc(ev.title || 'Untitled') +
          '<span class="admin-pill ' + (ev.published ? 'live' : 'draft') + '">' +
          (ev.published ? 'Published' : 'Draft') + '</span></h2>' +
        '<p class="admin-meta">' + esc(when) + (where ? ' — ' + esc(where) : '') + '</p>' +
        '<div class="admin-actions">' +
          '<button class="btn btn-blue btn-small" data-edit="' + esc(ev.id) + '">Edit</button>' +
          '<button class="btn btn-outline btn-small" data-rsvps="' + esc(ev.id) + '">RSVPs' + count + '</button>' +
          '<button class="btn btn-outline btn-small" data-publish="' + esc(ev.id) + '">' +
            (ev.published ? 'Unpublish' : 'Publish') + '</button>' +
          (ev.detail_url ? '' : '<a class="btn btn-ghost btn-small" href="/event?slug=' +
            encodeURIComponent(ev.slug || '') + '" target="_blank" rel="noopener">Preview</a>') +
          '<button class="btn btn-ghost btn-small admin-danger" data-delete="' + esc(ev.id) + '">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function findEvent(id) {
    return events.filter(function (ev) { return ev.id === id; })[0];
  }

  async function togglePublished(id) {
    var ev = findEvent(id);
    if (!ev) return;
    if (!ev.published && !ev.slug) { showToast('Add a name and save before publishing.', 'error'); return; }
    try {
      await writeRows(REST + '/events?id=eq.' + encodeURIComponent(id), 'PATCH',
        { published: !ev.published, updated_by: session.email });
    } catch (err) { showToast(err.message, 'error'); return; }
    logActivity('update', 'events', id, { published: !ev.published });
    showToast(ev.published ? 'Taken off the website.' : 'Published — it is live now.', 'success');
    await loadEvents();
  }

  async function deleteEvent(id) {
    var ev = findEvent(id);
    if (!ev) return;
    if (!confirm('Delete "' + (ev.title || 'this event') + '"? RSVPs already received are kept, ' +
                 'but the event disappears from the website.')) return;
    try {
      await writeRows(REST + '/events?id=eq.' + encodeURIComponent(id), 'DELETE', null);
    } catch (err) { showToast(err.message, 'error'); return; }
    logActivity('delete', 'events', id, { title: ev.title });
    showToast('Event deleted.', 'success');
    $('editorCard').hidden = true;
    await loadEvents();
  }

  // ------------------------------------------------------------- the editor
  function slugify(text) {
    return String(text || '').toLowerCase().trim()
      .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80);
  }
  /** Eastern Time offset for a given date, so "6pm" means 6pm at the venue no
   *  matter which timezone the person filling this in happens to be in. */
  function etOffset(dateStr) {
    try {
      var probe = new Date(dateStr + 'T12:00:00Z');
      var label = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_TZ, timeZoneName: 'shortOffset' }).format(probe);
      var match = label.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (match) {
        return match[1] + ('0' + match[2]).slice(-2) + ':' + (match[3] || '00');
      }
    } catch (err) { /* fall through to the DST rule below */ }
    var d = new Date(dateStr + 'T12:00:00Z');
    var year = d.getUTCFullYear();
    var march = new Date(Date.UTC(year, 2, 1));
    var dstStart = new Date(Date.UTC(year, 2, 1 + ((7 - march.getUTCDay()) % 7) + 7));
    var november = new Date(Date.UTC(year, 10, 1));
    var dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - november.getUTCDay()) % 7)));
    return (d >= dstStart && d < dstEnd) ? '-04:00' : '-05:00';
  }
  function timestampFor(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    return dateStr + 'T' + timeStr + ':00' + etOffset(dateStr);
  }
  function splitTimestamp(iso) {
    if (!iso) return { date: '', time: '' };
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: EVENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(iso)).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return {
      date: parts.year + '-' + parts.month + '-' + parts.day,
      time: (parts.hour === '24' ? '00' : parts.hour) + ':' + parts.minute,
    };
  }
  var FIELDS = {
    fTitle: 'title', fTagline: 'tagline', fSummary: 'summary', fDescription: 'description',
    fWhenText: 'when_text', fLocation: 'location_name', fAddress: 'address', fCity: 'city',
    fState: 'state', fPostal: 'postal_code', fCost: 'cost_text', fImage: 'image_url',
    fSlug: 'slug', fDetailUrl: 'detail_url', fRsvpEmail: 'rsvp_email',
  };

  function openEditor(id) {
    editingId = id;
    var ev = id ? findEvent(id) : null;
    $('editorTitle').textContent = ev ? 'Edit event' : 'Add an event';
    Object.keys(FIELDS).forEach(function (fieldId) {
      $(fieldId).value = ev ? (ev[FIELDS[fieldId]] || '') : '';
    });
    var start = splitTimestamp(ev && ev.starts_at);
    var end = splitTimestamp(ev && ev.ends_at);
    $('fDate').value = start.date;
    $('fStart').value = start.time || '18:00';
    $('fEnd').value = end.time || '21:00';
    $('fRsvp').checked = ev ? ev.rsvp_enabled !== false : true;
    $('fPublished').checked = ev ? !!ev.published : false;
    if (!ev) {
      $('fState').value = 'VA';
      $('fRsvpEmail').value = 'steve@pivotpointrecovery.org';
    }
    $('editorCard').hidden = false;
    $('editorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveEvent(e) {
    e.preventDefault();
    var title = $('fTitle').value.trim();
    var date = $('fDate').value;
    var whenText = $('fWhenText').value.trim();

    var valid = true;
    $('fTitleError').classList.toggle('visible', !title);
    if (!title) valid = false;
    // A date is required unless the timing is described in words instead.
    var needsDate = !date && !whenText;
    $('fDateError').classList.toggle('visible', needsDate);
    if (needsDate) valid = false;
    if (!valid) { showToast('Please fill in the highlighted fields.', 'error'); return; }

    var record = {
      title: title,
      slug: slugify($('fSlug').value || title),
      published: $('fPublished').checked,
      rsvp_enabled: $('fRsvp').checked,
      starts_at: timestampFor(date, $('fStart').value),
      ends_at: timestampFor(date, $('fEnd').value),
      updated_by: session.email,
    };
    Object.keys(FIELDS).forEach(function (fieldId) {
      if (FIELDS[fieldId] === 'title' || FIELDS[fieldId] === 'slug') return;
      record[FIELDS[fieldId]] = $(fieldId).value.trim() || null;
    });

    var btn = $('saveBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (editingId) {
        await writeRows(REST + '/events?id=eq.' + encodeURIComponent(editingId), 'PATCH', record);
        logActivity('update', 'events', editingId, { title: title });
      } else {
        record.created_by = session.email;
        var made = await writeRows(REST + '/events', 'POST', record);
        logActivity('create', 'events', made && made[0] && made[0].id, { title: title });
      }
      showToast(record.published ? 'Saved and live on the website.' : 'Saved as a draft.', 'success');
      $('editorCard').hidden = true;
      await loadEvents();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save event';
    }
  }

  // -------------------------------------------------------------- the RSVPs
  async function showRsvps(id) {
    var ev = findEvent(id);
    if (!ev) return;
    rsvpEventTitle = ev.title || 'Event';
    var cardEl = $('rsvpCard');
    $('rsvpTitle').textContent = 'RSVPs — ' + rsvpEventTitle;
    $('rsvpCount').textContent = 'Loading…';
    $('rsvpTable').innerHTML = '';
    cardEl.hidden = false;
    cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    var res = await authFetch(REST + '/event_rsvps?select=*&event_id=eq.' + encodeURIComponent(id) + '&order=created_at.desc');
    if (!res.ok) { $('rsvpCount').textContent = 'Could not load the RSVPs for this event.'; return; }
    rsvpRows = await res.json();
    logActivity('read', 'event_rsvps', id, { count: rsvpRows.length });

    var heads = ['Name', 'Email', 'Phone', 'People', 'Performing', 'Notes', 'Received'];
    var guests = rsvpRows.reduce(function (sum, r) { return sum + (r.party_size || 1); }, 0);
    $('rsvpCount').textContent = rsvpRows.length
      ? rsvpRows.length + (rsvpRows.length === 1 ? ' RSVP' : ' RSVPs') + ' · ' + guests + ' people expected'
      : 'No RSVPs yet.';
    $('rsvpTable').innerHTML =
      '<thead><tr>' + heads.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>' +
      '<tbody>' + rsvpRows.map(function (r) {
        var perform = r.participation === 'perform' ? 'Yes' : r.participation === 'undecided' ? 'Maybe' : 'No';
        var acts = (r.act_type || []).join(', ');
        return '<tr><td>' + esc(r.name) + '</td>' +
          '<td><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a></td>' +
          '<td>' + esc(r.phone) + '</td><td>' + esc(r.party_size || 1) + '</td>' +
          '<td>' + esc(perform) + (acts ? ' (' + esc(acts) + ')' : '') + '</td>' +
          '<td>' + esc(r.notes) + '</td>' +
          '<td>' + esc(new Date(r.created_at).toLocaleDateString('en-US', { timeZone: EVENT_TZ })) + '</td></tr>';
      }).join('') + '</tbody>';
  }

  // ------------------------------------------------------------------- CSV
  function downloadCsv(name, headers, rows) {
    if (!rows.length) { showToast('There is nothing to download yet.', 'error'); return; }
    var cell = function (v) {
      var s = String(v == null ? '' : v);
      // Excel and Sheets run a cell that starts like a formula, and these
      // files carry text strangers typed into the website -- messages, RSVP
      // notes, donors' notes. A leading apostrophe makes it plain text.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    var csv = [headers.map(cell).join(',')]
      .concat(rows.map(function (r) { return r.map(cell).join(','); })).join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    logActivity('export', name, null, { rows: rows.length });
  }

  // ---------------------------------------------------------------- drawer
  // Where focus was before the drawer opened, so closing it puts a keyboard
  // user back on the row they came from rather than at the top of the page.
  var drawerReturn = null;
  function openDrawer(html) {
    var d = $('bcDrawer');
    if (!d.classList.contains('on')) drawerReturn = document.activeElement;
    d.innerHTML = html;
    d.inert = false;
    d.classList.add('on');
    d.setAttribute('aria-hidden', 'false');
    $('bcScrim').classList.add('on');
    var x = d.querySelector('.x');
    if (x) x.focus();
  }
  function closeDrawer() {
    var d = $('bcDrawer');
    var wasOpen = d.classList.contains('on');
    d.classList.remove('on');
    d.setAttribute('aria-hidden', 'true');
    // Off-screen is not gone: without this its buttons stay in the tab order.
    d.inert = true;
    $('bcScrim').classList.remove('on');
    if (wasOpen && drawerReturn && document.contains(drawerReturn)) drawerReturn.focus();
    drawerReturn = null;
  }
  function dhead(title, subtitle, pill) {
    return '<div class="bc-dhead"><div style="display:flex;flex-direction:column;gap:.2rem;min-width:0">' +
      '<h2>' + esc(title) + '</h2>' +
      (subtitle ? '<p style="font-size:.85rem;color:var(--bc-ink-soft);margin:0">' + esc(subtitle) + '</p>' : '') +
      (pill ? '<div style="margin-top:.3rem">' + pill + '</div>' : '') +
      '</div><button class="x" aria-label="Close">×</button></div>';
  }
  function stageButtons(entity, id, list, current) {
    return '<div class="bc-stages">' + list.map(function (s) {
      return '<button data-stage="' + s + '" data-entity="' + entity + '" data-id="' + esc(id) + '"' +
        (s === current ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        esc(STAGE_LABEL[s] || s) + '</button>';
    }).join('') + '</div>';
  }
  /** Who is looking after this, when they were actually spoken to, and the
   *  notes. Assignment is a picker rather than "assign to me", because the
   *  person who made the call is often not the person at the keyboard. */
  function workBlock(entity, rec) {
    var id = rec.id;
    var team = (cache.team || []).filter(function (t) { return t.active; });
    var current = String(rec.owner_email || '').toLowerCase();
    var contacted = rec.first_contact_at ? localDate(rec.first_contact_at) : '';

    var options = '<option value=""' + (current ? '' : ' selected') + '>Nobody yet</option>' +
      team.map(function (t) {
        var v = String(t.email).toLowerCase();
        return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' +
          esc(t.label || t.email) + '</option>';
      }).join('');

    var notes = (cache.notes || []).filter(function (n) {
      return n.entity === entity && String(n.entity_id) === String(id);
    });

    return '<div class="bc-dsec"><h3>Who is on it</h3>' +
      '<div style="display:flex;flex-direction:column;gap:.7rem">' +
      '<label style="display:flex;flex-direction:column;gap:.25rem;font-size:.82rem;color:var(--bc-ink-soft)">' +
      'Assigned to' +
      '<select id="wbOwner" style="font-family:var(--font-body);font-size:.9rem;padding:.45rem .5rem;' +
      'border:1px solid var(--color-border);border-radius:8px;background:var(--color-white);' +
      'color:var(--color-text)">' + options + '</select></label>' +
      '<label style="display:flex;flex-direction:column;gap:.25rem;font-size:.82rem;color:var(--bc-ink-soft)">' +
      'Spoken to on' +
      '<input type="date" id="wbContacted" value="' + esc(contacted) + '" ' +
      'style="font-family:var(--font-body);font-size:.9rem;padding:.45rem .5rem;' +
      'border:1px solid var(--color-border);border-radius:8px"></label>' +
      '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">Leave the date blank if nobody ' +
      'has reached them yet. Back-date it freely — it is a record of what happened, not when it was typed.</p>' +
      '<div class="bc-actions">' +
      '<button class="btn btn-blue btn-small" data-work-save="' + esc(id) + '" ' +
      'data-work-entity="' + entity + '">Save</button>' +
      '<button class="btn btn-outline btn-small" data-work-today="1">Spoken to today</button>' +
      '</div></div></div>' +

      '<div class="bc-dsec"><h3>Notes from the team</h3>' +
      (notes.length ? notes.map(function (n) {
        return '<div class="bc-note"><span>' + esc(n.body) + '</span>' +
          '<span class="who">' + esc(String(n.author_email || '').split('@')[0]) + ' · ' + esc(ago(n.created_at)) + '</span></div>';
      }).join('') : '<p style="font-size:.86rem;color:var(--bc-ink-soft);margin:0">No notes yet.</p>') +
      '<div style="display:flex;flex-direction:column;gap:.4rem;margin-top:.6rem">' +
      '<textarea id="noteBody" rows="2" placeholder="What happened, or what needs to happen next" ' +
      'style="width:100%;font-family:var(--font-body);font-size:.88rem;padding:.5rem .6rem;' +
      'border:1px solid var(--color-border);border-radius:8px"></textarea>' +
      '<div class="bc-actions"><button class="btn btn-outline btn-small" data-note-add="' + esc(id) + '" ' +
      'data-note-entity="' + entity + '">Add note</button></div></div></div>';
  }

  var DRAWER = {
    enquiry: function (id) {
      var r = (cache.enquiries || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      logActivity('read', 'contact_submissions', id);
      return dhead(r.name || 'No name given', 'Arrived ' + ago(r.created_at), stagePill(r.status)) +
        '<div class="bc-dsec"><h3>Stage</h3>' +
        stageButtons('contact_submissions', id, ['new', 'contacted', 'referred', 'closed'], r.status || 'new') + '</div>' +
        '<div class="bc-dsec"><h3>How to reach them</h3><dl class="bc-kv">' +
        '<dt>Email</dt><dd><a href="mailto:' + esc(r.email) + '">' + esc(r.email || '—') + '</a></dd>' +
        '<dt>Phone</dt><dd>' + esc(r.phone || '—') + '</dd>' +
        '<dt>About</dt><dd>' + esc(r.interest || '—') + '</dd>' +
        '<dt>Owner</dt><dd>' + owner(r.owner_email) + '</dd>' +
        '<dt>Spoken to</dt><dd>' + (r.first_contact_at ? esc(dayLine(r.first_contact_at)) : 'not yet') + '</dd></dl></div>' +
        '<div class="bc-dsec"><h3>What they wrote</h3><div class="bc-quote">' + esc(r.message || '(nothing)') + '</div>' +
        '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">Never edited, by anybody. ' +
        'Everything the team adds is a separate note below.</p></div>' +
        workBlock('contact_submissions', r);
    },
    volunteer: function (id) {
      var r = (cache.volunteers || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      logActivity('read', 'volunteer_interests', id);
      var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'No name given';
      return dhead(name, 'Signed up ' + ago(r.created_at), stagePill(r.status)) +
        '<div class="bc-dsec"><h3>Stage</h3>' +
        stageButtons('volunteer_interests', id, ['new', 'screened', 'onboarding', 'active', 'inactive'], r.status || 'new') + '</div>' +
        '<div class="bc-dsec"><h3>Details</h3><dl class="bc-kv">' +
        '<dt>Email</dt><dd><a href="mailto:' + esc(r.email) + '">' + esc(r.email || '—') + '</a></dd>' +
        '<dt>Phone</dt><dd>' + esc(r.phone || '—') + '</dd>' +
        '<dt>Town</dt><dd>' + esc(r.city || '—') + '</dd>' +
        '<dt>Interests</dt><dd>' + esc((r.interests || []).join(', ') || '—') + '</dd>' +
        '<dt>Available</dt><dd>' + esc(r.availability || '—') + '</dd>' +
        '<dt>Owner</dt><dd>' + owner(r.owner_email) + '</dd>' +
        '<dt>Spoken to</dt><dd>' + (r.first_contact_at ? esc(dayLine(r.first_contact_at)) : 'not yet') + '</dd></dl></div>' +
        (r.experience ? '<div class="bc-dsec"><h3>What they told us</h3>' +
          '<div class="bc-quote">' + esc(r.experience) + '</div></div>' : '') +
        workBlock('volunteer_interests', r);
    },
    intake: function (id) {
      var r = (cache.intake || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      logActivity('read', 'intake_queue', id, { ref: r.ref });
      return dhead(r.ref, 'Received ' + ago(r.received_at), stagePill(r.stage)) +
        '<div class="bc-dsec"><h3>Stage</h3>' +
        stageButtons('intake_queue', id, ['awaiting_contact', 'in_assessment', 'enrolled', 'closed'], r.stage) + '</div>' +
        '<div class="bc-dsec"><h3>The work, not the answers</h3><dl class="bc-kv">' +
        '<dt>Owner</dt><dd>' + owner(r.owner_email) + '</dd>' +
        '<dt>Follow-up</dt><dd>' + esc(r.follow_up_due || 'not set') + '</dd>' +
        '<dt>First contact</dt><dd>' + (r.first_contact_at ? esc(dayLine(r.first_contact_at)) : 'not yet') + '</dd></dl></div>' +
        '<div class="bc-dsec"><h3>The record itself</h3>' +
        '<div class="bc-quote">This queue holds a reference number, a stage and a follow-up date. What the ' +
        'person wrote lives in the system that collected it, under 42 CFR Part 2.</div>' +
        (r.source_url ? '<div class="bc-actions"><a class="btn btn-outline btn-small" href="' + esc(r.source_url) +
          '" target="_blank" rel="noopener" data-open-record="' + esc(r.id) + '" data-ref="' + esc(r.ref) +
          '">Open the record</a></div>' +
          '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">Opening it is written to the ' +
          'activity log with your name and the time.</p>' : '') + '</div>' +
        workBlock('intake_queue', r);
    },
    /** One gift, for finance only -- the rows never reach anybody else's
     *  browser. `quiet` re-renders after an action without logging a second
     *  read of the same record. */
    gift: function (id, quiet) {
      var r = (cache.gifts || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      if (!quiet) logActivity('read', 'donations', id);
      var address = addressLine(r.donor_address);
      var phoneDigits = String(r.donor_phone || '').replace(/[^\d+]/g, '');
      var completed = r.status === 'succeeded';
      // A typo'd address (a comma for a dot, say) would only bounce, and the
      // receipt function refuses it anyway -- so say so instead of offering
      // a button that cannot work.
      var mistyped = Boolean(r.donor_email) && !EMAIL_RE.test(r.donor_email);
      var receipt = !completed ? 'Not applicable — the payment did not complete'
        : r.receipt_sent_at ? 'Sent ' + ago(r.receipt_sent_at)
        : 'Not sent';
      var stripeUrl = r.stripe_payment_intent_id
        ? 'https://dashboard.stripe.com/payments/' + encodeURIComponent(r.stripe_payment_intent_id) : '';
      return dhead(r.donor_name || 'Anonymous',
          money(r.amount_cents) + (r.is_recurring ? ' a month' : '') + ' · ' + whenLine(r.created_at),
          stagePill(r.status)) +
        '<div class="bc-dsec"><h3>How to reach them</h3><dl class="bc-kv">' +
        '<dt>Email</dt><dd>' + (r.donor_email
          ? '<a href="mailto:' + esc(r.donor_email) + '">' + esc(r.donor_email) + '</a>' : '—') + '</dd>' +
        '<dt>Phone</dt><dd>' + (phoneDigits
          ? '<a href="tel:' + esc(phoneDigits) + '">' + esc(r.donor_phone) + '</a>' : '—') + '</dd>' +
        '<dt>Address</dt><dd>' + (address ? esc(address) : '—') + '</dd></dl></div>' +
        (r.donor_note
          ? '<div class="bc-dsec"><h3>Their note</h3><div class="bc-quote">' + esc(r.donor_note) + '</div></div>'
          : '') +
        '<div class="bc-dsec"><h3>The gift</h3><dl class="bc-kv">' +
        '<dt>Fund</dt><dd>' + esc(fundName(r)) + '</dd>' +
        '<dt>Type</dt><dd>' + (r.is_recurring ? 'Monthly' : 'One-time') + '</dd>' +
        '<dt>Employer match</dt><dd>' + (r.employer_match ? 'Yes — their employer’s form will follow' : 'No') + '</dd>' +
        '<dt>Receipt</dt><dd>' + esc(receipt) + '</dd></dl>' +
        (completed && mistyped
          ? '<p class="bc-warnline">This email address looks mistyped, so a receipt cannot be sent to it. ' +
            'Check the address with the donor — Stripe has the same one on the payment.</p>'
          : '') +
        '<div class="bc-actions">' +
        (completed && r.donor_email && !mistyped
          ? '<button class="btn ' + (r.receipt_sent_at ? 'btn-outline' : 'btn-primary') + ' btn-small" ' +
            'data-send-receipt="' + esc(r.id) + '">' + (r.receipt_sent_at ? 'Send receipt again' : 'Send receipt') +
            '</button>'
          : '') +
        (stripeUrl
          ? '<a class="btn btn-outline btn-small" href="' + esc(stripeUrl) + '" target="_blank" rel="noopener">Open in Stripe</a>'
          : '') +
        '</div></div>';
    },
    /** One person's access. Admins only -- and the database, not this
     *  drawer, is what stops anybody else changing it (staff_admin_write),
     *  or the last person with Manage access from losing it. */
    person: function (id) {
      var r = (cache.team || []).filter(function (x) { return x.id === id; })[0];
      if (!r || !me.canAdmin) return '';
      var roles = r.roles || [];
      var self = String(r.email).toLowerCase() === me.jwtEmail;
      function option(role, title, detail, locked) {
        return '<label style="display:flex;gap:.65rem;align-items:flex-start;font-size:.88rem;cursor:' +
          (locked ? 'default' : 'pointer') + '">' +
          '<input type="checkbox" id="pm-' + role + '" data-role="' + role + '"' +
          (roles.indexOf(role) !== -1 ? ' checked' : '') + (locked ? ' disabled' : '') +
          ' style="margin-top:.25rem;width:1.05rem;height:1.05rem;flex:none">' +
          '<span><strong style="display:block">' + esc(title) + '</strong>' +
          '<span style="color:var(--color-text-mid)">' + detail + '</span></span></label>';
      }
      return dhead(r.label || r.email, r.email,
          r.active ? '<span class="bc-pill ok">Active</span>' : '<span class="bc-pill flat">Switched off</span>') +
        '<div class="bc-dsec"><h3>What they can see</h3>' +
        '<p style="font-size:.86rem;color:var(--color-text-mid);margin:0">Everybody who can sign in sees ' +
        'enquiries, volunteers, the intake queue, events and the board room.</p>' +
        option('finance', 'Giving', 'Donor names, emails, phone numbers, addresses, amounts and notes — and ' +
          'sending receipts.') +
        option('admin', 'Manage access', 'Invite people, set passwords, switch accounts off, and change what ' +
          'everybody can see — including this.', self) +
        (self
          ? '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">You cannot take Manage access away ' +
            'from yourself. Another person with it can.</p>'
          : '') +
        '</div>' +
        '<div class="bc-dsec"><h3>Name on this page</h3>' +
        '<input type="text" id="pmLabel" maxlength="80" value="' + esc(r.label || '') + '" ' +
        'aria-label="Name on this page" placeholder="' + esc(r.email) + '" ' +
        'style="font-family:var(--font-body);font-size:.9rem;padding:.45rem .55rem;' +
        'border:1px solid var(--color-border);border-radius:8px;width:100%">' +
        '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">For example “Grant – board”. ' +
        'It is how they appear in lists and the owner picker.</p></div>' +
        '<div class="bc-dsec"><div class="bc-actions">' +
        '<button class="btn btn-blue btn-small" data-person-save="' + esc(r.id) + '">Save</button></div>' +
        '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">Takes effect the next time they open ' +
        'or refresh a page. Every change is written to the activity log.</p></div>';
    },
  };

  // ------------------------------------------------------------------ loads
  async function loadEvents() {
    // The RSVP count is an embedded aggregate. It is a nicety, and this is the
    // one query the event editor cannot do without, so a server that refuses
    // the aggregate must not cost us the editor.
    try {
      events = await get('/events?select=*,event_rsvps(count)&order=starts_at.desc');
      events.forEach(function (ev) {
        ev.rsvp_count = (ev.event_rsvps && ev.event_rsvps[0]) ? ev.event_rsvps[0].count : 0;
      });
    } catch (err) {
      events = await get('/events?select=*&order=starts_at.desc');
      events.forEach(function (ev) { ev.rsvp_count = null; });
    }
    renderEvents();
  }

  var LOADERS = {
    dashboard: async function () { summary = await rpc('board_summary'); },
    giving: async function () {
      if (me.canGiving) cache.gifts = await get('/donations?select=*&order=created_at.desc&limit=200');
    },
    activity: async function () {
      cache.activity = await get('/activity_log?select=*&order=at.desc&limit=200');
    },
    boardroom: async function () {
      cache.documents = await get('/board_documents?select=*&order=category,label');
    },
  };
  var PEOPLE_LOADERS = {
    volunteers: async function () { cache.volunteers = await get('/volunteer_interests?select=*&order=created_at.desc&limit=500'); },
    contacts:   async function () { cache.enquiries = await get('/contact_submissions?select=*&order=created_at.desc&limit=500'); },
    intake:     async function () { cache.intake = await get('/intake_queue?select=*&order=received_at.desc&limit=500'); },
    team:       async function () { cache.team = await get('/staff_members?select=*&order=label'); },
  };

  async function loadNotes(entity) {
    cache.notes = await get('/record_notes?select=*&entity=eq.' + encodeURIComponent(entity) + '&order=created_at.desc&limit=500');
  }

  // ----------------------------------------------------------------- render
  async function render() {
    var content = $('bcContent');
    content.innerHTML = '<p class="bc-none"><span class="spinner"></span> Loading…</p>';
    $('editorCard').hidden = true;
    $('rsvpCard').hidden = true;

    try {
      if (!summary) summary = await rpc('board_summary');
      if (LOADERS[view]) await LOADERS[view]();
      if (view === 'people') {
        if (!sub) sub = 'contacts';
        await PEOPLE_LOADERS[sub]();
        if (sub === 'contacts') await loadNotes('contact_submissions');
        if (sub === 'volunteers') await loadNotes('volunteer_interests');
        if (sub === 'intake') await loadNotes('intake_queue');
      }
      if (view === 'boardroom' && !sub) sub = 'documents';
      if (view === 'events') { content.innerHTML = V.events(); await loadEvents(); renderNav(); return; }
      content.innerHTML = (V[view] || V.dashboard)();
    } catch (err) {
      content.innerHTML = '<div class="bc-gate hard"><h2>Could not load that</h2><p>' +
        esc(err.message || 'Something went wrong.') + '</p><p style="font-size:.83rem">If this keeps ' +
        'happening, your account may not have access to this section yet.</p></div>';
    }
    renderNav();
  }

  function refocusRow(id) {
    var b = document.querySelector('.bc-rowlink[data-id="' + CSS.escape(String(id)) + '"]');
    if (b) b.focus();
  }

  function go(nextView, nextSub) {
    view = nextView;
    sub = nextSub || '';
    closeDrawer();
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ----------------------------------------------------------------- events
  document.addEventListener('click', async function (e) {
    var t = e.target;

    var nav = t.closest('[data-view]');
    if (nav) { go(nav.dataset.view, nav.dataset.gosub); return; }

    var tab = t.closest('[data-sub]');
    if (tab) { go(view, tab.dataset.sub); return; }

    if (t.closest('.bc-dhead .x') || t.id === 'bcScrim') { closeDrawer(); return; }

    var row = t.closest('[data-drawer]');
    if (row) {
      var fn = DRAWER[row.dataset.drawer];
      if (fn) openDrawer(fn(row.dataset.id));
      return;
    }

    // Following the link out to the intake answers is the access the audit
    // trail exists for, so it is logged separately from opening the drawer.
    // No preventDefault: the link still opens.
    var record = t.closest('[data-open-record]');
    if (record) {
      logActivity('open', 'intake_queue', record.dataset.openRecord, { ref: record.dataset.ref });
      return;
    }

    // ---- event list buttons
    var btn = t.closest('button');
    if (btn && btn.id === 'newEventBtn') { openEditor(null); return; }
    if (btn && btn.dataset.edit) { openEditor(btn.dataset.edit); return; }
    if (btn && btn.dataset.rsvps) { showRsvps(btn.dataset.rsvps); return; }
    if (btn && btn.dataset.publish) { togglePublished(btn.dataset.publish); return; }
    if (btn && btn.dataset.delete) { deleteEvent(btn.dataset.delete); return; }

    // ---- stage changes
    if (btn && btn.dataset.stage) {
      var entity = btn.dataset.entity;
      var field = entity === 'intake_queue' ? 'stage' : 'status';
      var patch = {};
      patch[field] = btn.dataset.stage;
      try {
        await writeRows(REST + '/' + entity + '?id=eq.' + encodeURIComponent(btn.dataset.id), 'PATCH', patch);
        logActivity('update', entity, btn.dataset.id, patch);
        showToast('Moved to ' + (STAGE_LABEL[btn.dataset.stage] || btn.dataset.stage) + '.', 'success');
        summary = null;
        closeDrawer();
        await render();
        refocusRow(btn.dataset.id);
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- who is on it, and when they were spoken to
    if (btn && btn.dataset.workToday) {
      var d = $('wbContacted');
      if (d) d.value = localDate();
      return;
    }
    if (btn && btn.dataset.workSave) {
      var ownerVal = ($('wbOwner') && $('wbOwner').value) || '';
      var dateVal = ($('wbContacted') && $('wbContacted').value) || '';
      var patch = {
        owner_email: ownerVal || null,
        // A date with no time means noon Eastern, not midnight UTC, so a
        // back-dated entry does not slide to the day before.
        first_contact_at: dateVal ? timestampFor(dateVal, '12:00') : null,
      };
      try {
        await writeRows(REST + '/' + btn.dataset.workEntity + '?id=eq.' +
          encodeURIComponent(btn.dataset.workSave), 'PATCH', patch);
        logActivity('update', btn.dataset.workEntity, btn.dataset.workSave, patch);
        showToast(ownerVal
          ? 'Saved — assigned to ' + ownerVal.split('@')[0] + '.'
          : 'Saved.', 'success');
        summary = null;
        closeDrawer();
        await render();
        refocusRow(btn.dataset.workSave);
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- add a note
    if (btn && btn.dataset.noteAdd) {
      var body = ($('noteBody') && $('noteBody').value || '').trim();
      if (!body) { showToast('Write the note first.', 'error'); return; }
      try {
        var note = await writeRows(REST + '/record_notes', 'POST', {
          entity: btn.dataset.noteEntity, entity_id: btn.dataset.noteAdd,
          body: body, author_email: me.jwtEmail,
        });
        // The note's text stays out of the log; the log says one was written.
        logActivity('note', btn.dataset.noteEntity, btn.dataset.noteAdd,
          { note_id: note && note[0] && note[0].id });
        showToast('Note added.', 'success');
        closeDrawer();
        await render();
        refocusRow(btn.dataset.noteAdd);
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- giving: send (or resend) one donor's tax receipt
    if (btn && btn.dataset.sendReceipt) {
      var giftId = btn.dataset.sendReceipt;
      var gift = (cache.gifts || []).filter(function (x) { return x.id === giftId; })[0];
      if (!gift) return;
      var again = Boolean(gift.receipt_sent_at);
      if (!confirm((again
          ? 'A receipt already went to ' + gift.donor_email + ' ' + ago(gift.receipt_sent_at) + '. Send it again?'
          : 'Email the tax receipt for ' + money(gift.amount_cents) + ' to ' + gift.donor_email + '?'))) return;
      btn.disabled = true;
      try {
        var sent = await authFetch(RECONCILE_FN, {
          method: 'POST',
          body: JSON.stringify({ action: 'send_receipt', donation_id: giftId, again: again }),
        });
        var out = await sent.json().catch(function () { return {}; });
        if (!sent.ok || !out.ok) throw new Error(out.error || 'The receipt did not send. Please try again.');
        logActivity('send_receipt', 'donations', giftId);
        showToast('Receipt sent to ' + gift.donor_email + '.', 'success');
        cache.gifts = await get('/donations?select=*&order=created_at.desc&limit=200');
        $('bcContent').innerHTML = V.giving();
        openDrawer(DRAWER.gift(giftId, true));
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
      return;
    }

    // ---- team: what somebody can see
    if (btn && btn.dataset.personSave) {
      var pid = btn.dataset.personSave;
      var person = (cache.team || []).filter(function (x) { return x.id === pid; })[0];
      if (!person) return;
      var had = person.roles || [];
      var roles = ['member'];
      ['finance', 'admin'].forEach(function (role) {
        var box = $('pm-' + role);
        // A disabled box (your own Manage access) keeps what it had.
        if (box ? box.checked : had.indexOf(role) !== -1) roles.push(role);
      });
      var newLabel = (($('pmLabel') && $('pmLabel').value) || '').trim() || null;
      var who = newLabel || person.label || person.email;
      var gaining = roles.filter(function (x) { return x !== 'member' && had.indexOf(x) === -1; });
      if (gaining.length) {
        var what = gaining.map(function (x) {
          return x === 'finance'
            ? 'see every donor’s name, contact details, gifts and notes'
            : 'invite people, set passwords and change what everybody can see';
        }).join(', and ');
        if (!confirm('Let ' + who + ' ' + what + '?')) return;
      }
      btn.disabled = true;
      try {
        await writeRows(REST + '/staff_members?id=eq.' + encodeURIComponent(pid), 'PATCH',
          { roles: roles, label: newLabel });
        logActivity('update', 'staff_members', pid, { roles: roles, previous_roles: had, label: newLabel });
        showToast('Saved — ' + who + ' can now see ' +
          (roles.indexOf('finance') !== -1 ? 'everything' : 'everything but giving') +
          (roles.indexOf('admin') !== -1 ? ', and manage access.' : '.'), 'success');
        if (String(person.email).toLowerCase() === me.jwtEmail) {
          me.roles = roles;
          me.canGiving = roles.indexOf('finance') !== -1;
          me.canAdmin = roles.indexOf('admin') !== -1;
          $('bcRole').textContent = me.canAdmin ? 'Administrator' : me.canGiving ? 'Giving access' : 'Team';
        }
        closeDrawer();
        await render();
        refocusRow(pid);
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
      return;
    }

    // ---- the Monday summary, sent now to the administrator asking
    if (btn && btn.dataset.digestPreview) {
      btn.disabled = true;
      try {
        var sentDigest = await authFetch(DIGEST_FN, { method: 'POST', body: JSON.stringify({ preview: true }) });
        var digestOut = await sentDigest.json().catch(function () { return {}; });
        if (!sentDigest.ok || !digestOut.ok) throw new Error(digestOut.error || 'The summary did not send. Please try again.');
        showToast('Sent to ' + me.email + '. The team gets this every Monday at 8:50am.', 'success');
      } catch (err) { showToast(err.message, 'error'); }
      btn.disabled = false;
      return;
    }

    // ---- intake: add to the queue
    if (btn && btn.dataset.intakeNew) {
      var ref = prompt('Reference number for this intake (no names, please):');
      if (!ref) return;
      var due = prompt('Follow-up due date (for example 2026-10-14 or 10/14/2026), or leave blank:', '');
      if (due === null) return;
      var dueDay = parseDay(due);
      if (dueDay === null) {
        showToast('"' + due.trim() + '" is not a date this can read. Use 2026-10-14 or 10/14/2026.', 'error');
        return;
      }
      try {
        var made = await writeRows(REST + '/intake_queue', 'POST', {
          ref: ref.trim(), follow_up_due: dueDay || null, created_by: me.email,
        });
        logActivity('create', 'intake_queue', made && made[0] && made[0].id, { ref: ref.trim() });
        showToast('Added to the queue.', 'success');
        summary = null;
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- team: give somebody a password, or their first sign-in
    if (btn && btn.dataset.teamPassword) {
      var target = btn.dataset.teamPassword;
      var choice = prompt(
        'Password for ' + target + '.\n\n' +
        'Leave blank and a strong one will be made for you and shown once.\n' +
        'Type "email" to send them a reset link instead.\n\n' +
        'At least 12 characters.', '');
      if (choice === null) return;
      choice = choice.trim();

      var body;
      if (choice.toLowerCase() === 'email') {
        body = { action: 'send_reset', email: target };
      } else if (choice === '') {
        body = { action: 'set_or_create', email: target };
      } else if (choice.length < 12) {
        showToast('Use at least 12 characters, or leave it blank to have one made.', 'error');
        return;
      } else {
        body = { action: 'set_or_create', email: target, password: choice };
      }

      try {
        var out = await callAdminFn(body);
        if (body.action === 'send_reset') {
          showToast('Reset link sent to ' + target + '. Good for one hour.', 'success');
        } else if (out.password) {
          // Shown once, deliberately in a dialog rather than a toast that
          // disappears: this is the only time anybody sees it.
          alert('Password set for ' + target + ':\n\n    ' + out.password + '\n\n' +
                'Give it to them by phone or a password manager — not email. ' +
                'Ask them to change it under "Change password" once they are in.\n\n' +
                'This will not be shown again.');
          showToast('Password set.', 'success');
        } else {
          showToast('Password set for ' + target + '.', 'success');
        }
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- team: invite / switch off
    if (btn && btn.dataset.teamNew) {
      var email = prompt('Email address of the person to invite:');
      if (!email) return;
      var label = prompt('Their name, as it should appear here:', '') || null;
      try {
        await writeRows(REST + '/staff_members', 'POST', {
          email: email.trim(), label: label, roles: ['member'], invited_by: me.email,
        });
        logActivity('invite', 'staff_members', null, { email: email.trim() });
        showToast('Added to the team, seeing everything but giving. Give them a sign-in with ' +
                  'Password on their row, and use Access if they need more.', 'success');
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }
    if (btn && btn.dataset.teamToggle) {
      var makeActive = btn.dataset.active !== '1';
      if (!makeActive && !confirm('Switch off ' + (btn.dataset.label || 'this account') + '? ' +
                                  'They lose access straight away. You can switch them back on.')) return;
      try {
        await writeRows(REST + '/staff_members?id=eq.' + encodeURIComponent(btn.dataset.teamToggle),
          'PATCH', { active: makeActive });
        logActivity('update', 'staff_members', btn.dataset.teamToggle, { active: makeActive });
        showToast(makeActive ? 'Switched on.' : 'Switched off — they lose access immediately.', 'success');
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- documents
    if (btn && btn.dataset.docNew) {
      var dlabel = prompt('What is this document or folder called?');
      if (!dlabel) return;
      var durl = prompt('Paste the Drive link:');
      if (!durl) return;
      if (!/^https:\/\//i.test(durl.trim())) { showToast('The link needs to start with https://', 'error'); return; }
      var dcat = prompt('Which section should it sit under?', 'Board packets') || 'General';
      try {
        var doc = await writeRows(REST + '/board_documents', 'POST', {
          label: dlabel.trim(), url: durl.trim(), category: dcat.trim(),
          is_folder: /\/folders\//.test(durl), added_by: me.email,
        });
        logActivity('create', 'board_documents', doc && doc[0] && doc[0].id, { label: dlabel.trim() });
        showToast('Link added.', 'success');
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }
    if (btn && btn.dataset.docDel) {
      if (!confirm('Remove this link? The file itself stays in Drive.')) return;
      try {
        var gone = await writeRows(REST + '/board_documents?id=eq.' + encodeURIComponent(btn.dataset.docDel), 'DELETE', null);
        logActivity('delete', 'board_documents', btn.dataset.docDel, { label: gone && gone[0] && gone[0].label });
        showToast('Link removed.', 'success');
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- exports
    if (btn && btn.dataset.export === 'enquiries') {
      downloadCsv('enquiries', ['Name', 'Email', 'Phone', 'About', 'Message', 'Stage', 'Owner', 'Received'],
        (cache.enquiries || []).map(function (r) {
          return [r.name, r.email, r.phone, r.interest, r.message, r.status, r.owner_email, r.created_at]; }));
      return;
    }
    if (btn && btn.dataset.export === 'volunteers') {
      downloadCsv('volunteers', ['First name', 'Last name', 'Email', 'Phone', 'Town', 'Interests', 'Availability', 'Stage', 'Owner', 'Signed up'],
        (cache.volunteers || []).map(function (r) {
          return [r.first_name, r.last_name, r.email, r.phone, r.city,
                  (r.interests || []).join('; '), r.availability, r.status, r.owner_email, r.created_at]; }));
      return;
    }
    if (btn && btn.dataset.export === 'gifts') {
      downloadCsv('gifts', ['Donor', 'Email', 'Phone', 'Address', 'Amount', 'Fund', 'Recurring', 'Status',
                            'Note', 'Receipt sent', 'Received'],
        (cache.gifts || []).map(function (r) {
          return [r.donor_name, r.donor_email, r.donor_phone, addressLine(r.donor_address),
                  (r.amount_cents || 0) / 100, fundName(r), r.is_recurring ? 'yes' : 'no', r.status,
                  r.donor_note, r.receipt_sent_at || '', r.created_at]; }));
      return;
    }
    if (btn && btn.id === 'csvBtn') {
      downloadCsv(slugify(rsvpEventTitle) + '-rsvps',
        ['Name', 'Email', 'Phone', 'People', 'Performing', 'Would perform', 'Notes', 'Received'],
        rsvpRows.map(function (r) {
          return [r.name, r.email, r.phone, r.party_size || 1, r.participation,
                  (r.act_type || []).join('; '), r.notes, r.created_at]; }));
      return;
    }
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  // ------------------------------------------------------------------- boot
  async function start() {
    $('loginView').hidden = true;
    $('appView').hidden = false;

    var rows = [];
    try {
      // Every member may read this table, so fetch it and match the way the
      // database does -- case-insensitively. An exact-match filter here would
      // lock out anyone whose staff row is capitalized differently from the
      // address they sign in with, while RLS happily let them in.
      rows = await get('/staff_members?select=*');
      cache.team = rows;
    } catch (err) { /* handled below */ }
    var signedInAs = String(session.email || '').toLowerCase();
    var mine = rows.filter(function (r) {
      return String(r.email || '').toLowerCase() === signedInAs;
    })[0];
    if (!mine || !mine.active) {
      $('appView').hidden = true;
      $('loginView').hidden = false;
      $('loginNote').textContent = 'That account is signed in but is not on the list of people allowed in. ' +
        'Ask Erica to add you.';
      $('loginNote').hidden = false;
      saveSession(null);
      return;
    }
    me = {
      email: mine.email,
      // What the database compares against in policy checks.
      jwtEmail: signedInAs,
      roles: mine.roles || [],
      canGiving: (mine.roles || []).indexOf('finance') !== -1,
      canAdmin: (mine.roles || []).indexOf('admin') !== -1,
    };
    $('bcName').textContent = mine.label || mine.email;
    $('bcRole').textContent = me.canAdmin ? 'Administrator' : me.canGiving ? 'Giving access' : 'Team';
    $('bcAvatar').textContent = initials(mine.label || mine.email);
    await render();
  }

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = $('loginEmail').value.trim();
    var password = $('loginPassword').value;
    var btn = $('loginBtn');
    if (!email || !password) { showToast('Enter your email and password.', 'error'); return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      var res = await fetch(AUTH + '/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || 'Could not sign in.');
      saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, email: data.user.email });
      await start();
    } catch (err) {
      showToast(err.message || 'Could not sign in.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  // Nobody should ever be sent a password. Supabase mails a one-time link and
  // the person chooses their own, which is also what makes inviting somebody
  // from Team & access actually work.
  $('forgotBtn').addEventListener('click', async function () {
    var email = $('loginEmail').value.trim();
    if (!email) {
      showToast('Type your email address above first, then choose this again.', 'error');
      $('loginEmail').focus();
      return;
    }
    var btn = this;
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'Sending…';
    try {
      var res = await fetch(AUTH + '/recover?redirect_to=' +
        encodeURIComponent(window.location.origin + '/admin'), {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      });
      // Supabase answers 200 whether or not the address has an account, so that
      // this form cannot be used to find out who has one. Say the same either
      // way rather than implying the address was recognized.
      if (!res.ok && res.status !== 422) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.msg || data.error_description || 'Could not send the email.');
      }
      showToast('If that address has an account, a link is on its way. It is ' +
                'good for one hour.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // --- arriving from a set-password email ------------------------------------
  /** Supabase returns the tokens in the URL fragment, which never reaches a
   *  server. Read them, then clear them so the link cannot be reused from
   *  history or pasted to somebody else. */
  function takeRecoveryTokens() {
    var hash = window.location.hash || '';
    if (hash.indexOf('type=recovery') === -1 && hash.indexOf('type=invite') === -1) return null;
    var params = new URLSearchParams(hash.replace(/^#/, ''));
    var access = params.get('access_token');
    if (!access) return null;
    history.replaceState(null, '', window.location.pathname);
    return { access_token: access, refresh_token: params.get('refresh_token') || '' };
  }

  async function startRecovery(tokens) {
    saveSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, email: '' });
    var res = await authFetch(AUTH + '/user');
    if (!res.ok) {
      saveSession(null);
      showToast('That link has expired. Choose "Set or reset your password" to get a new one.', 'error');
      return;
    }
    var user = await res.json();
    saveSession(Object.assign({}, session, { email: user.email }));
    $('recoverWho').textContent = user.email;
    $('recoverCard').hidden = false;
    $('recoverCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('recoverPassword').focus();
  }

  $('recoverForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var password = $('recoverPassword').value;
    if (password.length < 8) { showToast('Use at least 8 characters.', 'error'); return; }
    var btn = $('recoverBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      var res = await authFetch(AUTH + '/user', { method: 'PUT', body: JSON.stringify({ password: password }) });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.msg || data.error_description || 'Could not save that password.');
      }
      $('recoverPassword').value = '';
      $('recoverCard').hidden = true;
      showToast('Password saved. Welcome in.', 'success');
      await start();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save it and sign me in';
    }
  });

  $('signOutBtn').addEventListener('click', async function () {
    try { await authFetch(AUTH + '/logout', { method: 'POST' }); } catch (err) { /* local sign-out either way */ }
    saveSession(null);
    location.reload();
  });

  $('passwordToggle').addEventListener('click', function () {
    var c = $('passwordCard');
    c.hidden = !c.hidden;
  });

  $('passwordForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var password = $('newPassword').value;
    if (password.length < 8) { showToast('Use at least 8 characters.', 'error'); return; }
    var btn = $('passwordBtn');
    btn.disabled = true;
    try {
      var res = await authFetch(AUTH + '/user', { method: 'PUT', body: JSON.stringify({ password: password }) });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.msg || data.error_description || 'Could not change the password.');
      }
      $('newPassword').value = '';
      $('passwordCard').hidden = true;
      showToast('Password changed.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally { btn.disabled = false; }
  });

  $('eventForm').addEventListener('submit', saveEvent);
  $('cancelBtn').addEventListener('click', function () { $('editorCard').hidden = true; });
  $('rsvpCloseBtn').addEventListener('click', function () { $('rsvpCard').hidden = true; });

  // Keep the web address in step with the name until the event is published,
  // after which changing it would break links already in circulation.
  $('fTitle').addEventListener('input', function () {
    var ev = editingId ? findEvent(editingId) : null;
    if (ev && ev.published) return;
    $('fSlug').value = slugify(this.value);
  });

  (async function () {
    // A set-password link takes precedence over whatever session is stored, so
    // that following one on a shared computer does not silently act on
    // somebody else's account.
    var recovery = takeRecoveryTokens();
    if (recovery) { await startRecovery(recovery); return; }

    session = loadSession();
    if (!session) return;
    var res = await authFetch(AUTH + '/user');
    if (!res.ok) { saveSession(null); return; }
    var user = await res.json();
    saveSession(Object.assign({}, session, { email: user.email }));
    await start();
  })();
})();
