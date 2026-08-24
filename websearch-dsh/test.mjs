#!/usr/bin/env node
// websearch-dsh test suite — plain Node, no test framework, no network.
//
// Runs from the source checkout (the dsh runtime packages are optional here;
// tool-validation tests adapt to their resolvability) and from the installed
// copy in a profile's node_modules, where the real packages resolve and
// everything runs.

import assert from 'node:assert/strict';

import { normalizeConfig, Config, defaults, DEFAULT_PRIORITY, DEFAULT_ENV_KEYS, PROVIDER_ID, OWNER } from './src/config.js';
import { http, classifyHttpFailure, ProviderError, FAILURE_CODES, shortText } from './src/http.js';
import { resolveApiKey } from './src/keys.js';
import { tavily, exa, firecrawl, brave, serper } from './src/providers/index.js';
import { duckduckgo } from './src/providers/duckduckgo.js';
import { createSearchChain } from './src/fallback.js';
import { registerTools } from './src/tools.js';
import { registerWebSearchSettings, SETTINGS_NAMESPACE } from './src/settings.js';
import { apply, name as pluginName } from './index.js';

let dshTools = null;
let dshCredentials = null;
let jsYaml = null;
try {
  dshTools = await import('@deepseek-ai/dsh-tools');
} catch {
  // bare checkout outside a dsh profile — fine, the tests below adapt
}
try {
  dshCredentials = await import('@deepseek-ai/dsh-credentials');
} catch {
  // same
}
try {
  jsYaml = await import('js-yaml');
} catch {
  // same
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['pass', name]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push(['fail', name]);
    console.error(`  FAIL  ${name}\n        ${err?.stack ?? err}`);
  }
}

/** Like test(), but network-shaped failures are recorded as a skip. */
async function testSkippable(name, fn) {
  try {
    await fn();
    results.push(['pass', name]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    const networkish =
      err?.code === 'network' ||
      err?.code === 'timeout' ||
      err?.name === 'TypeError' ||
      err?.name === 'AbortError' ||
      /network|timed out|no DuckDuckGo leg|All web search providers failed/i.test(String(err?.message ?? ''));
    if (networkish) {
      results.push(['skip', name]);
      console.log(`  skip  ${name} (offline: ${String(err?.message ?? err).slice(0, 80)})`);
    } else {
      results.push(['fail', name]);
      console.error(`  FAIL  ${name}\n        ${err?.stack ?? err}`);
    }
  }
}

// ── fakes ─────────────────────────────────────────────────────────────────

/**
 * A fetch double. `route(url, opts)` may return:
 *   - a Response-like {status, text?} (text() is provided)
 *   - a string (treated as the body of a 200)
 *   - throw (network/abort style failure)
 * Every call is appended to `log` as {url, opts}.
 */
function fakeFetch(route, log = []) {
  // Every path must return a Response-like object with .status/.ok/.text()
  // — exactly what the real fetch always returns (a promise route used to
  // skip the wrap and hand http() a raw route value).
  const wrap = (r) => {
    if (typeof r === 'string') r = { status: 200, body: r };
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      text: async () => (r.body !== undefined ? r.body : r.text ?? ''),
    };
  };
  const fn = async (url, opts = {}) => {
    log.push({ url: String(url), opts });
    let r = route(String(url), opts);
    if (r && typeof r.then === 'function') r = await r;
    return wrap(r);
  };
  return { fn, log };
}

const ENV_EMPTY = {};
const ENV_KEYS = {
  TAVILY_API_KEY: 'tv-key',
  EXA_API_KEY: 'exa-key',
  SERPER_API_KEY: 'sp-key',
};

function chainWith({ env = ENV_EMPTY, fetch, config } = {}) {
  return createSearchChain({
    config: config ?? normalizeConfig({}),
    ctx: undefined,
    env,
    fetch,
  });
}

const TAVILY_OK = (n = 3) => ({
  status: 200,
  body: JSON.stringify({
    results: Array.from({ length: n }, (_, i) => ({
      title: `Tavily result ${i}`,
      url: `https://tavily.example.com/${i}`,
      content: `Snippet ${i}`,
      score: 0.9 - i * 0.1,
      published_date: i % 2 ? '2026-08-01' : undefined,
    })),
  }),
});
const EXA_OK = (n = 3) => ({
  status: 200,
  body: JSON.stringify({
    results: Array.from({ length: n }, (_, i) => ({
      url: `https://exa.example.com/${i}`,
      title: `Exa ${i}`,
      text: `Exa text ${i}`,
      publishedDate: '2026-07-14',
    })),
  }),
});
const FIRECRAWL_OK = (n = 3) => ({
  status: 200,
  body: JSON.stringify({ success: true, data: Array.from({ length: n }, (_, i) => ({ url: `https://fc.example.com/${i}`, title: `FC ${i}`, description: `FC desc ${i}` })) }),
});
const BRAVE_OK = (n = 3) => ({
  status: 200,
  body: JSON.stringify({ web: { results: Array.from({ length: n }, (_, i) => ({ url: `https://brave.example.com/${i}`, title: `Brave ${i}`, description: `Brave ${i} desc`, page_age: '2026-06-30' })) } }),
});
const SERPER_OK = (n = 3) => ({
  status: 200,
  body: JSON.stringify({ organic: Array.from({ length: n }, (_, i) => ({ title: `Serper ${i}`, link: `https://serper.example.com/${i}`, snippet: `Serper ${i} snip`, date: 'Jun 30, 2026' })) }),
});

// DuckDuckGo fixtures
const VQD_PAGE = '<html><script>var vqd="4-1234567890";</script><body>hi</body></html>';
const DJS_OK = {
  status: 200,
  body: JSON.stringify({
    results: [
      { u: 'https://a.example.com/x', t: 'Title &amp; more', a: '<b>Body</b> text' },
      { u: 'https://a.example.com/x', t: 'duplicate', a: 'dup' },
      { u: 'http://www.google.com/search?q=hello', t: 'noise', a: 'noise' },
      { u: 'https://b.example.com/y', t: 'B', a: 'B body' },
      null,
    ],
  }),
};
const LITE_OK = `<html><body><table>
<tr><td><a rel="nofollow" href="/l/?rut=1&amp;uddg=https%3A%2F%2Flite.example.com%2Fpage1" class="result-link">Lite Title One</a></td></tr>
<tr><td class="result-snippet">Lite snippet &amp; entities one</td></tr>
<tr><td><a rel="nofollow" href="https://direct.example.com/page2" class="result-link">Lite Title Two</a></td></tr>
<tr><td class="result-snippet">Lite snippet two</td></tr>
</table></body></html>`;
const LITE_CHALLENGE = '<html><head><link rel="canonical" href="https://duckduckgo.com/"></head><body>challenge</body></html>';
const INSTANT_OK = {
  status: 200,
  body: JSON.stringify({
    Heading: 'DuckDuckGo',
    Abstract: 'DDG is a privacy search engine.',
    AbstractURL: 'https://en.wikipedia.org/wiki/DuckDuckGo',
    RelatedTopics: [
      { Text: 'DuckDuckGo privacy features', FirstURL: 'https://duckduckgo.com/privacy' },
      { Name: 'Related Search', Topics: [{ Text: 'x', FirstURL: 'https://x' }] },
      { Text: 'Second topic', FirstURL: 'https://topic.example.com/2' },
    ],
  }),
};
const DDG_ROUTE = (log) => (url) => {
  if (url.includes('links.duckduckgo.com/d.js')) return DJS_OK;
  if (url.includes('lite.duckduckgo.com')) return { status: 202, body: LITE_CHALLENGE };
  if (url.includes('api.duckduckgo.com')) return INSTANT_OK;
  if (url.includes('duckduckgo.com/?q=')) return { status: 200, body: VQD_PAGE };
  return { status: 404, body: '' };
};

