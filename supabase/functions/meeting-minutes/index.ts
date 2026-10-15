// Meetings in the Board Center: transcribe a recording, and have Claude draft
// the minutes and pick out the action items.
//
// Why this exists: Google Meet recorded, transcribed and took notes for the
// team until June 2026, when the Workspace account moved to the no-cost
// Google Workspace for Nonprofits edition. That edition has no Meet
// recording, no transcripts and no Gemini notes, so the Board Center does it.
//
// Actions (POST, JSON body), every one for signed-in members of the team only:
//
//   { action: 'config' }                     which of the two services is set up
//   { action: 'transcribe', meeting_id }     send the recording to AssemblyAI
//   { action: 'status', meeting_id }         collect the transcript when it is ready
//   { action: 'paste', meeting_id, text }    a transcript from Meet, Zoom, Tactiq...
//   { action: 'draft', meeting_id }          Claude drafts the minutes
//
// GET ?health=1 reports which secrets are set -- booleans, never values.
//
// Who may call: the caller's own JWT is passed to public.is_member(), so the
// DATABASE decides, exactly as it does for every table the page reads. The
// function then works with the service role, because it writes the columns
// the page is not allowed to (meetings_guard).
//
// Where the words go. The recording leaves Supabase only as a signed link that
// expires, read once by AssemblyAI; the transcript is deleted from AssemblyAI
// as soon as it is collected. The transcript goes to Anthropic's API to be
// drafted from. Neither company trains on API data. If meetings are ever to
// include anything protected under HIPAA or 42 CFR Part 2, both need a signed
// BAA first -- the Board Center tells people not to record such meetings.

import Anthropic from 'npm:@anthropic-ai/sdk@0.130.0';
import { serviceClient } from '../_shared/db.ts';
import { env, hasEnv, healthReport } from '../_shared/env.ts';
import { fail, json, preflight } from '../_shared/http.ts';
import {
  MAX_TRANSCRIPT_CHARS, MINUTES_SCHEMA, MODEL, SYSTEM_PROMPT,
  matchOwner, realDay, renderMinutes, transcriptLines, userMessage,
  type MeetingMeta, type Minutes, type TeamMember, type Utterance,
} from './minutes.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const ASSEMBLY = 'https://api.assemblyai.com/v2/transcript';
const BUCKET = 'meeting-audio';

// The free plan stops a function 150 seconds after it starts, background work
// included. Claude is given a little less, so a slow draft ends in an error
// the page can explain rather than a row stuck on "drafting" forever.
const CLAUDE_TIMEOUT_MS = 135_000;
// A draft still "drafting" after this long was cut off by the platform.
const DRAFT_STALE_MS = 4 * 60_000;
// Long enough for AssemblyAI to fetch a large file from a queue.
const SIGNED_URL_SECONDS = 6 * 3600;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** Asks the database, with the caller's own token, whether they are on the
 *  team. Anything but a clear `true` is a refusal. */
