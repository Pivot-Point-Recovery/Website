// Input validation and normalisation.
//
// Everything a browser sends is untrusted. These helpers bound length, strip
// control characters, and escape anything destined for an HTML email body.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Control characters, keeping \t and \n which are legitimate in a message body.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Trim, drop control characters, and cap length. Non-strings become ''. */
export function str(value: unknown, maxLength = 2000): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, maxLength);
}

export function email(value: unknown): string {
  const candidate = str(value, 254).toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : '';
}

export function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** Bounded integer. Anything unparseable becomes `fallback`. */
export function int(value: unknown, min: number, max: number, fallback = min): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function strList(value: unknown, maxItems = 25, maxLength = 200): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v, maxLength)).filter(Boolean).slice(0, maxItems);
}

/** Escape for interpolation into an HTML email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Cents -> "$1,234.56". Empty string for anything non-numeric. */
export function money(cents: number | null | undefined): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return '';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