// ═══════════════════════════════════════════════════════════════════════════
// config
// ═══════════════════════════════════════════════════════════════════════════

await test('config: empty raw → exact defaults', () => {
  assert.deepEqual(normalizeConfig({}), defaults);
  assert.deepEqual(normalizeConfig(undefined), defaults);
  assert.deepEqual(normalizeConfig('nonsense'), defaults);
  assert.deepEqual(normalizeConfig([]), defaults);
});

await test('config: partial overrides merge over defaults', () => {
  const c = normalizeConfig({
    provenance: 'always',
    providerTimeoutMs: 5000,
    context: { order: 200 },
  });
  assert.equal(c.provenance, 'always');
  assert.equal(c.providerTimeoutMs, 5000);
  assert.equal(c.context.order, 200);
  assert.equal(c.context.enabled, defaults.context.enabled);
  assert.deepEqual(c.priority, DEFAULT_PRIORITY);
  assert.deepEqual(c.envKeys, DEFAULT_ENV_KEYS);
});

await test('config: invalid values fall back to defaults', () => {
  const c = normalizeConfig({
    provenance: 'bogus',
    providerTimeoutMs: -5,
    context: 'nope',
    priority: 42,
  });
  assert.equal(c.provenance, defaults.provenance);
  assert.equal(c.providerTimeoutMs, defaults.providerTimeoutMs);
  assert.equal(c.context.enabled, defaults.context.enabled);
  assert.equal(c.context.order, defaults.context.order);
  assert.deepEqual(c.priority, DEFAULT_PRIORITY);
});

await test('config: envKeys partial override keeps the rest', () => {
  const c = normalizeConfig({ envKeys: { tavily: 'MY_TAVILY', brave: '' } });
  assert.equal(c.envKeys.tavily, 'MY_TAVILY');
  assert.equal(c.envKeys.brave, DEFAULT_ENV_KEYS.brave); // empty → default
  assert.equal(c.envKeys.serper, DEFAULT_ENV_KEYS.serper);
  assert.equal(c.envKeys.exa, DEFAULT_ENV_KEYS.exa);
});

await test('config: priority reorder, dedupe, unknown filtered', () => {
  assert.deepEqual(normalizeConfig({ priority: ['serper', 'tavily', 'tavily', 'nope'] }).priority, ['serper', 'tavily']);
  assert.deepEqual(normalizeConfig({ priority: ['nope', 'also-nope'] }).priority, DEFAULT_PRIORITY);
  assert.deepEqual(normalizeConfig({ priority: [] }).priority, DEFAULT_PRIORITY);
  assert.deepEqual(normalizeConfig({ priority: 'nope' }).priority, DEFAULT_PRIORITY);
});

await test('Config contract: validate is synchronous, ~standard v1', () => {
  const v = Config['~standard'].validate({ provenance: 'off' });
  assert.ok(v && typeof v === 'object' && !(v instanceof Promise));
  assert.equal(v.value.provenance, 'off');
  assert.equal(Config['~standard'].version, 1);
  const bad = Config['~standard'].validate(null);
  assert.ok(Array.isArray(bad.issues) && bad.issues.length > 0);
  const bad2 = Config['~standard'].validate([1]);
  assert.ok(Array.isArray(bad2.issues));
});

await test('Config.simplify matches normalizeConfig', () => {
  const raw = { provenance: 'always', providerTimeoutMs: 3333, context: { enabled: false, order: 5 } };
  assert.deepEqual(Config.simplify(raw), normalizeConfig(raw));
});

// ═══════════════════════════════════════════════════════════════════════════
// http + classification
// ═══════════════════════════════════════════════════════════════════════════

await test('http: 200 JSON decodes to {ok, json, text}', async () => {
  const { fn } = fakeFetch(() => ({ status: 200, body: '{"a":[1,2]}' }));
  const r = await http({ url: 'https://x.test/', fetch: fn });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { a: [1, 2] });
  assert.equal(r.text, '{"a":[1,2]}');
});

await test('http: 200 non-JSON → json undefined, text kept', async () => {
  const { fn } = fakeFetch(() => ({ status: 200, body: '<html>hi</html>' }));
  const r = await http({ url: 'https://x.test/', fetch: fn });
  assert.equal(r.json, undefined);
  assert.equal(r.text, '<html>hi</html>');
});

await test('http: POST encodes object body + content-type', async () => {
  let seen;
  const { fn } = fakeFetch((url, opts) => {
    seen = { url, opts };
    return { status: 200, body: '{}' };
  });
  await http({ url: 'https://x.test/', method: 'POST', body: { q: 'a b' }, fetch: fn });
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['content-type'], 'application/json');
  assert.equal(seen.opts.body, JSON.stringify({ q: 'a b' }));
});

await test('classifyHttpFailure: 429 bare → rate; 429 + quota text → quota', () => {
  assert.equal(classifyHttpFailure(429, ''), 'rate');
  assert.equal(classifyHttpFailure(429, 'Too many requests: quota exceeded'), 'quota');
});

await test('classifyHttpFailure: 401 auth / 403 quota-sniff / 402 / 5xx / 400', () => {
  assert.equal(classifyHttpFailure(401, 'invalid api key'), 'auth');
  assert.equal(classifyHttpFailure(403, ''), 'auth');
  assert.equal(classifyHttpFailure(403, 'insufficient credits'), 'quota');
  assert.equal(classifyHttpFailure(402, 'payment required'), 'quota');
  assert.equal(classifyHttpFailure(503, 'upstream down'), 'server');
  assert.equal(classifyHttpFailure(400, 'bad request'), 'bad-request');
});

await test('http: timeout aborts the request and codes "timeout"', async () => {
  const { fn, log } = fakeFetch((url, opts) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new DOMException('forced', 'TimeoutError')), 200);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      });
    }),
  );
  let err;
  try {
    await http({ url: 'https://x.test/', timeoutMs: 20, fetch: fn });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected a throw');
  assert.equal(err.code, 'timeout');
  assert.equal(log.length, 1);
});

await test('http: pre-aborted signal codes "aborted"', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const { fn } = fakeFetch((url, opts) => {
    throw new DOMException('aborted', 'AbortError');
  });
  let err;
  try {
    await http({ url: 'https://x.test/', signal: ctrl.signal, fetch: fn });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, 'aborted');
});

await test('http: network rejection codes "network"', async () => {
  const { fn } = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  let err;
  try {
    await http({ url: 'https://x.test/', fetch: fn });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, 'network');
});

