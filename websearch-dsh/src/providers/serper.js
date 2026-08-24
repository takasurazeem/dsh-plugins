// Serper.dev — https://serper.dev (POST /search, Google SERP).
// Key: SERPER_API_KEY (sent as the X-API-KEY header).

import { http, classifyHttpFailure, ProviderError, shortText } from '../http.js';

const ENDPOINT = 'https://google.serper.dev/search';

function mapResults(json, maxResults) {
  const results = Array.isArray(json?.organic) ? json.organic : [];
  const sources = [];
  for (const r of results) {
    if (!r || typeof r.link !== 'string' || !r.link) continue;
    const source = { url: r.link };
    if (typeof r.title === 'string' && r.title.trim()) source.title = r.title;
    if (typeof r.snippet === 'string' && r.snippet.trim()) source.snippet = r.snippet;
    if (typeof r.date === 'string' && r.date.trim()) source.publishedAt = r.date;
    sources.push(source);
    if (sources.length >= maxResults) break;
  }
  return sources;
}

export const serper = {
  id: 'serper',
  label: 'Serper',
  envKey: 'SERPER_API_KEY',
  async search(query, o) {
    if (!o.key) throw new ProviderError('auth', this.id, 'no key configured (SERPER_API_KEY)');
    const res = await http({
      url: ENDPOINT,
      method: 'POST',
      headers: { 'x-api-key': o.key },
      body: { q: query, num: o.maxResults, gl: 'us' },
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      fetch: o.fetch,
    });
    if (!res.ok) {
      throw new ProviderError(classifyHttpFailure(res.status, res.text), this.id, `HTTP ${res.status} ${shortText(res.text)}`);
    }
    if (!res.json) throw new ProviderError('parse', this.id, 'non-JSON response');
    return { sources: mapResults(res.json, o.maxResults) };
  },
};
