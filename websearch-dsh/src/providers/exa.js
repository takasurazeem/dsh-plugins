// Exa.ai — https://docs.exa.ai (POST /search).
// Key: EXA_API_KEY.

import { http, classifyHttpFailure, ProviderError, shortText } from '../http.js';

const ENDPOINT = 'https://api.exa.ai/search';

function mapResults(json, maxResults) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const sources = [];
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    const source = { url: r.url };
    if (typeof r.title === 'string' && r.title.trim()) source.title = r.title;
    if (typeof r.text === 'string' && r.text.trim()) source.snippet = r.text;
    if (typeof r.publishedDate === 'string' && r.publishedDate.trim()) source.publishedAt = r.publishedDate;
    sources.push(source);
    if (sources.length >= maxResults) break;
  }
  return sources;
}

export const exa = {
  id: 'exa',
  label: 'Exa',
  envKey: 'EXA_API_KEY',
  async search(query, o) {
    if (!o.key) throw new ProviderError('auth', this.id, 'no key configured (EXA_API_KEY)');
    const res = await http({
      url: ENDPOINT,
      method: 'POST',
      headers: { 'x-api-key': o.key },
      body: { query, numResults: o.maxResults, type: 'auto' },
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
