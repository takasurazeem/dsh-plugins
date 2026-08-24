// Shared HTTP + error classification for the search providers.
//
// Every provider talks through `http()`, so unit tests can substitute a
// fake fetch, and so one place decides what a failure means for the
// fallback chain:
//
//   timeout / network / server / auth / quota / rate / parse / bad-request
//     → the chain moves on to the next provider (recorded, not fatal)
//   caller abort (the tool's timeout or the user cancelling)
//     → the chain stops immediately
//
// No provider is retried: one attempt per provider per search call keeps
// the worst-case latency bounded.

const TIMEOUT = Symbol('websearch-dsh timeout');

/**
 * One HTTP request with timeout, abort, and JSON (and text) decoding.
 *
 * Resolves with `{status, ok, text, json}` — HTTP status is never a throw.
 * Throws only on timeout / network failure / abort; the thrown error has
 * a machine-routable `code` (`'timeout'` | `'network'` | `'aborted'`).
 *
 * @param {object} p
 * @param {string} p.url
 * @param {string} [p.method]
 * @param {object} [p.headers]
 * @param {object|string} [p.body] objects are JSON-encoded
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @param {Function} [p.fetch] injectable for tests
 * @param {string} [p.accept]
 */
export async function http({ url, method = 'GET', headers, body, timeoutMs, signal, fetch, accept = 'application/json' }) {
  const doFetch = typeof fetch === 'function' ? fetch : globalThis.fetch;
  if (typeof doFetch !== 'function') throw fail('network', 'no fetch implementation available');

  const reqHeaders = { accept, ...(headers ?? {}) };
  const opts = { method, headers: reqHeaders };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    reqHeaders['content-type'] = 'application/json';
  }

  // One abort controller combines the caller signal and our timeout so
  // older runtimes need neither AbortSignal.any nor AbortSignal.timeout.
  const ctrl = new AbortController();
  let timedOut = false;
  let timer;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
  }
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  let res;
  try {
    res = await doFetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    const code = timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network';
    throw fail(code, `${method} ${hostOf(url)}: ${errMsg(err)} (timed out: ${timedOut})`);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  const text = typeof res.text === 'function' ? await res.text() : '';
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text, json };
}

/** A failure with a machine-routable code the chain records per provider. */
export class ProviderError extends Error {
  constructor(code, provider, message) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
    this.code = code;
    this.provider = provider;
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Classify an HTTP status (+ response body) into a provider-failure code.
 * The body text is sniffed for quota wording because several vendors
 * answer quota exhaustion with 401/403/429 and a message rather than a
 * distinct status.
 */
const QUOTA_RE = /quota|exhaust|credit|insufficient|over ?the ?limit|rate.?limit.*exceeded|billing|payment|subscription|unpaid|plan/i;
const RATE_RE = /rate.?limit|too many requests|try again|temporar/i;

export function classifyHttpFailure(status, text) {
  const t = String(text ?? '');
  if (status === 429) return QUOTA_RE.test(t) ? 'quota' : 'rate';
  if (status === 401 || status === 403) return QUOTA_RE.test(t) ? 'quota' : 'auth';
  if (status === 402) return 'quota';
  if (status >= 500) return 'server';
  return 'bad-request';
}

/**
 * Classify an in-band failure message (200 OK but {success:false, error}).
 * Vendors that report quota/rate problems in-band with HTTP 200.
 */
export function classifyInBandFailure(detail) {
  const t = String(detail ?? '');
  if (QUOTA_RE.test(t)) return 'quota';
  if (RATE_RE.test(t)) return 'rate';
  return 'bad-request';
}

/** Human-readable reasons for the recorded failure codes (status tool). */
export const FAILURE_CODES = {
  auth: 'authentication failed (bad, revoked, or expired key)',
  quota: 'quota / credits exhausted',
  rate: 'rate limited (429)',
  server: 'provider server error (5xx)',
  timeout: 'timed out',
  network: 'network failure',
  parse: 'response was not parseable',
  'bad-request': 'request rejected (4xx)',
  error: 'unexpected error',
};

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errMsg(err) {
  return err?.message ? err.message : String(err);
}

/** Trim long provider error bodies for the recorded message. */
export function shortText(s, n = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
