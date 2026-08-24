// DuckDuckGo — the keyless last-resort leg. No API key, ever.
//
// Three legs are tried in order; the first one that returns results wins:
//
//   1. `djs`     — the protocol of the npm package `duckduckgo-search`
//                  (vqd token from duckduckgo.com → links.duckduckgo.com/d.js
//                  JSON). That package (v1.0.7, 2023) is broken on modern
//                  Node (it calls `console.warning`, which does not exist)
//                  and its endpoints churn, so the protocol is vendored
//                  here with a working error path.
//   2. `lite`    — the plain-HTML lite.duckduckgo.com endpoint (result-link /
//                  result-snippet rows), which DDG serves to simple clients.
//   3. `instant` — the official keyless instant-answer API
//                  (api.duckduckgo.com): an abstract plus related topics.
//                  Weaker than ranked web results, but the official
//                  endpoint is the most stable of the three.
//
// Politeness: DDG is the fallback leg, so the plugin never hammers it —
// all searches are serialized through one queue (the harness tool may
// issue up to 4 concurrent queries per call, and the vqd token dance does
// not like to be raced).

import { http, ProviderError, shortText } from '../http.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ── politeness queue ──────────────────────────────────────────────────────

let queue = Promise.resolve();
function runSerialized(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── small HTML helpers (no DOM dependency; the pages are simple) ─────────

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>', '&#x2F;': '/' };

function decodeEntities(s) {
  return String(s ?? '').replace(/&(?:amp|quot|#x27|#39|lt|gt|#x2F);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// lite.duckduckgo.com hrefs are DDG redirect links: /l/?uddg=<target>&…
function resolveLiteUrl(href) {
  const h = decodeEntities(href);
  try {
    const u = new URL(h, 'https://lite.duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname === '/l/' && u.searchParams.has('uddg')) {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
    return u.toString();
  } catch {
    return h;
  }
}

// ── leg 1: vqd → links.duckduckgo.com/d.js ───────────────────────────────

function extractVqd(html) {
  for (const [a, b] of [
    ['vqd="', '"'],
    ["vqd='", "'"],
    ['vqd=', '&'],
  ]) {
    const i = html.indexOf(a);
    if (i < 0) continue;
    const start = i + a.length;
    const end = html.indexOf(b, start);
    if (end > start) {
      const v = html.slice(start, end).trim();
      if (v.length >= 8) return v;
    }
  }
  return '';
}

async function legDjs(query, o) {
  const home = await http({
    url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    headers: { 'user-agent': UA },
    timeoutMs: o.legTimeoutMs,
    signal: o.signal,
    fetch: o.fetch,
    accept: 'text/html',
  });
  if (!home.ok || !home.text) return null;
  const vqd = extractVqd(home.text);
  if (!vqd) return null;
  const params = new URLSearchParams({
    q: query,
    kl: 'wt-wt',
    l: 'wt-wt',
    s: '0',
    o: 'json',
    sp: '0',
    ex: '-1',
    vqd,
  });
  const res = await http({
    url: `https://links.duckduckgo.com/d.js?${params}`,
    headers: { 'user-agent': UA, referer: 'https://duckduckgo.com/' },
    timeoutMs: o.legTimeoutMs,
    signal: o.signal,
    fetch: o.fetch,
  });
  if (!res.ok || !res.json) return null;
  const rows = Array.isArray(res.json.results) ? res.json.results : [];
  const sources = [];
  const seen = new Set();
  for (const row of rows) {
    const url = row?.u;
    if (typeof url !== 'string' || !url || seen.has(url)) continue;
    if (url.includes('google.com/search')) continue; // DDG's own noise row
    seen.add(url);
    sources.push({
      url,
      ...(row.t ? { title: stripTags(row.t) } : {}),
      ...(row.a ? { snippet: stripTags(row.a) } : {}),
    });
    if (sources.length >= o.maxResults) break;
  }
  return sources.length ? sources : null;
}

// ── leg 2: lite.duckduckgo.com/lite/ HTML ─────────────────────────────────

function parseLiteHtml(html, maxResults) {
  const sources = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const tag = m[0];
    if (!/class="result-link"/.test(tag)) continue;
    const hrefM = /href="([^"]*)"/.exec(tag);
    if (!hrefM) continue;
    const end = html.indexOf('</a>', m.index);
    const title = end > m.index ? stripTags(html.slice(m.index + tag.length, end)) : '';
    const after = html.slice(end, end + 6000);
    const snipM = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/.exec(after);
    const url = resolveLiteUrl(hrefM[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      ...(title ? { title } : {}),
      ...(snipM ? { snippet: stripTags(snipM[1]) } : {}),
    });
    if (sources.length >= maxResults) break;
  }
  return sources;
}

async function legLite(query, o) {
  const res = await http({
    url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    headers: { 'user-agent': UA },
    timeoutMs: o.legTimeoutMs,
    signal: o.signal,
    fetch: o.fetch,
    accept: 'text/html',
  });
  if (!res.ok || !res.text) return null;
  // A 202 challenge page (or a layout change) carries no result rows.
  if (!res.text.includes('result-link')) return null;
  const sources = parseLiteHtml(res.text, o.maxResults);
  return sources.length ? sources : null;
}

// ── leg 3: official instant-answer API ───────────────────────────────────

async function legInstant(query, o) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    no_redirect: '1',
    skip_disambig: '1',
  });
  const res = await http({
    url: `https://api.duckduckgo.com/?${params}`,
    timeoutMs: o.legTimeoutMs,
    signal: o.signal,
    fetch: o.fetch,
  });
  if (!res.ok || !res.json) return null;
  const j = res.json;
  const sources = [];
  if (typeof j.AbstractURL === 'string' && j.AbstractURL) {
    sources.push({
      url: j.AbstractURL,
      ...(j.Heading ? { title: j.Heading } : {}),
      ...(j.Abstract ? { snippet: j.Abstract } : {}),
    });
  }
  for (const t of Array.isArray(j.RelatedTopics) ? j.RelatedTopics : []) {
    if (sources.length >= o.maxResults) break;
    if (!t || typeof t.FirstURL !== 'string' || !t.FirstURL) continue;
    const text = typeof t.Text === 'string' && t.Text ? t.Text : '';
    const title = text || (typeof t.Name === 'string' ? t.Name : '');
    sources.push({
      url: t.FirstURL,
      ...(title ? { title } : {}),
      ...(text ? { snippet: text } : {}),
    });
  }
  return sources.length ? sources : null;
}

// ── the provider ─────────────────────────────────────────────────────────

const LEGS = [legDjs, legLite, legInstant];

export const duckduckgo = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  envKey: null, // keyless by design

  /**
   * @param {string} query
   * @param {object} o {maxResults, timeoutMs, legTimeoutMs, signal, fetch, key (ignored)}
   * @returns {Promise<{sources: Array}>}
   */
  async search(query, o) {
    return runSerialized(async () => {
      const legErrors = [];
      for (const leg of LEGS) {
        if (o.signal?.aborted) {
          const err = new Error('search aborted');
          err.code = 'aborted';
          throw err;
        }
        try {
          const sources = await leg(query, o);
          if (sources) return { sources };
        } catch (err) {
          if (err?.code === 'aborted' || o.signal?.aborted) throw err;
          legErrors.push(`${shortText(err?.message ?? err, 120)}`);
        }
      }
      throw new ProviderError(
        'network',
        this.id,
        `no DuckDuckGo leg returned results (${legErrors.join('; ') || 'all legs empty'})`,
      );
    });
  },
};
