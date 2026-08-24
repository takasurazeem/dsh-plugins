// Brave Search — https://api.search.brave.com (GET /res/v1/web/search).
// Key: BRAVE_API_KEY (sent as the X-Subscription-Token header).

import { http, classifyHttpFailure, ProviderError, shortText } from '../http.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

function mapResults(json, maxResults) {
  const results = Array.isArray(json?.web?.results) ? json.web.results : [];
  const sources = [];
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    const source = { url: r.url };
    if (typeof r.title === 'string' && r.title.trim()) source.title = r.title;
    if (typeof r.description === 'string' && r.description.trim()) source.snippet = r.description;
    if (typeof r.page_age === 'string' && r.page_age.trim()) source.publishedAt = r.page_age;
    sources.push(source);
    if (sources.length >= maxResults) break;
  }
  return sources;
}

export const brave = {
  id: 'brave',
  label: 'Brave Search',
  envKey: 'BRAVE_API_KEY',
  async search(query, o) {
    if (!o.key) throw new ProviderError('auth', this.id, 'no key configured (BRAVE_API_KEY)');
    const params = new URLSearchParams({ q: query, count: String(o.maxResults) });
    const res = await http({
      url: `${ENDPOINT}?${params}`,
      headers: { 'x-subscription-token': o.key },
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