async function callerIsMember(authHeader: string): Promise<{ ok: boolean; email: string }> {
  if (!authHeader) return { ok: false, email: '' };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_member`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: authHeader, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) return { ok: false, email: '' };
  if ((await res.json().catch(() => false)) !== true) return { ok: false, email: '' };

  // For the activity log only. Never used to decide anything.
  let email = '';
  try {
    const payload = JSON.parse(atob(authHeader.replace(/^Bearer\s+/i, '').split('.')[1]
      .replace(/-/g, '+').replace(/_/g, '/')));
    email = String(payload.email ?? '').toLowerCase();
  } catch { /* the log row can carry an empty actor rather than fail the call */ }
  return { ok: true, email };
}

async function logIt(actor: string, action: string, meetingId: string, detail: Row = {}) {
  try {
    await serviceClient().from('activity_log').insert({
      actor_email: actor, action, entity: 'meetings', entity_id: meetingId,
      detail: { via: 'meeting-minutes', ...detail },
    });
  } catch (err) {
    console.error('activity_log write failed', err);
  }
}

async function loadMeeting(id: string): Promise<Row | null> {
  const { data, error } = await serviceClient().from('meetings').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function saveMeeting(id: string, patch: Row): Promise<Row> {
  const { data, error } = await serviceClient().from('meetings').update(patch).eq('id', id)
    .select('*').single();
  if (error) throw new Error(error.message);
  return data;
}

/** What the page needs back after any action. Never the transcript itself --
 *  the page reads that through PostgREST, under RLS, when it wants it. */
function snapshot(m: Row) {
  return {
    id: m.id,
    transcript_status: m.transcript_status,
    transcript_error: m.transcript_error,
    minutes_status: m.minutes_status,
    minutes_error: m.minutes_error,
    duration_seconds: m.duration_seconds,
  };
}

// ------------------------------------------------------------- transcription

async function transcribe(m: Row, actor: string): Promise<Row> {
  if (!m.audio_path) throw new Error('This meeting has no recording to transcribe.');
  if (m.transcript_status === 'processing') return m;
  const key = env('ASSEMBLYAI_API_KEY');
  if (!key) {
    throw new Error('Transcription is not set up yet (ASSEMBLYAI_API_KEY). You can paste a transcript instead.');
  }

  const { data: signed, error } = await serviceClient().storage.from(BUCKET)
    .createSignedUrl(m.audio_path, SIGNED_URL_SECONDS);
  if (error || !signed?.signedUrl) throw new Error('Could not open the recording. Try uploading it again.');

  const res = await fetch(ASSEMBLY, {
    method: 'POST',
    headers: { authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: signed.signedUrl, speaker_labels: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) {
    console.error('AssemblyAI submit failed', res.status, body?.error);
    throw new Error('The transcription service did not accept the recording. Please try again in a minute.');
  }

  await logIt(actor, 'transcribe', m.id);
  return await saveMeeting(m.id, {
    transcript_status: 'processing', transcript_source: 'recording',
    transcript_job_id: body.id, transcript_error: null,
  });
}

/** Collects a finished transcript, and deletes AssemblyAI's copy of it. */
async function collect(m: Row): Promise<Row> {
  if (m.transcript_status !== 'processing' || !m.transcript_job_id) return m;
  const key = env('ASSEMBLYAI_API_KEY');
  if (!key) return m;

  const res = await fetch(`${ASSEMBLY}/${encodeURIComponent(m.transcript_job_id)}`, {
    headers: { authorization: key },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('AssemblyAI poll failed', res.status, body?.error);
    return m;
  }

  if (body.status === 'error') {
    return await saveMeeting(m.id, {
      transcript_status: 'error', transcript_job_id: null,
      transcript_error: String(body.error || 'The recording could not be transcribed.').slice(0, 500),
    });
  }
  if (body.status !== 'completed') return m;

  // deno-lint-ignore no-explicit-any
  const raw: any[] = Array.isArray(body.utterances) && body.utterances.length
    ? body.utterances
    : [{ speaker: 'A', text: body.text ?? '', start: 0, end: Math.round((body.audio_duration ?? 0) * 1000) }];
  const utterances: Utterance[] = raw
    .filter((u) => String(u.text ?? '').trim())
    .map((u) => ({ speaker: String(u.speaker ?? 'A'), text: String(u.text), start: +u.start || 0, end: +u.end || 0 }));

  const saved = await saveMeeting(m.id, {
    transcript_status: utterances.length ? 'completed' : 'error',
    transcript_error: utterances.length ? null : 'No speech was found in the recording.',
    transcript: utterances, transcript_text: null, transcript_job_id: null,
    duration_seconds: body.audio_duration ? Math.round(body.audio_duration) : m.duration_seconds,
  });

  // Their copy is no longer needed by anybody. Best effort: a failure here
  // leaves it under AssemblyAI's own retention rather than losing ours.
  fetch(`${ASSEMBLY}/${encodeURIComponent(m.transcript_job_id)}`, {
    method: 'DELETE', headers: { authorization: key },
  }).catch((err) => console.error('AssemblyAI delete failed', err));

  return saved;
}

// ----------------------------------------------------------------- drafting

async function team(): Promise<TeamMember[]> {
  const { data } = await serviceClient().from('staff_members').select('email,label').eq('active', true);
  return (data ?? []) as TeamMember[];
}

function transcriptFor(m: Row): string {
  if (Array.isArray(m.transcript) && m.transcript.length) {
    return transcriptLines(m.transcript as Utterance[], (m.speaker_names ?? {}) as Record<string, string>);
  }
  return String(m.transcript_text ?? '');
}

async function draftMinutes(m: Row, people: TeamMember[], effort: 'low' | 'medium') {
  const meta: MeetingMeta = { title: m.title, kind: m.kind, held_on: m.held_on, attendees: m.attendees };
  try {
    const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0 });
    // Streaming, so a long answer is never cut off by an idle HTTP connection.
    // `fallbacks: 'default'` lets the API finish on another model if a safety
    // classifier declines -- a recovery organization's meetings talk about
    // drugs and alcohol, which is exactly what a classifier can misread.
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: { type: 'json_schema', schema: MINUTES_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage(meta, transcriptFor(m), people) }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error('Claude declined to draft minutes from this transcript. Write them by hand, or ' +
        'check the transcript is of the right meeting.');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('The minutes came out longer than allowed. Try again, or split the transcript.');
    }
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const minutes = JSON.parse(text) as Minutes;

    const suggested = minutes.action_items
      .filter((a) => a.task.trim())
      .map((a) => ({
        title: a.task.trim(),
        owner_name: a.owner.trim(),
        assignee_email: matchOwner(a.owner, people),
        due_on: realDay(a.due_on),
        context: a.context.trim(),
      }));

    await saveMeeting(m.id, {
      minutes, minutes_text: renderMinutes(minutes, meta), minutes_status: 'draft', minutes_error: null,
      suggested_tasks: suggested, suggestions_handled: suggested.length === 0,
      mentions_participants: Boolean(minutes.mentions_participants), drafted_at: new Date().toISOString(),
    });
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      message = 'Claude took longer than the server allows. Choose Try again — the second attempt uses a faster setting.';
    } else if (err instanceof Anthropic.RateLimitError) {
      message = 'Claude is busy right now. Please try again in a minute.';
    } else if (err instanceof Anthropic.AuthenticationError) {
      message = 'The Claude API key is not valid. Whoever looks after the website needs to update ANTHROPIC_API_KEY.';
    } else if (err instanceof Anthropic.APIError) {
      console.error('Claude API error', err.status, err.message);
      message = 'Claude could not draft the minutes just now. Please try again.';
    } else if (err instanceof SyntaxError) {
      message = 'Claude’s answer could not be read. Please try again.';
    }
    console.error('draft failed', m.id, err);
    await saveMeeting(m.id, { minutes_status: 'error', minutes_error: message.slice(0, 500) })
      .catch((e) => console.error('could not record the failure', e));
  }
}

async function startDraft(m: Row, actor: string): Promise<Row> {
  if (!hasEnv('ANTHROPIC_API_KEY')) {
    throw new Error('Drafting is not set up yet (ANTHROPIC_API_KEY).');
  }
  if (m.minutes_status === 'approved') {
    throw new Error('These minutes are approved. Somebody with Manage access can reopen them first.');
  }
  const stillRunning = m.minutes_status === 'drafting' &&
    Date.now() - new Date(m.updated_at ?? 0).getTime() < DRAFT_STALE_MS;
  if (stillRunning) return m;

  const transcript = transcriptFor(m);
  if (!transcript.trim()) throw new Error('There is no transcript to draft from yet.');
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    throw new Error('This transcript is longer than a five-hour meeting. Split it and draft each part.');
  }

  // First try at the model's default effort. A retry -- usually after the
  // platform's time limit cut the first one off -- trades depth for speed.
  const attempts = Number(m.draft_attempts ?? 0) + 1;
  const effort = attempts > 1 && m.minutes_status !== 'draft' ? 'low' : 'medium';

  const started = await saveMeeting(m.id, {
    minutes_status: 'drafting', minutes_error: null, draft_attempts: attempts,
  });
  await logIt(actor, 'draft_minutes', m.id, { attempt: attempts, effort });

  const work = draftMinutes(started, await team(), effort);
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  else await work;
  return started;
}

// ------------------------------------------------------------------ handler

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('health') === '1') {
      return json(req, { ...healthReport(['ANTHROPIC_API_KEY'], ['ASSEMBLYAI_API_KEY']), model: MODEL });
    }
    return fail(req, 'Not found', 404);
  }
  if (req.method !== 'POST') return fail(req, 'Method not allowed', 405);

  const caller = await callerIsMember(req.headers.get('authorization') ?? '');
  if (!caller.ok) return fail(req, 'Sign in to the Board Center first.', 401);

  let body: Row;
  try { body = await req.json(); } catch { return fail(req, 'That request could not be read.'); }
  const action = String(body.action ?? '');

  if (action === 'config') {
    return json(req, {
      ok: true, transcription: hasEnv('ASSEMBLYAI_API_KEY'), drafting: hasEnv('ANTHROPIC_API_KEY'),
    });
  }

  const id = String(body.meeting_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(req, 'Which meeting?');

  try {
    const m = await loadMeeting(id);
    if (!m) return fail(req, 'That meeting no longer exists.', 404);

    if (action === 'transcribe') return json(req, { ok: true, meeting: snapshot(await transcribe(m, caller.email)) });
    if (action === 'status') return json(req, { ok: true, meeting: snapshot(await collect(m)) });
    if (action === 'draft') return json(req, { ok: true, meeting: snapshot(await startDraft(m, caller.email)) });

    if (action === 'paste') {
      const text = String(body.text ?? '').replace(/\r\n?/g, '\n').trim();
      if (text.length < 40) return fail(req, 'That is too short to be a meeting transcript.');
      if (text.length > MAX_TRANSCRIPT_CHARS) {
        return fail(req, 'That transcript is longer than a five-hour meeting. Split it into parts.');
      }
      if (m.transcript_status === 'processing') return fail(req, 'A recording of this meeting is being transcribed.');
      await logIt(caller.email, 'paste_transcript', m.id, { characters: text.length });
      const saved = await saveMeeting(m.id, {
        transcript_status: 'completed', transcript_source: 'pasted', transcript_text: text,
        transcript: null, transcript_error: null, transcript_job_id: null,
      });
      return json(req, { ok: true, meeting: snapshot(saved) });
    }

    return fail(req, 'Unknown action.');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    console.error(action, id, err);
    return fail(req, message, 400);
  }
});
