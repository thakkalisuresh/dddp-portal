/**
 * Reading a payment screenshot with a vision model.
 *
 * Deliberately optional. If no key is configured, or the provider is down, or
 * the model returns nonsense, the upload still succeeds and the proof queues
 * as unreadable for the treasurer to look at. The OCR is a convenience that
 * saves them typing — it is never a gate on a resident paying their bill.
 */

import { normaliseVisionResult } from './proof.js';
import { reportError, fail } from './errors.js';

// Residents send whatever their bank or payment app produced: Google Pay,
// PhonePe, slice, Kiwi, and plain NEFT/IMPS transfer summaries. Naming only
// UPI, and asking only for a "12-digit reference", described a narrower input
// than we actually receive and left the reference null on anything else.
const PROMPT = `This is a screenshot of an Indian payment confirmation — UPI, IMPS or NEFT.
Return ONLY a JSON object with these keys, using null where you cannot read a value:
{"amount": number, "utr": "12-digit UTR or RRN if shown", "reference": "the app's own transaction id", "date": "YYYY-MM-DD", "payee": string}
The amount is the rupees transferred.
If the screenshot shows both a 12-digit UTR/RRN and a longer app transaction id,
put the 12-digit one in "utr" and the other in "reference".
Do not guess; use null if unsure.`;

const TIMEOUT_MS = 12_000;

export function visionAvailable(env) {
  return Boolean(env.GROQ_API_KEY || env.GEMINI_API_KEY);
}

/**
 * @returns {{ parsed: object, provider: string|null, ok: boolean, reason?: string }}
 */
export async function readReceipt(env, bytes, contentType) {
  if (!visionAvailable(env)) {
    return { parsed: emptyResult(), provider: null, ok: false, reason: 'no-key' };
  }

  const base64 = bytesToBase64(bytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const raw = env.GROQ_API_KEY
      ? await callGroq(env, base64, contentType, controller.signal)
      : await callGemini(env, base64, contentType, controller.signal);

    const parsed = normaliseVisionResult(raw);
    if (parsed.amount == null && parsed.utr == null) {
      await reportError(env, 'DDP-PROOF-003', { raw: JSON.stringify(raw).slice(0, 300) });
      return { parsed, provider: env.GROQ_API_KEY ? 'groq' : 'gemini', ok: false, reason: 'unreadable' };
    }
    return { parsed, provider: env.GROQ_API_KEY ? 'groq' : 'gemini', ok: true };
  } catch (err) {
    // A provider outage must not stop someone paying their bill. Report the
    // specific cause when we have one rather than flattening everything to
    // "unreadable" — a 429 and a garbled response need different responses.
    await reportError(env, err?.code ?? 'DDP-PROOF-003', err);
    return { parsed: emptyResult(), provider: null, ok: false, reason: 'provider-error' };
  } finally {
    clearTimeout(timer);
  }
}

function emptyResult() {
  return { amount: null, utr: null, date: null, payee: null };
}

async function callGroq(env, base64, contentType, signal) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } },
        ],
      }],
    }),
  });
  if (!res.ok) fail('DDP-PROOF-007', { provider: 'groq', status: res.status });
  const body = await res.json();
  return safeJson(body?.choices?.[0]?.message?.content);
}

async function callGemini(env, base64, contentType, signal) {
  const model = env.GEMINI_VISION_MODEL || 'gemini-2.0-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: contentType, data: base64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    }
  );
  if (!res.ok) fail('DDP-PROOF-007', { provider: 'gemini', status: res.status });
  const body = await res.json();
  return safeJson(body?.candidates?.[0]?.content?.parts?.[0]?.text);
}

/** Models sometimes wrap JSON in prose or a code fence. */
export function safeJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  const fenced = String(text).replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(fenced);
  } catch {
    const match = fenced.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}