await test('shortText trims and caps; FAILURE_CODES covers every code', () => {
  assert.equal(shortText('  a   b  ', 5), 'a b');
  assert.ok(shortText('x'.repeat(500), 10).length <= 10);
  for (const c of ['auth', 'quota', 'rate', 'server', 'timeout', 'network', 'parse', 'bad-request']) {
    assert.ok(FAILURE_CODES[c], `missing code ${c}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// key resolution
// ═══════════════════════════════════════════════════════════════════════════

function fakeCtx(creds) {
  return { get: (id) => (id === 'credentials' ? creds : undefined) };
}

await test('keys: credential-store ref wins over env', async () => {
  const creds = { resolve: async (ref) => ({ value: 'stored-key' }) };
  const k = await resolveApiKey(fakeCtx(creds), 'TAVILY_API_KEY', { TAVILY_API_KEY: 'env-key' });
  assert.equal(k, 'stored-key');
});

await test('keys: empty store ref falls through to env', async () => {
  const creds = { resolve: async () => undefined };
  const k = await resolveApiKey(fakeCtx(creds), 'EXA_API_KEY', { EXA_API_KEY: '  env-key ' });
  assert.equal(k, 'env-key');
});

await test('keys: no store, no env → ""; bad ref name never throws', async () => {
  const creds = { resolve: async () => { throw new Error('boom'); } };
  assert.equal(await resolveApiKey(fakeCtx(creds), 'EXA_API_KEY', {}), '');
  assert.equal(await resolveApiKey(fakeCtx(creds), 'bad-name!!', { 'bad-name!!': 'x' }), 'x');
  assert.equal(await resolveApiKey(undefined, 'TAVILY_API_KEY', { TAVILY_API_KEY: 'env' }), 'env');
});

await test('keys: real credentialRef accepts the provider env names (when resolvable)', async () => {
  if (!dshCredentials) return; // bare checkout — the fake above covers the logic
  for (const n of Object.values(DEFAULT_ENV_KEYS)) {
    assert.equal(dshCredentials.credentialRef(n), n);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// providers: request shape + response mapping + error codes
// ═══════════════════════════════════════════════════════════════════════════

const O = { key: 'k', maxResults: 3, timeoutMs: 1000, legTimeoutMs: 800, signal: undefined };

await test('tavily: POST shape (bearer + api_key, query, max_results, depth)', async () => {
  let seen;
  const { fn } = fakeFetch((url, opts) => {
    seen = { url, opts };
    return TAVILY_OK();
  });
  await tavily.search('hello world', { ...O, key: 'tvk', fetch: fn });
  assert.equal(seen.url, 'https://api.tavily.com/search');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers.authorization, 'Bearer tvk');
  assert.deepEqual(JSON.parse(seen.opts.body), {
    query: 'hello world',
    max_results: 3,
    search_depth: 'basic',
    include_answer: false,
    api_key: 'tvk',
  });
});

await test('tavily: maps results → sources, caps, skips url-less', async () => {
  const { fn } = fakeFetch(() => ({
    status: 200,
    body: JSON.stringify({ results: [{ title: 'A', url: 'https://a', content: 'sa', published_date: '2026-01-01' }, { title: 'no url' }, { title: 'B', url: 'https://b', content: 'sb' }] }),
  }));
  const { sources } = await tavily.search('q', { ...O, key: 'k', fetch: fn });
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], { url: 'https://a', title: 'A', snippet: 'sa', publishedAt: '2026-01-01' });
  assert.deepEqual(sources[1], { url: 'https://b', title: 'B', snippet: 'sb' });
});

await test('tavily: 429 → rate, 401 → auth, non-JSON → parse', async () => {
  const mk = (r) =>
    (async () => {
      try {
        await tavily.search('q', { ...O, key: 'k', fetch: fakeFetch(() => r).fn });
        assert.fail('expected throw');
      } catch (err) {
        return err;
      }
    })();
  assert.equal((await mk({ status: 429, body: 'slow down' })).code, 'rate');
  assert.equal((await mk({ status: 401, body: 'bad key' })).code, 'auth');
  assert.equal((await mk({ status: 200, body: '<html>nope</html>' })).code, 'parse');
});

await test('exa: POST shape (x-api-key, numResults, type)', async () => {
  let seen;
  const { fn } = fakeFetch((url, opts) => {
    seen = { url, opts };
    return EXA_OK();
  });
  await exa.search('q', { ...O, key: 'exk', fetch: fn });
  assert.equal(seen.url, 'https://api.exa.ai/search');
  assert.equal(seen.opts.headers['x-api-key'], 'exk');
  assert.deepEqual(JSON.parse(seen.opts.body), { query: 'q', numResults: 3, type: 'auto' });
});

await test('exa: maps results (text→snippet, publishedDate) + 403 quota sniff', async () => {
  const { fn } = fakeFetch(() => EXA_OK(1));
  const { sources } = await exa.search('q', { ...O, key: 'k', fetch: fn });
  assert.deepEqual(sources[0], { url: 'https://exa.example.com/0', title: 'Exa 0', snippet: 'Exa text 0', publishedAt: '2026-07-14' });
  let err;
  try {
    await exa.search('q', { ...O, key: 'k', fetch: fakeFetch(() => ({ status: 403, body: 'quota exhausted' })).fn });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'quota');
});

await test('firecrawl: POST shape (bearer, limit, sources) + mapping', async () => {
  let seen;
  const { fn } = fakeFetch((url, opts) => {
    seen = { url, opts };
    return FIRECRAWL_OK(1);
  });
  const { sources } = await firecrawl.search('q', { ...O, key: 'fck', fetch: fn });
  assert.equal(seen.url, 'https://api.firecrawl.dev/v1/search');
  assert.equal(seen.opts.headers.authorization, 'Bearer fck');
  assert.deepEqual(JSON.parse(seen.opts.body), { query: 'q', limit: 3, sources: ['web'] });
  assert.deepEqual(sources[0], { url: 'https://fc.example.com/0', title: 'FC 0', snippet: 'FC desc 0' });
});

await test('firecrawl: in-band success:false with quota text → quota', async () => {
  let err;
  try {
    await firecrawl.search('q', {
      ...O,
      key: 'k',
      fetch: fakeFetch(() => ({ status: 200, body: JSON.stringify({ success: false, error: 'credits exhausted' }) })).fn,
    });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'quota');
});

await test('brave: GET shape (query string, X-Subscription-Token) + mapping', async () => {
  let seen;
  const { fn } = fakeFetch((url, opts) => {
    seen = { url, opts };
    return BRAVE_OK(1);
  });
  const { sources } = await brave.search('hello world', { ...O, key: 'bvk', fetch: fn });
  assert.ok(seen.url.startsWith('https://api.search.brave.com/res/v1/web/search?'));
  assert.equal(new URL(seen.url).searchParams.get('q'), 'hello world');
  assert.equal(new URL(seen.url).searchParams.get('count'), '3');
  assert.equal(seen.opts.headers['x-subscription-token'], 'bvk');
  assert.deepEqual(sources[0], { url: 'https://brave.example.com/0', title: 'Brave 0', snippet: 'Brave 0 desc', publishedAt: '2026-06-30' });
});

await test('brave: 401 → auth', async () => {
  let err;
  try {
    await brave.search('q', { ...O, key: 'k', fetch: fakeFetch(() => ({ status: 401, body: 'unauthorized' })).fn });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'auth');
});

await test('serper: POST shape (X-API-KEY, q/num/gl) + organic mapping', async () => {
  let seen;
  const { fn } = fakeFetch((url, opts) => {
    seen = { url, opts };
    return SERPER_OK(1);
  });
  const { sources } = await serper.search('q', { ...O, key: 'spk', fetch: fn });
  assert.equal(seen.url, 'https://google.serper.dev/search');
  assert.equal(seen.opts.headers['x-api-key'], 'spk');
  assert.deepEqual(JSON.parse(seen.opts.body), { q: 'q', num: 3, gl: 'us' });
  assert.deepEqual(sources[0], { url: 'https://serper.example.com/0', title: 'Serper 0', snippet: 'Serper 0 snip', publishedAt: 'Jun 30, 2026' });
});

await test('serper: 429 → rate', async () => {
  let err;
  try {
    await serper.search('q', { ...O, key: 'k', fetch: fakeFetch(() => ({ status: 429, body: 'rate limited' })).fn });
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'rate');
});

// ═══════════════════════════════════════════════════════════════════════════
// duckduckgo: legs, parsing, serialization, failure
// ═══════════════════════════════════════════════════════════════════════════

await test('ddg leg1: vqd → d.js JSON maps (dedupe, noise row, tag/entity strip)', async () => {
  const { fn, log } = fakeFetch(DDG_ROUTE());
  const { sources } = await duckduckgo.search('q', { ...O, fetch: fn });
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], { url: 'https://a.example.com/x', title: 'Title & more', snippet: 'Body text' });
  assert.deepEqual(sources[1], { url: 'https://b.example.com/y', title: 'B', snippet: 'B body' });
  assert.ok(log.some((l) => l.url.includes('links.duckduckgo.com/d.js')));
  assert.ok(log.some((l) => l.url.includes('vqd=4-1234567890')));
});

await test('ddg leg1 fails (no vqd) → leg2 lite HTML (uddg resolve, entities)', async () => {
  const { fn } = fakeFetch((url) => {
    if (url.includes('lite.duckduckgo.com')) return { status: 200, body: LITE_OK };
    if (url.includes('duckduckgo.com/?q=')) return { status: 200, body: '<html>no vqd here</html>' };
    if (url.includes('api.duckduckgo.com')) return { status: 404, body: '' };
    return { status: 404, body: '' };
  });
  const { sources } = await duckduckgo.search('q', { ...O, fetch: fn });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].url, 'https://lite.example.com/page1');
  assert.equal(sources[0].title, 'Lite Title One');
  assert.equal(sources[0].snippet, 'Lite snippet & entities one');
  assert.equal(sources[1].url, 'https://direct.example.com/page2');
});

await test('ddg leg2 challenge page (no result rows) → leg3 instant API', async () => {
  const { fn, log } = fakeFetch(DDG_ROUTE());
  // force leg1 empty: d.js returns no results
  const route = (url) => {
    if (url.includes('links.duckduckgo.com/d.js')) return { status: 200, body: JSON.stringify({ results: [] }) };
    if (url.includes('lite.duckduckgo.com')) return { status: 202, body: LITE_CHALLENGE };
    if (url.includes('api.duckduckgo.com')) return INSTANT_OK;
    return { status: 200, body: VQD_PAGE };
  };
  const f2 = fakeFetch(route, log);
  const { sources } = await duckduckgo.search('q', { ...O, fetch: f2.fn });
  assert.ok(log.some((l) => l.url.includes('api.duckduckgo.com')));
  assert.equal(sources[0].url, 'https://en.wikipedia.org/wiki/DuckDuckGo');
  assert.equal(sources[0].title, 'DuckDuckGo');
  assert.equal(sources[0].snippet, 'DDG is a privacy search engine.');
  assert.equal(sources[1].url, 'https://duckduckgo.com/privacy');
  assert.equal(sources[1].title, 'DuckDuckGo privacy features');
  assert.equal(sources[2].url, 'https://topic.example.com/2');
});

await test('ddg: all legs fail → ProviderError "network" with leg details', async () => {
  let err;
  try {
    await duckduckgo.search('q', {
      ...O,
      fetch: fakeFetch(() => {
        throw new TypeError('fetch failed');
      }).fn,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ProviderError);
  assert.equal(err.code, 'network');
  assert.match(err.message, /duckduckgo: no DuckDuckGo leg returned results/);
  assert.match(err.message, /fetch failed/);
});

await test('ddg: concurrent searches serialize (leg politeness)', async () => {
  const events = []; // the query of every fetch, in order
  const { fn } = fakeFetch((url) =>
    new Promise((resolve) => {
      setTimeout(() => {
        events.push(new URL(url).searchParams.get('q') ?? '?');
        resolve(url.includes('api.duckduckgo.com') ? INSTANT_OK : { status: 404, body: '' });
      }, 10);
    }),
  );
  const [r1, r2] = await Promise.all([
    duckduckgo.search('one', { ...O, fetch: fn }),
    duckduckgo.search('two', { ...O, fetch: fn }),
  ]);
  assert.ok(r1.sources.length && r2.sources.length);
  // Each search makes 3 fetches (home 404 → lite 404 → instant).
  // Serialization boundary: ALL of search "one"'s fetches precede ALL of
  // search "two"'s fetches.
  assert.deepEqual(events, ['one', 'one', 'one', 'two', 'two', 'two']);
});

await test('ddg: caller abort mid-chain stops the walk', async () => {
  const ctrl = new AbortController();
  let secondCallSeen = false;
  const { fn } = fakeFetch((url, opts) => {
    if (url.includes('duckduckgo.com/?q=')) {
      ctrl.abort(); // user cancels while leg1 is in flight
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (opts.signal?.aborted) return abort(); // already aborted: reject now
        opts.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    secondCallSeen = true;
    return { status: 404, body: '' };
  });
  let err;
  try {
    await duckduckgo.search('q', { ...O, signal: ctrl.signal, fetch: fn });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, 'aborted');
  assert.equal(secondCallSeen, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// the fallback chain
// ═══════════════════════════════════════════════════════════════════════════

await test('chain: no keys → [duckduckgo]; on-fallback provenance "no API keys"', async () => {
  const chain = chainWith({ env: ENV_EMPTY, fetch: fakeFetch((url) => (url.includes('api.duckduckgo.com') ? INSTANT_OK : { status: 404, body: '' })).fn });
  assert.deepEqual((await chain.chainForCall()).map((e) => e.provider.id), [duckduckgo.id]);
  const r = await chain.search({ query: 'duck', maxResults: 5 }, undefined);
  assert.equal(r.truncated, false);
  assert.ok(r.sources.length >= 3);
  assert.equal(r.content, 'Served by DuckDuckGo (keyless fallback): no API keys configured.');
  assert.equal(chain.status().last.provider, 'duckduckgo');
});

await test('chain: keyed providers in priority order; first success wins, no note', async () => {
  const env = { ...ENV_KEYS };
  const { fn, log } = fakeFetch((url) => {
    if (url.includes('api.tavily.com')) return TAVILY_OK();
    if (url.includes('api.exa.ai')) return EXA_OK();
    if (url.includes('api.firecrawl.dev')) return FIRECRAWL_OK();
    if (url.includes('api.search.brave.com')) return BRAVE_OK();
    if (url.includes('google.serper.dev')) return SERPER_OK();
    return { status: 404, body: '' };
  });
  const chain = chainWith({ env, fetch: fn });
  const c = (await chain.chainForCall()).map((e) => e.provider.id);
  assert.deepEqual(c, ['tavily', 'exa', 'serper', 'duckduckgo']);
  const r = await chain.search({ query: 'q', maxResults: 3 }, undefined);
  assert.ok(r.sources[0].url.startsWith('https://tavily.example.com/'));
  assert.equal(r.content, undefined); // top provider served; on-fallback stays silent
  assert.equal(log.length, 1); // only tavily was called
  assert.equal(chain.status().last.provider, 'tavily');
  assert.equal(chain.status().last.sources, 3);
});

await test('chain: tavily 429 → exa serves; failure recorded', async () => {
  const env = { TAVILY_API_KEY: 'tv', EXA_API_KEY: 'ex' };
  const { fn, log } = fakeFetch((url) => {
    if (url.includes('api.tavily.com')) return { status: 429, body: 'too many requests' };
    if (url.includes('api.exa.ai')) return EXA_OK(1);
    return { status: 404, body: '' };
  });
  const chain = chainWith({ env, fetch: fn });
  const r = await chain.search({ query: 'q' }, undefined);
  assert.ok(r.sources[0].url.startsWith('https://exa.example.com/'));
  assert.equal(r.content, undefined);
  const f = chain.status().failures;
  assert.equal(f.length, 1);
  assert.equal(f[0].provider, 'tavily');
  assert.equal(f[0].code, 'rate');
  assert.ok(log.length === 2);
});

await test('chain: all keyed fail (auth + quota) → ddg serves with provenance', async () => {
  const env = { TAVILY_API_KEY: 'tv', SERPER_API_KEY: 'sp' };
  const { fn } = fakeFetch((url) => {
    if (url.includes('api.tavily.com')) return { status: 401, body: 'invalid key' };
    if (url.includes('google.serper.dev')) return { status: 403, body: 'quota exhausted' };
    if (url.includes('api.duckduckgo.com')) return INSTANT_OK;
    return { status: 404, body: '' };
  });
  const chain = chainWith({ env, fetch: fn });
  const r = await chain.search({ query: 'q' }, undefined);
  assert.ok(r.sources[0].url === 'https://en.wikipedia.org/wiki/DuckDuckGo');
  assert.equal(r.content, 'Served by DuckDuckGo (keyless fallback) after tavily (auth), serper (quota) failed.');
});

await test('chain: everything including ddg fails → one error listing all', async () => {
  const env = { TAVILY_API_KEY: 'tv' };
  const { fn } = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  const chain = chainWith({ env, fetch: fn });
  let err;
  try {
    await chain.search({ query: 'q' }, undefined);
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.match(err.message, /All web search providers failed/);
  assert.match(err.message, /tavily: network/);
  assert.match(err.message, /duckduckgo: network/);
});

await test('chain: provenance "always" notes every provider; "off" never does', async () => {
  const env = { TAVILY_API_KEY: 'tv' };
  const mk = (provenance) => chainWith({
    env,
    fetch: fakeFetch((url) => (url.includes('api.tavily.com') ? TAVILY_OK(1) : { status: 404, body: '' })).fn,
    config: normalizeConfig({ provenance }),
  });
  const always = await mk('always').search({ query: 'q' }, undefined);
  assert.equal(always.content, 'Served by Tavily.');
  const off = await mk('off').search({ query: 'q' }, undefined);
  assert.equal(off.content, undefined);
});

await test('chain: key added mid-process is picked up on the next call', async () => {
  const env = {};
  const { fn } = fakeFetch((url) => {
    if (url.includes('api.tavily.com')) return TAVILY_OK(1);
    if (url.includes('api.duckduckgo.com')) return INSTANT_OK;
    return { status: 404, body: '' };
  });
  const chain = chainWith({ env, fetch: fn });
  const r1 = await chain.search({ query: 'first' }, undefined);
  assert.equal(r1.content, 'Served by DuckDuckGo (keyless fallback): no API keys configured.');
  env.TAVILY_API_KEY = 'added-later'; // as if stored in the credentials seam
  const r2 = await chain.search({ query: 'second' }, undefined);
  assert.ok(r2.sources[0].url.startsWith('https://tavily.example.com/'));
  assert.equal(r2.content, undefined);
});

await test('chain: aborted before the first provider → no fetches at all', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const { fn, log } = fakeFetch(() => TAVILY_OK());
  const chain = chainWith({ env: { TAVILY_API_KEY: 'tv' }, fetch: fn });
  let err;
  try {
    await chain.search({ query: 'q' }, ctrl.signal);
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'aborted');
  assert.equal(log.length, 0);
});

await test('chain: abort mid-chain (tavily) → ddg not attempted', async () => {
  const ctrl = new AbortController();
  const { fn, log } = fakeFetch((url, opts) => {
    if (url.includes('api.tavily.com')) {
      ctrl.abort();
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        if (opts.signal?.aborted) return abort(); // already aborted: reject now
        opts.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return { status: 404, body: '' };
  });
  const chain = chainWith({ env: { TAVILY_API_KEY: 'tv' }, fetch: fn });
  let err;
  try {
    await chain.search({ query: 'q' }, ctrl.signal);
  } catch (e) {
    err = e;
  }
  assert.equal(err.code, 'aborted');
  assert.ok(!log.some((l) => l.url.includes('duckduckgo')));
});

await test('chain: maxResults clamped (undefined→10, 999→50, 0→1)', async () => {
  const seen = [];
  const { fn } = fakeFetch((url, opts) => {
    seen.push(JSON.parse(opts.body).max_results);
    return TAVILY_OK(99);
  });
  const chain = chainWith({ env: { TAVILY_API_KEY: 'tv' }, fetch: fn });
  await chain.search({ query: 'a' }, undefined);
  await chain.search({ query: 'b', maxResults: 999 }, undefined);
  await chain.search({ query: 'c', maxResults: 0 }, undefined);
  assert.deepEqual(seen, [10, 50, 1]);
});

await test('chain: empty/whitespace query rejected', async () => {
  const chain = chainWith({ env: ENV_EMPTY, fetch: fakeFetch(() => ({ status: 404, body: '' })).fn });
  await assert.rejects(() => chain.search({ query: '' }, undefined), /non-empty/);
  await assert.rejects(() => chain.search({ query: '   ' }, undefined), /non-empty/);
  await assert.rejects(() => chain.search({}, undefined), /non-empty/);
});

// ═══════════════════════════════════════════════════════════════════════════
// websearch_status tool
// ═══════════════════════════════════════════════════════════════════════════

function fakeToolsCtx() {
  const registered = [];
  const ctx = {
    get: (id) => (id === 'tools' ? { register: (t) => registered.push(t) } : id === 'credentials' ? undefined : undefined),
    tools: { register: (t) => registered.push(t) },
    registered,
  };
  return ctx;
}

await test('tools: registers websearch_status with the right name/shape', () => {
  if (!dshTools) {
    // bare checkout: defineTool is unavailable — the tolerant import degrades
    // registerTools to a no-op (no status tool) instead of failing the plugin.
    const ctx = fakeToolsCtx();
    registerTools(ctx, { config: normalizeConfig({}), chain: chainWith({}), env: ENV_EMPTY });
    assert.equal(ctx.registered.length, 0);
    return;
  }
  const ctx = fakeToolsCtx();
  registerTools(ctx, { config: normalizeConfig({}), chain: chainWith({}), env: ENV_EMPTY });
  assert.equal(ctx.registered.length, 1);
  const t = ctx.registered[0];
  assert.equal(t.name, 'websearch_status');
  assert.ok(t.description.includes('fallback chain'));
  assert.equal(t.timeoutMs, 10_000);
  assert.equal(t.isConcurrencySafe({}), true);
});

await test('tools: execute builds live status (keys, chain, last, failures)', async () => {
  if (!dshTools) return;
  const env = { TAVILY_API_KEY: 'tv' };
  const chain = chainWith({
    env,
    fetch: fakeFetch((url) => (url.includes('api.tavily.com') ? TAVILY_OK(2) : { status: 404, body: '' })).fn,
  });
  await chain.search({ query: 'live test', maxResults: 2 }, undefined);
  const ctx = fakeToolsCtx();
  registerTools(ctx, { config: normalizeConfig({}), chain, env });
  const v = await ctx.registered[0].execute({}, {});
  assert.deepEqual(v.chain, ['tavily', 'duckduckgo']);
  assert.equal(v.providers.length, 6);
  const tavily = v.providers.find((p) => p.id === 'tavily');
  assert.equal(tavily.hasKey, true);
  assert.equal(tavily.envKey, 'TAVILY_API_KEY');
  const ddg = v.providers.find((p) => p.id === 'duckduckgo');
  assert.equal(ddg.envKey, '');
  assert.equal(v.last.provider, 'tavily');
  assert.equal(v.last.query, 'live test');
  assert.equal(v.last.sources, 2);
  assert.deepEqual(v.failures, []);
});

await test('tools: render text lists chain state, last search, and failures', async () => {
  if (!dshTools) return;
  const env = { TAVILY_API_KEY: 'tv', SERPER_API_KEY: 'sp' };
  const chain = chainWith({
    env,
    fetch: fakeFetch((url) => {
      if (url.includes('api.tavily.com')) return { status: 401, body: 'bad' };
      if (url.includes('google.serper.dev')) return SERPER_OK(1);
      if (url.includes('api.duckduckgo.com')) return INSTANT_OK;
      return { status: 404, body: '' };
    }).fn,
  });
  await chain.search({ query: 'q' }, undefined);
  const ctx = fakeToolsCtx();
  registerTools(ctx, { config: normalizeConfig({}), chain, env });
  const out = ctx.registered[0].output.render({}, await ctx.registered[0].execute({}, {}));
  const text = out[0].text;
  assert.match(text, /tavily \(Tavily\) — in chain \[TAVILY_API_KEY\]/);
  assert.match(text, /exa \(Exa\) — skipped \(no key\)/);
  assert.match(text, /duckduckgo \(DuckDuckGo\) — in chain \[keyless, always available\]/);
  assert.match(text, /served by serper/);
  assert.match(text, /tavily: auth — .*HTTP 401/);
});

// ═══════════════════════════════════════════════════════════════════════════
// index.js: apply() wiring
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A lenient fake cordis context (plain object: every service also reads
 * as a property). The REAL ctx is a strict proxy — a direct property
 * read throws for any service outside the plugin's inject list; see
 * strictProxyCtx() below for a faithful stand-in. `web` is always
 * present (the plugin injects it); the rest are optional.
 */
function fakeApplyCtx({ withOptional = true, settingsService } = {}) {
  const registered = { searchProviders: [], commands: [], contexts: [] };
  const web = {
    registerSearchProvider: (p) => {
      registered.searchProviders.push(p);
      return () => {};
    },
  };
  const services = { web };
  if (withOptional) {
    services.tools = { register: () => {} };
    services.commands = { register: (c) => registered.commands.push(c) };
    services.systemPrompt = { context: (s) => registered.contexts.push(s) };
  }
  if (settingsService) services.settings = settingsService;
  const get = (id) => (id === 'web' ? web : services[id] ?? undefined);
  return { get, ...services, on: () => {}, registered };
}

await test('apply: registers the composite provider on ctx.web with the seam id', () => {
  assert.equal(pluginName, 'websearch-dsh');
  const ctx = fakeApplyCtx();
  apply(ctx, {});
  assert.equal(ctx.registered.searchProviders.length, 1);
  const p = ctx.registered.searchProviders[0];
  assert.equal(p.id, PROVIDER_ID);
  assert.equal(p.available(), true);
});

// The one live-network test in the suite: exercises the real DDG leg through
// the full apply() → ctx.web provider path. Skips (not fails) when offline.
await testSkippable('apply: end-to-end search through the registered provider (no keys → ddg, live)', async () => {
  const ctx = fakeApplyCtx();
  apply(ctx, {});
  const p = ctx.registered.searchProviders[0];
  const r = await p.search({ query: 'deepseek harness', maxResults: 4 }, undefined);
  assert.ok(Array.isArray(r.sources));
  assert.equal(r.truncated, false);
  if (r.sources.length) {
    assert.ok(r.sources.every((s) => typeof s.url === 'string' && s.url.length > 0));
    assert.match(r.content ?? '', /DuckDuckGo/);
  }
});

await test('apply: works without tools/commands/systemPrompt services', () => {
  const ctx = fakeApplyCtx({ withOptional: false });
  apply(ctx, {}); // must not throw — only `web` is a hard dependency
  assert.equal(ctx.registered.searchProviders.length, 1);
});

// The real cordis ctx is a strict proxy: a direct property read throws
// `cannot get property "X" without inject` for any service outside the
// plugin's inject list — even when the service exists and ctx.get()
// resolves it. This fake reproduces that exactly; the lenient
// fakeApplyCtx() above masks it because a plain object serves every
// property. (Regression: registerTools used to read ctx.tools directly
// and took `dsh web` down at startup.)
function strictProxyCtx({ withOptional = true } = {}) {
  const registered = { searchProviders: [], tools: [], commands: [], contexts: [] };
  const web = {
    registerSearchProvider: (p) => {
      registered.searchProviders.push(p);
      return () => {};
    },
  };
  const services = { web };
  if (withOptional) {
    services.tools = { register: (t) => registered.tools.push(t) };
    services.commands = { register: (c) => registered.commands.push(c) };
    services.systemPrompt = { context: (s) => registered.contexts.push(s) };
  }
  const target = {
    get: (id) => (id === 'web' ? web : services[id] ?? undefined),
    on: () => {},
    registered,
  };
  return new Proxy(target, {
    get: (t, prop, receiver) => {
      // special properties (symbols, then, prototype, …) and own
      // properties pass through, exactly like the runtime's proxy
      if (typeof prop !== 'string' || prop === 'then' || prop === 'prototype' || prop in t) {
        return Reflect.get(t, prop, receiver);
      }
      if (prop === 'web') return web; // the plugin's only injected service
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  });
}

await test('apply: strict ctx proxy — optional services via get() only, direct reads throw', () => {
  const ctx = strictProxyCtx();
  assert.throws(() => ctx.tools, /cannot get property "tools" without inject/);
  apply(ctx, {}); // must not throw
  assert.equal(ctx.registered.searchProviders.length, 1);
  // the status tool needs the dsh-tools package; a bare checkout degrades to none
  assert.equal(ctx.registered.tools.length, dshTools ? 1 : 0);
  assert.equal(ctx.registered.commands.length, 1);
  assert.equal(ctx.registered.contexts.length, 1);
});

await test('apply: context section registered with owner name + order', async () => {
  const ctx = fakeApplyCtx();
  apply(ctx, {});
  assert.equal(ctx.registered.contexts.length, 1);
  const c = ctx.registered.contexts[0];
  assert.equal(c.name, `${OWNER}:status`);
  assert.equal(c.order, 118);
  await new Promise((r) => setTimeout(r, 200)); // let the key snapshot settle
  const text = c.text();
  assert.ok(text.length > 0);
  assert.match(text, /DuckDuckGo/);
});

await test('command: /websearch status renders; unknown sub errors', async () => {
  const ctx = fakeApplyCtx();
  apply(ctx, {});
  assert.equal(ctx.registered.commands.length, 1);
  const cmd = ctx.registered.commands[0];
  assert.equal(cmd.name, 'websearch');
  const ok = await cmd.handler({ rawInput: 'status' });
  assert.equal(ok.kind, 'success');
  assert.match(ok.text, /fallback order/);
  assert.match(ok.text, /duckduckgo/);
  const bad = await cmd.handler({ rawInput: 'reboot' });
  assert.equal(bad.kind, 'error');
});

// ═══════════════════════════════════════════════════════════════════════════
// bundle patch layer
// ═══════════════════════════════════════════════════════════════════════════

await test('cordis.patch.yml: parses; insert row + web override are well-formed', async () => {
  if (!jsYaml) return; // bare checkout without js-yaml
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const raw = readFileSync(fileURLToPath(new URL('./cordis.patch.yml', import.meta.url)), 'utf8');
  const doc = jsYaml.load(raw, { schema: jsYaml.JSON_SCHEMA });
  assert.equal(doc.length, 2);
  const insert = doc[0].insert;
  assert.equal(insert.length, 1);
  assert.equal(insert[0].id, 'search-multi');
  assert.equal(insert[0].name, 'websearch-dsh');
  assert.equal(insert[0].config.providerTimeoutMs, 10000);
  assert.equal(insert[0].config.provenance, 'on-fallback');
  assert.equal(insert[0].config.context.order, 118);
  assert.ok(!('envKeys' in insert[0].config), 'bundle layer must not restate envKeys (code defaults are the source of truth)');
  assert.ok(!('priority' in insert[0].config), 'bundle layer must not restate priority');
  assert.equal(doc[1].id, 'web');
  assert.equal(doc[1].name, '@deepseek-ai/dsh-web');
  assert.deepEqual(doc[1].config, { searchProvider: 'websearch-dsh' });
});

// ═══════════════════════════════════════════════════════════════════════════
// user toggle (settings document) + client card
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A fake of the dsh `settings` service surface the plugin uses:
 * register(ns, schema, {base}) → {get, watch, update}. `update` stands in
 * for a write landing from anywhere (the GUI, the file watcher) and
 * re-resolves base + user, notifying watchers with (next, prev) — the
 * real service's contract.
 */
function fakeSettingsService(doc = {}) {
  const registrations = new Map();
  return {
    registrations,
    register(ns, _schema, opts = {}) {
      const reg = {
        ns,
        base: opts.base,
        section: { ...(doc[ns] ?? {}) },
        watchers: new Set(),
        resolved: { ...(opts.base ?? {}), ...doc[ns] },
      };
      const handle = {
        get: () => reg.resolved,
        watch(cb) {
          reg.watchers.add(cb);
          return () => reg.watchers.delete(cb);
        },
        update(patch) {
          reg.section = { ...reg.section, ...patch };
          const prev = reg.resolved;
          reg.resolved = { ...(opts.base ?? {}), ...reg.section };
          for (const w of [...reg.watchers]) w(reg.resolved, prev);
        },
      };
      registrations.set(ns, { reg, handle });
      return handle;
    },
  };
}

await test('settings: registers the namespace (base enabled:true) and tracks live updates', () => {
  const service = fakeSettingsService();
  const ctx = { get: (id) => (id === 'settings' ? service : undefined) };
  const handle = registerWebSearchSettings(ctx);
  if (!handle) {
    // bare checkout without the dsh farm: no schemastery → no toggle.
    console.log('        (schemastery unavailable here — no-op registration, search stays enabled)');
    return;
  }
  assert.equal(handle.enabled(), true);
  const entry = service.registrations.get(SETTINGS_NAMESPACE);
  assert.ok(entry, `namespace ${SETTINGS_NAMESPACE} registered`);
  assert.deepEqual(entry.reg.base, { enabled: true });
  entry.handle.update({ enabled: false });
  assert.equal(handle.enabled(), false);
  entry.handle.update({ enabled: true });
  assert.equal(handle.enabled(), true);
  handle.dispose();
});

await test('settings: absent settings service → null (search stays enabled)', () => {
  const ctx = { get: () => undefined };
  assert.equal(registerWebSearchSettings(ctx), null);
});

await test('settings: user-layer enabled:false in the document wins over base', () => {
  const service = fakeSettingsService({ [SETTINGS_NAMESPACE]: { enabled: false } });
  const handle = registerWebSearchSettings({ get: (id) => (id === 'settings' ? service : undefined) });
  if (!handle) return;
  assert.equal(handle.enabled(), false);
  handle.dispose();
});

await test('chain: toggle off → search declines before touching any provider', async () => {
  const fetch = fakeFetch(() => ({ status: 200, body: '{}' })).fn;
  const log = [];
  const chain = createSearchChain({
    config: normalizeConfig({}),
    ctx: undefined,
    env: { TAVILY_API_KEY: 'tv' },
    fetch: ((url, opts) => {
      log.push(url);
      return fetch(url, opts);
    }),
    settings: { enabled: () => false },
  });
  await assert.rejects(() => chain.search({ query: 'x' }, undefined), /disabled/i);
  assert.deepEqual(log, [], 'no provider fetch may happen while disabled');
  assert.equal(chain.status().enabled, false);
});

await test('chain: live toggle — off then on mid-process, no restart', async () => {
  const enabled = { value: true };
  const chain = createSearchChain({
    config: normalizeConfig({}),
    ctx: undefined,
    env: { TAVILY_API_KEY: 'tv' },
    fetch: fakeFetch((url) => (url.includes('api.tavily.com') ? TAVILY_OK(2) : { status: 404, body: '' })).fn,
    settings: { enabled: () => enabled.value },
  });
  const ok = await chain.search({ query: 'one', maxResults: 2 }, undefined);
  assert.equal(ok.sources.length, 2);
  assert.equal(chain.status().enabled, true);
  enabled.value = false;
  await assert.rejects(() => chain.search({ query: 'two' }, undefined), /disabled/i);
  assert.equal(chain.status().enabled, false);
  enabled.value = true;
  const ok2 = await chain.search({ query: 'three', maxResults: 2 }, undefined);
  assert.equal(ok2.sources.length, 2);
  assert.equal(chain.status().enabled, true);
});

await test('tools: status carries enabled; render flags DISABLED with the how-to', async () => {
  if (!dshTools) return;
  const chain = createSearchChain({
    config: normalizeConfig({}),
    ctx: undefined,
    env: ENV_EMPTY,
    fetch: fakeFetch(() => ({ status: 404, body: '' })).fn,
    settings: { enabled: () => false },
  });
  const ctx = fakeToolsCtx();
  registerTools(ctx, { config: normalizeConfig({}), chain, env: ENV_EMPTY });
  const v = await ctx.registered[0].execute({}, {});
  assert.equal(v.enabled, false);
  const text = ctx.registered[0].output.render({}, v)[0].text;
  assert.match(text, /DISABLED/);
  assert.match(text, /settings\.yaml/);
});

await test('apply: settings service present → namespace registered; seam search honors the toggle', async () => {
  const service = fakeSettingsService();
  const ctx = fakeApplyCtx({ settingsService: service });
  apply(ctx, {});
  if (!service.registrations.has(SETTINGS_NAMESPACE)) {
    console.log('        (schemastery unavailable here — no-op registration, nothing to check)');
    return;
  }
  const p = ctx.registered.searchProviders[0];
  const r = await p.search({ query: 'live', maxResults: 2 }, undefined).catch((e) => ({ err: e }));
  if (r.err) {
    // no keys on this machine → DDG leg; offline → network error. Either
    // way the toggle was ON, so it must not be the disabled error.
    assert.doesNotMatch(String(r.err.message), /disabled by the user/);
    return;
  }
  assert.ok(r.sources.length > 0);
  service.registrations.get(SETTINGS_NAMESPACE).handle.update({ enabled: false });
  await assert.rejects(() => p.search({ query: 'x' }, undefined), /disabled by the user/);
});

await test('client: module registers the Web Search card; one-click toggle writes the field', async () => {
  const loaded = [];
  globalThis.window = { __ModuleLoader__: { load: (e) => loaded.push(e) } };
  try {
    await import(new URL('./client.js', import.meta.url));
  } finally {
    delete globalThis.window;
  }
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'websearch-dsh');
  const moduleExports = loaded[0].factory((spec) => {
    if (spec === 'react') return {};
    if (spec === 'react/jsx-runtime')
      return { jsx: (type, props) => ({ kind: 'jsx', type, props }), jsxs: (type, props) => ({ kind: 'jsxs', type, props }) };
    if (spec === '@deepseek-ai/dsh-client-runtime/client')
      return {
        createSnapshotStore: (initial) => {
          const store = {
            value: initial,
            listeners: new Set(),
            get: () => store.value,
            set(next) {
              store.value = next;
              for (const l of [...store.listeners]) l();
            },
            subscribe(cb) {
              store.listeners.add(cb);
              return () => store.listeners.delete(cb);
            },
          };
          return store;
        },
      };
    throw new Error(`client test: unexpected require "${spec}"`);
  });
  assert.equal(typeof moduleExports.apply, 'function');
  // The fiber's inject list must be semantic service names — the cordis
  // services apply() actually consumes (slots ← dsh-client-runtime,
  // settingsScope ← dsh-client-ui-settings). The browser composition
  // never provides services under package names: declaring the
  // first-party packages here used to leave the fiber pending forever
  // ("web boot: 1 entry did not activate"). The dsh.client.inject
  // package-name list in package.json is informational graph metadata
  // only and is deliberately not asserted here.
  assert.deepEqual(moduleExports.inject, ['slots', 'settingsScope']);
  for (const svc of moduleExports.inject)
    assert.ok(!svc.includes('/'), `fiber inject must stay a service name, not a package: ${svc}`);

  // fake client context: a bound scope with a live value + slots
  const written = [];
  const scope = {
    _value: { enabled: true },
    _listeners: new Set(),
    getSnapshot: () => ({
      status: 'ready',
      value: scope._value,
      base: { enabled: true },
      user: {},
      revision: 1,
      writable: true,
    }),
    set: async (field, value) => {
      written.push([field, value]);
      scope._value = { ...scope._value, [field]: value };
      for (const l of [...scope._listeners]) l();
    },
    unset: async () => {},
    subscribe: (cb) => {
      scope._listeners.add(cb);
      return () => scope._listeners.delete(cb);
    },
  };
  const registered = [];
  const ctx = {
    settingsScope: {
      bind: (spec) => {
        assert.equal(spec.namespace, 'websearch-dsh');
        return scope;
      },
    },
    slots: {
      inject: (name, cb) => {
        assert.equal(name, 'settings.plugin.item');
        cb();
      },
      register: (entry, comp) => {
        registered.push({ entry, comp });
        return () => {};
      },
    },
  };
  moduleExports.apply(ctx);
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].entry, { name: 'settings.plugin.item', key: 'websearch-dsh', inject: registered[0].entry.inject });
  assert.equal(registered[0].entry.key, 'websearch-dsh');

  const face = registered[0].entry.inject();
  assert.ok(face.hooks.webSearchCard, 'hooks entry becomes the useWebSearchCard prop source');
  const render = () =>
    registered[0].comp({
      useWebSearchCard: (sel) => sel(face.hooks.webSearchCard.get()),
      toggle: () => face.toggle(),
    });

  // The card renders <div>[h3, p, label[checkbox, span], …nulls]</div>;
  // locate the label, then the checkbox inside it.
  const findLabel = (el) => el.props.children.find((c) => c?.props?.children?.[0]?.props?.type === 'checkbox');
  const findCheckbox = (labelEl) => labelEl.props.children.find((c) => c.props.type === 'checkbox');

  const on = render();
  // element shape is {kind, type, props:{…}} — read the prop, not the element.
  assert.equal(findCheckbox(findLabel(on)).props.checked, true, 'renders checked when enabled');

  await face.toggle();
  assert.deepEqual(written, [['enabled', false]], 'one click → one revision-fenced field write');
  const off = render();
  assert.equal(findCheckbox(findLabel(off)).props.checked, false, 're-renders unchecked after the write lands');

  // unavailable namespace → the card renders nothing
  scope.getSnapshot = () => ({ status: 'unavailable', value: undefined, base: { enabled: true }, user: {}, revision: 0, writable: false });
  assert.equal(registered[0].comp({ useWebSearchCard: (s) => s, toggle: () => {} }), null);
});

// ═══════════════════════════════════════════════════════════════════════════

const failed = results.filter(([s]) => s === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error(`\nfailed: ${failed.map(([, n]) => n).join(', ')}`);
  process.exit(1);
}
