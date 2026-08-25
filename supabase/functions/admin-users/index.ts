// Team account management for /admin: create a sign-in, set somebody's
// password, or send them a reset link.
//
// This exists because none of it is possible from the browser. Creating a user
// or setting another person's password needs the service-role key, which must
// never reach a page. So the key stays here and the endpoint is narrow.
//
// Two independent gates, because this is the most privileged endpoint on the
// project:
//
//   1. The caller's own JWT is passed to public.has_role('admin'), so the
//      DATABASE decides whether they may do this -- the same authority that
//      decides everything else in the Board Center. This function never reads
//      roles out of the token itself.
//   2. The target address must already exist in public.staff_members. That
//      keeps the endpoint from being pointed at an arbitrary account: an
//      administrator can manage the team, not every user in the project.
//
// Deployed with --no-verify-jwt off (i.e. JWT verification ON). Note that a
// valid JWT alone proves nothing here -- the anon key is a valid JWT -- which
// is exactly why gate 1 is not optional.

import { fail, json, preflight } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

/** Admin-set passwords are held to a higher bar than the 8 characters somebody
 *  choosing their own is asked for: this one is typed by a third party, read
 *  down a phone line, and lives until it is changed. */
const MIN_PASSWORD = 12;

const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

/** Gate 1. Asks the database, using the caller's own token, whether they hold
 *  the admin role. Anything other than a clear `true` is a refusal. */
async function callerIsAdmin(authHeader: string): Promise<{ ok: boolean; email: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/has_role`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ wanted: 'admin' }),
  });
  if (!res.ok) return { ok: false, email: '' };
  const allowed = await res.json().catch(() => false);
  if (allowed !== true) return { ok: false, email: '' };

  // Only for the audit entry. Never used to decide anything.
  let email = '';
  try {
    const payload = JSON.parse(atob(authHeader.replace(/^Bearer\s+/i, '').split('.')[1]));
    email = String(payload.email ?? '').toLowerCase();
  } catch { /* the audit row can carry an empty actor rather than fail the call */ }
  return { ok: true, email };
}

/** Gate 2. The address has to be somebody on the team already. */
async function isOnTheTeam(email: string): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_members?select=email&email=ilike.${encodeURIComponent(email)}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function findAuthUser(email: string): Promise<{ id: string } | null> {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const res = await admin(`/users?page=${page}&per_page=200`);
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const users: Array<{ id: string; email?: string }> = body.users ?? [];
    const hit = users.find((u) => String(u.email ?? '').toLowerCase() === wanted);
    if (hit) return { id: hit.id };
    if (users.length < 200) return null;
  }
  return null;
}

async function logIt(actor: string, action: string, target: string) {
  // Best effort. A missing audit row must not fail the operation, but it should
  // be findable in the function logs if it starts happening systematically.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        actor_email: actor, action, entity: 'staff_members',
        entity_id: target, detail: { via: 'admin-users' },
      }),
    });
  } catch (err) {
    console.error('activity_log write failed', err);
  }
}

function generatePassword(): string {
  const words = ('anchor amber ballast beacon bramble canyon cedar cinder clover compass copper ' +
    'cricket delta driftwood ember falcon fathom flint garnet granite harbor hollow indigo ivory ' +
    'juniper kestrel lantern lattice marble meadow mistral nimbus onyx orchard pebble pewter ' +
    'quarry quiver ridge rustic saffron sandbar sequoia sorrel spruce sterling summit tamarind ' +
    'thicket timber trellis tundra verdant vessel walnut willow zephyr').split(' ');
  const pick = (n: number) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % n;
  };
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  const symbols = '!@#$%^&*?-+=';
  return [cap(words[pick(words.length)]), cap(words[pick(words.length)]), cap(words[pick(words.length)])]
    .join('-') + symbols[pick(symbols.length)] + String(10 + pick(90));
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('health') === '1') {
      return json(req, {
        service: 'admin-users',
        ok: Boolean(SUPABASE_URL && SERVICE_KEY && ANON_KEY),
        secrets: {
          SUPABASE_URL: Boolean(SUPABASE_URL),
          SUPABASE_SERVICE_ROLE_KEY: Boolean(SERVICE_KEY),
          SUPABASE_ANON_KEY: Boolean(ANON_KEY),
        },
      });
    }
    return fail(req, 'Not found.', 404);
  }
  if (req.method !== 'POST') return fail(req, 'Method not allowed.', 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(req, 'This endpoint is not configured.', 502);

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader) return fail(req, 'Sign in first.', 401);

  const caller = await callerIsAdmin(authHeader);
  if (!caller.ok) {
    return fail(req, 'Only an administrator can manage team accounts.', 403);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return fail(req, 'Could not read that request.');
  }

  const action = String(payload.action ?? '');
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return fail(req, 'Give a valid email address.');

  if (!(await isOnTheTeam(email))) {
    return fail(req, 'Add them under Team & access first, then set their password.', 404);
  }

  // ---------------------------- give somebody a password, creating if needed
  //
  // One action rather than two, so the page never has to know whether an auth
  // account already exists -- a distinction it would only get wrong.
  if (action === 'set_or_create' || action === 'create_user' || action === 'set_password') {
    const supplied = payload.password ? String(payload.password) : '';
    if (supplied && supplied.length < MIN_PASSWORD) {
      return fail(req, `Use at least ${MIN_PASSWORD} characters.`);
    }
    const password = supplied || generatePassword();
    const existing = await findAuthUser(email);

    if (existing) {
      const res = await admin(`/users/${existing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        console.error('set password failed', res.status, await res.text().catch(() => ''));
        return fail(req, 'Could not change that password.', 502);
      }
      await logIt(caller.email, 'set_password', email);
    } else {
      const res = await admin('/users', {
        method: 'POST',
        // email_confirm skips the confirmation email on purpose. Mail delivery
        // from this domain is unreliable, and an account nobody can confirm is
        // an account nobody can use.
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      if (!res.ok) {
        console.error('create user failed', res.status, await res.text().catch(() => ''));
        return fail(req, 'Could not create that sign-in. Check the address and try again.', 502);
      }
      await logIt(caller.email, 'create', email);
    }

    // The generated password is returned exactly once, because nothing else
    // knows it. A password the caller typed is never echoed back.
    return json(req, {
      ok: true, email, created: !existing, password: supplied ? null : password,
    });
  }

  // ------------------------------------------------------- mail them a link
  if (action === 'send_reset') {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok && res.status !== 422) {
      return fail(req, 'Could not send that email.', 502);
    }
    await logIt(caller.email, 'send_reset', email);
    return json(req, { ok: true, email });
  }

  return fail(req, 'Unknown action.');
});
