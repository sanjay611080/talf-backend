import crypto from 'crypto';
import { SolisCredentials } from '../types';

/**
 * Low-level signed HTTP client for the SolisCloud Platform API (V2.0.3).
 *
 * Every request must carry Content-MD5, Content-Type, Date, and Authorization
 * headers. The Authorization signature is an HMAC-SHA1 over a canonical string,
 * keyed with the API secret — which is why this can only run server-side.
 */

// SolisCloud signs against a bare "application/json" content type — adding a
// charset suffix makes the signature mismatch and the API returns HTTP 403.
const CONTENT_TYPE = 'application/json';

// SolisCloud rate-limits to ~3 req/sec per API key. Every request goes through
// a single FIFO queue with a small spacing so the cron sync and live-data
// requests never collide and produce HTTP 429.
const MIN_REQUEST_SPACING_MS = 400;
// Up to two retries with exponential back-off when SolisCloud returns 429.
const MAX_RETRIES_ON_429 = 2;

let lastRequestAt = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Serialize fn through the global queue, enforcing min spacing between sends. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_SPACING_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain even if fn rejects, so one failure doesn't poison the queue.
  chain = next.catch(() => undefined);
  return next;
}

interface SolisEnvelope<T> {
  success?: boolean;
  code: string | number;
  msg: string;
  data: T;
}

function md5Base64(body: string): string {
  return crypto.createHash('md5').update(body, 'utf8').digest('base64');
}

function hmacSha1Base64(secret: string, payload: string): string {
  return crypto.createHmac('sha1', secret).update(payload, 'utf8').digest('base64');
}

/**
 * Performs a signed POST to a SolisCloud endpoint and unwraps the
 * { success, code, msg, data } envelope.
 *
 * @param path canonical resource path, e.g. "/v1/api/userStationList"
 */
export async function solisPost<T>(creds: SolisCredentials, path: string, body: object): Promise<T> {
  return enqueue(() => sendWithRetry<T>(creds, path, body, 0));
}

/**
 * Single signed POST. Rebuilds Content-MD5 / Date / signature on every retry
 * because the Date header drifts and SolisCloud rejects stale signatures.
 */
async function sendOnce<T>(creds: SolisCredentials, path: string, body: object): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const contentMd5 = md5Base64(bodyStr);
  // RFC-1123 GMT date. Must be within +/-15 minutes of the SolisCloud server.
  const date = new Date().toUTCString();

  // Canonical string: VERB \n Content-MD5 \n Content-Type \n Date \n Resource
  const canonical = `POST\n${contentMd5}\n${CONTENT_TYPE}\n${date}\n${path}`;
  const sign = hmacSha1Base64(creds.apiSecret, canonical);
  // SolisCloud expects a space between "API" and the key id.
  const authorization = `API ${creds.apiId}:${sign}`;

  const url = creds.baseUrl.replace(/\/+$/, '') + path;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': CONTENT_TYPE,
        'Content-MD5': contentMd5,
        Date: date,
        Authorization: authorization,
      },
      body: bodyStr,
    });
  } catch {
    throw new Error('Could not reach SolisCloud. Check the API base URL and network connection.');
  }

  if (response.status === 429) {
    const err = new Error('SolisCloud responded with HTTP 429') as Error & { status?: number };
    err.status = 429;
    throw err;
  }
  if (!response.ok) {
    throw new Error(`SolisCloud responded with HTTP ${response.status}`);
  }

  const json = (await response.json()) as SolisEnvelope<T>;
  const code = String(json.code);
  // SolisCloud sometimes returns 200 with a rate-limit code in the envelope.
  if (code === '1004' || /flow.*limit|too many|rate/i.test(json.msg || '')) {
    const err = new Error(`SolisCloud rate-limited (code ${code}): ${json.msg}`) as Error & { status?: number };
    err.status = 429;
    throw err;
  }
  if (code !== '0') {
    throw new Error(`SolisCloud API error (code ${code}): ${json.msg || 'unknown error'}`);
  }
  return json.data;
}

/** Retries 429s with exponential back-off, keeping the queue lock held so the
 *  back-off also throttles every other waiting request. */
async function sendWithRetry<T>(creds: SolisCredentials, path: string, body: object, attempt: number): Promise<T> {
  try {
    return await sendOnce<T>(creds, path, body);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 429 && attempt < MAX_RETRIES_ON_429) {
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s
      await new Promise((r) => setTimeout(r, backoff));
      return sendWithRetry<T>(creds, path, body, attempt + 1);
    }
    throw err;
  }
}
