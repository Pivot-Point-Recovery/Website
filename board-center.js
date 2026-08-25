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
      throw new Error(err.message || 'That did not save. Please try again.');
    }
    if (Array.isArray(data) && data.length === 0) throw new Error(NOT_ALLOWED);
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
      { id: 'enquiries', label: 'Enquiries' },
    ] },
    { group: 'Who we know', items: [
      { id: 'people', label: 'People' },
    ] },
    { group: 'Programmes', items: [
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
      { id: 'directory',  label: 'Directory' },
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
        if (it.id === 'enquiries' && summary && summary.enquiries.unanswered > 0) {
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
    return '<section class="bc-card"><div class="bc-cardhead"><h3>' + esc(title) + '</h3>' +
      (note ? '<p class="note">' + note + '</p>' : '') + (actions || '') + '</div>' + body + '</section>';
  }
  function table(headRow, bodyRows, emptyMsg) {
    if (!bodyRows) return '<p class="bc-none">' + esc(emptyMsg || 'Nothing here yet.') + '</p>';
    return '<div class="bc-scroll"><table class="bc-table"><thead><tr>' + headRow +
      '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
  }
  var STAGE_STYLE = {
    new: 'new', contacted: 'info', referred: 'ok', closed: 'flat',
    screened: 'info', onboarding: 'info', active: 'ok', inactive: 'flat',
    awaiting_contact: 'new', in_assessment: 'info', enrolled: 'ok',
    succeeded: 'ok', pending: 'warn', failed: 'stop',
  };
  var STAGE_LABEL = {
    new: 'New', contacted: 'Contacted', referred: 'Referred', closed: 'Closed',
    screened: 'Screened', onboarding: 'Onboarding', active: 'Active', inactive: 'Inactive',
    awaiting_contact: 'Awaiting contact', in_assessment: 'In assessment', enrolled: 'Enrolled',
  };
  function stagePill(s) {
    var key = String(s || 'new').toLowerCase();
    return '<span class="bc-pill ' + (STAGE_STYLE[key] || 'flat') + '">' +
      esc(STAGE_LABEL[key] || s || 'New') + '</span>';
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
        w: ago(s.enquiries.oldest_unanswered), go: 'enquiries' });
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
      attn.push({ k: 'warn', sev: 'Watch', t: s.giving.failed + ' payment(s) failed this month',
        s: 'A donor probably meant to give and could not', w: '', go: 'giving' });
    }
    if (s.events.drafts > 0) {
      attn.push({ k: '', sev: 'For info', t: s.events.drafts + ' event(s) still in draft',
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
      return { f: f.fund, v: Number(f.cents), label: money(Number(f.cents)) };
    });

    return head('This week', 'Signed in as ' + esc(me.email) + '.') +
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

  V.enquiries = function () {
    var rows = cache.enquiries || [];
    return head('Enquiries', 'Everyone who has written in through the contact form.',
        '<button class="btn btn-outline btn-small" data-export="enquiries">Download as spreadsheet</button>') +
      card('Contact form submissions', rows.length + (rows.length === 1 ? ' record' : ' records'),
        table('<th>Person</th><th>About</th><th>Stage</th><th>Owner</th><th>Received</th>',
          rows.length ? rows.map(function (r) {
            return '<tr class="click" data-drawer="enquiry" data-id="' + esc(r.id) + '">' +
              '<td><span class="nm">' + esc(r.name || 'No name given') + '</span>' +
              '<span class="sc">' + esc(r.email || '') + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.interest || '—') + '</td>' +
              '<td>' + stagePill(r.status) + '</td><td>' + owner(r.owner_email) + '</td>' +
              '<td class="ago">' + esc(ago(r.created_at)) + '</td></tr>';
          }).join('') : '',
          'No enquiries yet. When somebody uses the contact form they appear here.'));
  };

  V.people = function () {
    if (sub === 'volunteers') return peopleVolunteers();
    if (sub === 'intake') return peopleIntake();
    if (sub === 'team') return peopleTeam();
    return peopleDirectory();
  };

  function peopleDirectory() {
    var rows = cache.directory || [];
    return head('People', 'One row per person, matched on email across enquiries, volunteers and RSVPs.') +
      tabs('people') +
      card('Directory', rows.length + (rows.length === 1 ? ' person' : ' people'),
        table('<th>Name</th><th>Email</th><th>Known from</th><th>Contacts</th><th>Last seen</th>',
          rows.length ? rows.map(function (r) {
            return '<tr><td><span class="nm">' + esc(r.name) + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.email) + '</td>' +
              '<td>' + (r.kinds || []).map(function (k) {
                return '<span class="bc-pill flat" style="margin-right:.2rem">' + esc(k) + '</span>'; }).join('') + '</td>' +
              '<td class="r">' + esc(r.touch_count) + '</td>' +
              '<td class="ago">' + esc(ago(r.last_seen)) + '</td></tr>';
          }).join('') : '', 'Nobody yet.')) +
      '<div class="bc-gate"><h3>Read-only for now</h3><p>This directory is worked out from the other tables ' +
      'each time you open it, so nothing here can be wrong in a way that loses data. Merging duplicates and ' +
      'adding tags come next; donors are deliberately not included, because donor identity is limited to ' +
      'Erica and Steve.</p></div>';
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
              '<td><span class="nm">' + esc(name) + '</span><span class="sc">' + esc(r.email || '') + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.city || '—') + '</td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc((r.interests || []).join(', ') || '—') + '</td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.availability || '—') + '</td>' +
              '<td>' + stagePill(r.status) + '</td><td>' + owner(r.owner_email) + '</td></tr>';
          }).join('') : '', 'No volunteer sign-ups yet.'));
  }

  function peopleIntake() {
    var rows = cache.intake || [];
    var overdue = rows.filter(function (r) {
      return r.stage !== 'closed' && r.follow_up_due && r.follow_up_due < new Date().toISOString().slice(0, 10);
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
      '<div class="bc-gate"><h3>No intake answers are stored here, by design</h3>' +
      '<p>Intake responses are protected under 42 CFR Part 2 and HIPAA and stay in the system that collects ' +
      'them. This queue holds a reference number, a stage and a follow-up date — enough to run the work and to ' +
      'tell the board how fast we answer, and no part of anybody&rsquo;s story.</p></div>' +
      card('The queue', rows.length + (rows.length === 1 ? ' entry' : ' entries'),
        table('<th>Reference</th><th>Received</th><th>Stage</th><th>Owner</th><th>Follow-up due</th>',
          rows.length ? rows.map(function (r) {
            var late = r.stage !== 'closed' && r.follow_up_due && r.follow_up_due < new Date().toISOString().slice(0, 10);
            return '<tr class="click" data-drawer="intake" data-id="' + esc(r.id) + '">' +
              '<td><span class="nm" style="font-variant-numeric:tabular-nums">' + esc(r.ref) + '</span></td>' +
              '<td class="ago">' + esc(ago(r.received_at)) + '</td>' +
              '<td>' + stagePill(r.stage) + '</td><td>' + owner(r.owner_email) + '</td>' +
              '<td style="font-size:.85rem;' + (late ? 'color:var(--bc-stop-fg);font-weight:600' : 'color:var(--color-text-mid)') + '">' +
              esc(r.follow_up_due || '—') + '</td></tr>';
          }).join('') : '',
          'The queue is empty. Add an entry each time an intake form comes in.'));
  }

  function peopleTeam() {
    var rows = cache.team || [];
    return head('People', 'Everyone who can sign in, and what each of them can see.',
        me.canAdmin ? '<button class="btn btn-primary btn-small" data-team-new="1">+ Invite someone</button>' : '') +
      tabs('people') +
      card('People with access', rows.length + (rows.length === 1 ? ' account' : ' accounts'),
        table('<th>Person</th><th>Can see</th><th>Status</th>' + (me.canAdmin ? '<th></th>' : ''),
          rows.length ? rows.map(function (r) {
            var roleLabels = (r.roles || []).map(function (x) {
              return { member: 'Everything but giving', finance: 'Giving', admin: 'Manage access' }[x] || x;
            });
            return '<tr><td><span class="nm">' + esc(r.label || r.email) + '</span>' +
              '<span class="sc">' + esc(r.email) + '</span></td>' +
              '<td>' + roleLabels.map(function (l) {
                return '<span class="bc-pill info" style="margin-right:.2rem">' + esc(l) + '</span>'; }).join('') + '</td>' +
              '<td>' + (r.active ? '<span class="bc-pill ok">Active</span>' : '<span class="bc-pill flat">Switched off</span>') + '</td>' +
              (me.canAdmin
                ? '<td class="r"><button class="btn btn-ghost btn-small" data-team-toggle="' + esc(r.id) + '" ' +
                  'data-active="' + (r.active ? '1' : '0') + '">' + (r.active ? 'Switch off' : 'Switch on') + '</button></td>'
                : '') + '</tr>';
          }).join('') : '', 'Nobody yet.')) +
      (me.canAdmin
        ? '<div class="bc-gate"><h3>Giving is limited to Erica and Steve</h3><p>Everyone invited sees ' +
          'everything else — enquiries, volunteers, the intake queue, events and documents. Adding ' +
          '<em>Giving</em> to somebody lets them see donor names and amounts, so it stays with the executive ' +
          'director and the treasurer unless the board decides otherwise.</p></div>'
        : '');
  }

  V.giving = function () {
    var s = summary;
    var funds = (s.giving.by_fund || []).map(function (f) {
      return { f: f.fund, v: Number(f.cents), label: money(Number(f.cents)) };
    });
    var tiles = '<div class="bc-grid bc-g4">' +
      tile('This month', money(s.giving.month_cents), s.giving.gift_count + ' gifts') +
      tile('This year', money(s.giving.year_cents), 'Since 1 January') +
      tile('Recurring donors', String(s.giving.recurring), 'Monthly gifts on file') +
      tile('Failed payments', String(s.giving.failed), s.giving.failed ? 'Worth a nudge' : 'None this month', s.giving.failed > 0) +
      '</div>';

    if (!me.canGiving) {
      return head('Giving', 'Totals and the fund split.') + tiles +
        '<div class="bc-split"><div>' +
        (funds.length ? card('By fund', 'This month', hbars(funds, 'Total', money(s.giving.month_cents)))
                      : card('By fund', 'This month', '<p class="bc-none">No gifts recorded this month.</p>')) +
        '</div><div><div class="bc-gate"><h3>Donor names are limited to Erica and Steve</h3>' +
        '<p>Who gave and how much stays with the executive director and the treasurer, who acknowledge gifts ' +
        'and reconcile the bank. The totals above are the same ones they see, and are what the board reports ' +
        'on.</p><p style="font-size:.83rem;color:var(--bc-ink-soft)">Enforced in the database, not by hiding ' +
        'this page — the donor rows are never sent to your browser.</p></div></div></div>';
    }

    var rows = cache.gifts || [];
    return head('Giving', 'Every gift, and every attempt that did not complete.',
        '<button class="btn btn-outline btn-small" data-export="gifts">Download as spreadsheet</button>') + tiles +
      '<div class="bc-split"><div>' +
      card('Recent gifts', rows.length + ' shown',
        table('<th>Donor</th><th>Fund</th><th>Type</th><th>Amount</th><th>Status</th>',
          rows.length ? rows.map(function (r) {
            return '<tr><td><span class="nm">' + esc(r.donor_name || 'Anonymous') + '</span>' +
              '<span class="sc">' + esc(ago(r.created_at)) + '</span></td>' +
              '<td style="font-size:.85rem;color:var(--color-text-mid)">' + esc(r.fund_designation || 'General fund') + '</td>' +
              '<td><span class="bc-pill flat">' + (r.is_recurring ? 'Monthly' : 'One-time') + '</span></td>' +
              '<td class="r" style="font-weight:600">' + esc(money(r.amount_cents)) + '</td>' +
              '<td>' + stagePill(r.status) + '</td></tr>';
          }).join('') : '', 'No gifts recorded yet.')) +
      '</div><div>' +
      (funds.length ? card('By fund', 'This month', hbars(funds, 'Total', money(s.giving.month_cents)))
                    : card('By fund', 'This month', '<p class="bc-none">No gifts this month.</p>')) +
      '</div></div>';
  };

  V.boardroom = function () {
    var rows = cache.documents || [];
    var byCat = {};
    rows.forEach(function (r) { (byCat[r.category || 'General'] = byCat[r.category || 'General'] || []).push(r); });
    var cats = Object.keys(byCat).sort();
    return head('Board room', 'Papers and files the board needs, kept in Drive.',
        '<button class="btn btn-primary btn-small" data-doc-new="1">+ Add a link</button>') +
      tabs('boardroom') +
      (cats.length ? cats.map(function (c) {
        return card(c, byCat[c].length + (byCat[c].length === 1 ? ' item' : ' items'),
          table('<th>Name</th><th>Added by</th><th>Added</th>' + (me.canAdmin ? '<th></th>' : ''),
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
      }).join('') : card('Documents', null, '<p class="bc-none">No links yet. ' +
          'Add a link to a Drive folder or file and it appears here for everyone on the team.</p>')) +
      '<div class="bc-gate"><h3>These are links, not copies</h3><p>The file stays in Drive, so Google keeps ' +
      'doing the sharing, version history and virus scanning, and no board paper ends up in a second place ' +
      'you have to secure.</p><p style="font-size:.83rem;color:var(--bc-ink-soft)">Worth doing before this ' +
      'fills up: move these folders into a <strong>shared drive</strong> rather than a personal one. Files in ' +
      'a personal Drive belong to that person and leave with them.</p></div>';
  };

  V.activity = function () {
    var rows = cache.activity || [];
    return head('Activity log', 'Every change, and every look at a record somebody trusted us with.') +
      card('Recent activity', rows.length + ' most recent',
        table('<th>Who</th><th>Did what</th><th>To</th><th>When</th>',
          rows.length ? rows.map(function (r) {
            return '<tr><td><span class="nm">' + esc(String(r.actor_email || '').split('@')[0]) + '</span></td>' +
              '<td><span class="bc-pill ' + (r.action === 'read' ? 'info' : r.action === 'delete' ? 'stop' : 'flat') +
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
        '<h3>' + esc(ev.title || 'Untitled') +
          '<span class="admin-pill ' + (ev.published ? 'live' : 'draft') + '">' +
          (ev.published ? 'Published' : 'Draft') + '</span></h3>' +
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
    var cell = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
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
  function openDrawer(html) {
    var d = $('bcDrawer');
    d.innerHTML = html;
    d.classList.add('on');
    d.setAttribute('aria-hidden', 'false');
    $('bcScrim').classList.add('on');
    var x = d.querySelector('.x');
    if (x) x.focus();
  }
  function closeDrawer() {
    $('bcDrawer').classList.remove('on');
    $('bcDrawer').setAttribute('aria-hidden', 'true');
    $('bcScrim').classList.remove('on');
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
  function notesBlock(entity, id) {
    var notes = (cache.notes || []).filter(function (n) {
      return n.entity === entity && String(n.entity_id) === String(id);
    });
    return '<div class="bc-dsec"><h4>Notes from the team</h4>' +
      (notes.length ? notes.map(function (n) {
        return '<div class="bc-note"><span>' + esc(n.body) + '</span>' +
          '<span class="who">' + esc(String(n.author_email || '').split('@')[0]) + ' · ' + esc(ago(n.created_at)) + '</span></div>';
      }).join('') : '<p style="font-size:.86rem;color:var(--bc-ink-soft);margin:0">No notes yet.</p>') +
      '<div style="display:flex;flex-direction:column;gap:.4rem;margin-top:.6rem">' +
      '<textarea id="noteBody" rows="2" placeholder="What happened, or what needs to happen next" ' +
      'style="width:100%;font-family:var(--font-body);font-size:.88rem;padding:.5rem .6rem;' +
      'border:1px solid var(--color-border);border-radius:8px"></textarea>' +
      '<div class="bc-actions"><button class="btn btn-blue btn-small" data-note-add="' + esc(id) + '" ' +
      'data-note-entity="' + entity + '">Add note</button>' +
      '<button class="btn btn-outline btn-small" data-assign="' + esc(id) + '" data-entity="' + entity + '">Assign to me</button>' +
      '</div></div></div>';
  }

  var DRAWER = {
    enquiry: function (id) {
      var r = (cache.enquiries || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      logActivity('read', 'contact_submissions', id);
      return dhead(r.name || 'No name given', 'Arrived ' + ago(r.created_at), stagePill(r.status)) +
        '<div class="bc-dsec"><h4>Stage</h4>' +
        stageButtons('contact_submissions', id, ['new', 'contacted', 'referred', 'closed'], r.status || 'new') + '</div>' +
        '<div class="bc-dsec"><h4>How to reach them</h4><dl class="bc-kv">' +
        '<dt>Email</dt><dd><a href="mailto:' + esc(r.email) + '">' + esc(r.email || '—') + '</a></dd>' +
        '<dt>Phone</dt><dd>' + esc(r.phone || '—') + '</dd>' +
        '<dt>About</dt><dd>' + esc(r.interest || '—') + '</dd>' +
        '<dt>Owner</dt><dd>' + owner(r.owner_email) + '</dd></dl></div>' +
        '<div class="bc-dsec"><h4>What they wrote</h4><div class="bc-quote">' + esc(r.message || '(nothing)') + '</div>' +
        '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">Never edited, by anybody. ' +
        'Everything the team adds is a separate note below.</p></div>' +
        notesBlock('contact_submissions', id);
    },
    volunteer: function (id) {
      var r = (cache.volunteers || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      logActivity('read', 'volunteer_interests', id);
      var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'No name given';
      return dhead(name, 'Signed up ' + ago(r.created_at), stagePill(r.status)) +
        '<div class="bc-dsec"><h4>Stage</h4>' +
        stageButtons('volunteer_interests', id, ['new', 'screened', 'onboarding', 'active', 'inactive'], r.status || 'new') + '</div>' +
        '<div class="bc-dsec"><h4>Details</h4><dl class="bc-kv">' +
        '<dt>Email</dt><dd><a href="mailto:' + esc(r.email) + '">' + esc(r.email || '—') + '</a></dd>' +
        '<dt>Phone</dt><dd>' + esc(r.phone || '—') + '</dd>' +
        '<dt>Town</dt><dd>' + esc(r.city || '—') + '</dd>' +
        '<dt>Interests</dt><dd>' + esc((r.interests || []).join(', ') || '—') + '</dd>' +
        '<dt>Available</dt><dd>' + esc(r.availability || '—') + '</dd>' +
        '<dt>Owner</dt><dd>' + owner(r.owner_email) + '</dd></dl></div>' +
        (r.experience ? '<div class="bc-dsec"><h4>What they told us</h4>' +
          '<div class="bc-quote">' + esc(r.experience) + '</div></div>' : '') +
        notesBlock('volunteer_interests', id);
    },
    intake: function (id) {
      var r = (cache.intake || []).filter(function (x) { return x.id === id; })[0];
      if (!r) return '';
      logActivity('read', 'intake_queue', id, { ref: r.ref });
      return dhead(r.ref, 'Received ' + ago(r.received_at), stagePill(r.stage)) +
        '<div class="bc-dsec"><h4>Stage</h4>' +
        stageButtons('intake_queue', id, ['awaiting_contact', 'in_assessment', 'enrolled', 'closed'], r.stage) + '</div>' +
        '<div class="bc-dsec"><h4>The work, not the answers</h4><dl class="bc-kv">' +
        '<dt>Owner</dt><dd>' + owner(r.owner_email) + '</dd>' +
        '<dt>Follow-up</dt><dd>' + esc(r.follow_up_due || 'not set') + '</dd>' +
        '<dt>First contact</dt><dd>' + (r.first_contact_at ? esc(ago(r.first_contact_at)) : 'not yet') + '</dd></dl>' +
        (r.first_contact_at ? '' : '<div class="bc-actions"><button class="btn btn-blue btn-small" ' +
          'data-intake-contacted="' + esc(id) + '">Mark first contact made</button></div>') + '</div>' +
        '<div class="bc-dsec"><h4>The record itself</h4>' +
        '<div class="bc-quote">This queue holds a reference number, a stage and a follow-up date. What the ' +
        'person wrote lives in the system that collected it, under 42 CFR Part 2.</div>' +
        (r.source_url ? '<div class="bc-actions"><a class="btn btn-outline btn-small" href="' + esc(r.source_url) +
          '" target="_blank" rel="noopener">Open the record</a></div>' +
          '<p style="font-size:.79rem;color:var(--bc-ink-soft);margin:0">Opening it is written to the ' +
          'activity log with your name and the time.</p>' : '') + '</div>' +
        notesBlock('intake_queue', id);
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
    enquiries: async function () {
      cache.enquiries = await get('/contact_submissions?select=*&order=created_at.desc&limit=500');
    },
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
    directory:  async function () { cache.directory = await get('/people_directory?select=*&order=last_seen.desc&limit=500'); },
    volunteers: async function () { cache.volunteers = await get('/volunteer_interests?select=*&order=created_at.desc&limit=500'); },
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
        if (!sub) sub = 'directory';
        await PEOPLE_LOADERS[sub]();
        if (sub === 'volunteers') await loadNotes('volunteer_interests');
        if (sub === 'intake') await loadNotes('intake_queue');
      }
      if (view === 'enquiries') await loadNotes('contact_submissions');
      if (view === 'boardroom' && !sub) sub = 'documents';
      if (view === 'events') { content.innerHTML = V.events(); await loadEvents(); renderNav(); return; }
      content.innerHTML = (V[view] || V.dashboard)();
    } catch (err) {
      content.innerHTML = '<div class="bc-gate hard"><h3>Could not load that</h3><p>' +
        esc(err.message || 'Something went wrong.') + '</p><p style="font-size:.83rem">If this keeps ' +
        'happening, your account may not have access to this section yet.</p></div>';
    }
    renderNav();
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
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- assign to me
    if (btn && btn.dataset.assign) {
      try {
        await writeRows(REST + '/' + btn.dataset.entity + '?id=eq.' + encodeURIComponent(btn.dataset.assign),
          'PATCH', { owner_email: me.jwtEmail });
        logActivity('update', btn.dataset.entity, btn.dataset.assign, { owner_email: me.jwtEmail });
        showToast('Assigned to you.', 'success');
        closeDrawer();
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- add a note
    if (btn && btn.dataset.noteAdd) {
      var body = ($('noteBody') && $('noteBody').value || '').trim();
      if (!body) { showToast('Write the note first.', 'error'); return; }
      try {
        await writeRows(REST + '/record_notes', 'POST', {
          entity: btn.dataset.noteEntity, entity_id: btn.dataset.noteAdd,
          body: body, author_email: me.jwtEmail,
        });
        showToast('Note added.', 'success');
        closeDrawer();
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- intake: first contact
    if (btn && btn.dataset.intakeContacted) {
      try {
        await writeRows(REST + '/intake_queue?id=eq.' + encodeURIComponent(btn.dataset.intakeContacted),
          'PATCH', { first_contact_at: new Date().toISOString(), stage: 'in_assessment' });
        showToast('First contact recorded.', 'success');
        summary = null;
        closeDrawer();
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    // ---- intake: add to the queue
    if (btn && btn.dataset.intakeNew) {
      var ref = prompt('Reference number for this intake (no names, please):');
      if (!ref) return;
      var due = prompt('Follow-up due date (YYYY-MM-DD), or leave blank:', '');
      try {
        await writeRows(REST + '/intake_queue', 'POST', {
          ref: ref.trim(), follow_up_due: (due || '').trim() || null, created_by: me.email,
        });
        showToast('Added to the queue.', 'success');
        summary = null;
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
        showToast('Added. They can sign in once they have a password — ask them to use ' +
                  '"forgot password" on the sign-in page.', 'success');
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }
    if (btn && btn.dataset.teamToggle) {
      var makeActive = btn.dataset.active !== '1';
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
        await writeRows(REST + '/board_documents', 'POST', {
          label: dlabel.trim(), url: durl.trim(), category: dcat.trim(),
          is_folder: /\/folders\//.test(durl), added_by: me.email,
        });
        showToast('Link added.', 'success');
        await render();
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }
    if (btn && btn.dataset.docDel) {
      if (!confirm('Remove this link? The file itself stays in Drive.')) return;
      try {
        await writeRows(REST + '/board_documents?id=eq.' + encodeURIComponent(btn.dataset.docDel), 'DELETE', null);
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
      downloadCsv('gifts', ['Donor', 'Email', 'Amount', 'Fund', 'Recurring', 'Status', 'Received'],
        (cache.gifts || []).map(function (r) {
          return [r.donor_name, r.donor_email, (r.amount_cents || 0) / 100, r.fund_designation,
                  r.is_recurring ? 'yes' : 'no', r.status, r.created_at]; }));
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
      // lock out anyone whose staff row is capitalised differently from the
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
    session = loadSession();
    if (!session) return;
    var res = await authFetch(AUTH + '/user');
    if (!res.ok) { saveSession(null); return; }
    var user = await res.json();
    saveSession(Object.assign({}, session, { email: user.email }));
    await start();
  })();
})();
