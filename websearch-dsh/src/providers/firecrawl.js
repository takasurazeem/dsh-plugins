// Firecrawl — https://docs.firecrawl.dev (POST /v1/search).
// Key: FIRECRAWL_API_KEY.

import { http, classifyHttpFailure, classifyInBandFailure, ProviderError, shortText } from '../http.js';

const ENDPOINT = 'https://api.firecrawl.dev/v1/search';

function mapResults(json, maxResults) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const sources = [];
  for (const r of data) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    const source = { url: r.url };
    if (typeof r.title === 'string' && r.title.trim()) source.title = r.title;
    if (typeof r.description === 'string' && r.description.trim()) source.snippet = r.description;
    if (typeof r.publishedDate === 'string' && r.publishedDate.trim()) source.publishedAt = r.publishedDate;
    sources.push(source);
    if (sources.length >= maxResults) break;
  }
  return sources;
}

export const firecrawl = {
  id: 'firecrawl',
  label: 'Firecrawl',
  envKey: 'FIRECRAWL_API_KEY',
  async search(query, o) {
    if (!o.key) throw new ProviderError('auth', this.id, 'no key configured (FIRECRAWL_API_KEY)');
    const res = await http({
      url: ENDPOINT,
      method: 'POST',
      headers: { authorization: `Bearer ${o.key}` },
      body: { query, limit: o.maxResults, sources: ['web'] },
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      fetch: o.fetch,
    });
    if (!res.ok) {
      throw new ProviderError(classifyHttpFailure(res.status, res.text), this.id, `HTTP ${res.status} ${shortText(res.text)}`);
    }
    if (!res.json) throw new ProviderError('parse', this.id, 'non-JSON response');
    // Firecrawl also signals in-band failures: 200 with {success:false}.
    if (res.json.success === false) {
      const detail = typeof res.json.error === 'string' ? res.json.error : '';
      throw new ProviderError(classifyInBandFailure(detail), this.id, detail || 'in-band failure');
    }
    return { sources: mapResults(res.json, o.maxResults) };
  },
};
