import crypto from 'crypto';
import { SolisCredentials } from '../types';

// SolisCloud Platform API V2.0.3 — signed HTTP client (server-side only).

// Bare content-type required — a charset suffix causes HMAC signature mismatch (HTTP 403).
const CONTENT_TYPE = 'application/json';

// Global FIFO queue: keeps requests ≥400 ms apart to respect the ~3 req/sec rate limit.
const MIN_REQUEST_SPACING_MS = 400;
const MAX_RETRIES_ON_429 = 2;

let lastRequestAt = 0;
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_SPACING_MS - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  chain = next.catch(() => undefined); // keep chain alive on failure
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

export async function solisPost<T>(creds: SolisCredentials, path: string, body: object): Promise<T> {
  return enqueue(() => sendWithRetry<T>(creds, path, body, 0));
}

async function sendOnce<T>(creds: SolisCredentials, path: string, body: object): Promise<T> {
  const bodyStr = JSON.stringify(body);
  const contentMd5 = md5Base64(bodyStr);
  const date = new Date().toUTCString(); // RFC-1123 GMT, must be within ±15 min of SolisCloud
  // HMAC-SHA1 canonical string: VERB\nContent-MD5\nContent-Type\nDate\nResource
  const canonical = `POST\n${contentMd5}\n${CONTENT_TYPE}\n${date}\n${path}`;
  const sign = hmacSha1Base64(creds.apiSecret, canonical);
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
  // Code 1004 = rate-limited inside a 200 OK envelope.
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

// Retries 429s with exponential back-off (1s, 2s).
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
