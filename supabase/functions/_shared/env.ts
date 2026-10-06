// Secret resolution.
//
// Each logical secret resolves through a short alias list, so whichever name is
// actually set on the project gets picked up. This is not paranoia: the live
// project holds the Stripe key under STRIPE_API_KEY, not STRIPE_SECRET_KEY, and
// a name mismatch fails silently -- the function runs, the secret reads empty,
// and the only symptom is a donation that never completes.

const ALIASES: Record<string, string[]> = {
  STRIPE_SECRET_KEY: [
    'STRIPE_SECRET_KEY',
    'PPR_STRIPE_SECRET_KEY',
    'STRIPE_API_KEY',
    'STRIPE_SK',
    'STRIPE_SECRET',
    'STRIPE_KEY',
    'STRIPE_LIVE_SECRET_KEY',
    'STRIPE_TEST_SECRET_KEY',
    'STRIPE_RESTRICTED_KEY',
  ],
  STRIPE_WEBHOOK_SECRET: [
    'STRIPE_WEBHOOK_SECRET',
    'PPR_STRIPE_WEBHOOK_SECRET',
    'STRIPE_WEBHOOK_SIGNING_SECRET',
    'STRIPE_WEBHOOK_SIGNING_KEY',
    'STRIPE_SIGNING_SECRET',
    'STRIPE_WHSEC',
    'WEBHOOK_SECRET',
  ],
  RESEND_API_KEY: ['RESEND_API_KEY', 'PPR_RESEND_API_KEY', 'RESEND_KEY'],
  NOTIFICATION_EMAILS: [
    'NOTIFICATION_EMAILS',
    'PPR_NOTIFICATION_EMAILS',
    'NOTIFY_EMAILS',
    'STAFF_EMAILS',
  ],
  RESEND_FROM: ['RESEND_FROM', 'PPR_RESEND_FROM', 'NOTIFICATION_FROM', 'EMAIL_FROM'],
  SITE_URL: ['SITE_URL', 'PPR_SITE_URL', 'PUBLIC_SITE_URL'],
  ALLOWED_ORIGINS: ['ALLOWED_ORIGINS', 'PPR_ALLOWED_ORIGINS', 'CORS_ORIGINS'],
  NOTIFICATION_PREFIX: ['NOTIFICATION_PREFIX', 'PPR_NOTIFICATION_PREFIX'],
  DONOR_RECEIPTS: ['DONOR_RECEIPTS', 'PPR_DONOR_RECEIPTS', 'SEND_DONOR_RECEIPTS'],
  INTAKE_WEBHOOK_SECRET: ['INTAKE_WEBHOOK_SECRET', 'PPR_INTAKE_WEBHOOK_SECRET', 'INTAKE_SECRET'],
  SUPABASE_URL: ['SUPABASE_URL'],
  SUPABASE_SERVICE_ROLE_KEY: ['SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY'],
};

/** First non-empty value among the aliases for `name`, or `fallback`. */
export function env(name: string, fallback = ''): string {
  for (const key of ALIASES[name] ?? [name]) {
    const value = Deno.env.get(key);
    if (value && value.trim()) return value.trim();
  }
  return fallback;
}

export function hasEnv(name: string): boolean {
  return env(name) !== '';
}

/** A secret whose value reads as a deliberate "off". Unset means "on". */
export function envDisabled(name: string): boolean {
  return ['0', 'false', 'no', 'off'].includes(env(name).toLowerCase());
}

/**
 * Env var NAMES matching a pattern. Names only -- values are never returned,
 * so this is safe on an unauthenticated health endpoint. Exists to tell apart
 * "the secret was never set" from "the secret is set under a name this code
 * does not look for", which is otherwise indistinguishable from outside.
 */
export function envNamesMatching(pattern: RegExp): string[] {
  try {
    return Object.keys(Deno.env.toObject()).filter((name) => pattern.test(name)).sort();
  } catch {
    // Env enumeration not permitted in this runtime. Not fatal.
    return [];
  }
}

/**
 * WHICH alias supplied a secret. A name, never a value.
 *
 * `hasEnv` answering true is not the same as the right secret being set: the
 * alias lists above mean a stale `WEBHOOK_SECRET` left over from another
 * project satisfies STRIPE_WEBHOOK_SECRET just as well as the real one, and
 * every Stripe delivery then fails its signature check with the health endpoint
 * still reporting green.
 */
export function envSourceName(name: string): string | null {
  for (const key of ALIASES[name] ?? [name]) {
    const value = Deno.env.get(key);
    if (value && value.trim()) return key;
  }
  return null;
}

/**
 * A secret's SHAPE, for telling "wrong kind of secret" from "absent".
 *
 * Returns only the documented Stripe prefix and the length -- never the secret.
 * A signing secret that does not begin `whsec_` is not a signing secret, and
 * that single fact is usually the whole diagnosis.
 */
export function envShape(name: string): { prefix: string; length: number } | null {
  const value = env(name);
  if (!value) return null;
  const known = ['whsec_', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'pk_live_', 'pk_test_', 're_'];
  const prefix = known.find((candidate) => value.startsWith(candidate)) ?? 'unrecognised';
  return { prefix, length: value.length };
}

/**
 * Presence-only report for `GET ?health=1`. Returns booleans, never values, so
 * it is safe to expose unauthenticated -- it confirms setup without leaking a
 * single character of any secret.
 */
export function healthReport(required: string[], optional: string[] = []) {
  const secrets: Record<string, boolean> = {};
  for (const name of [...required, ...optional]) secrets[name] = hasEnv(name);
  const missing = required.filter((name) => !hasEnv(name));
  return { ok: missing.length === 0, configured: missing.length === 0, missing, secrets };
}
