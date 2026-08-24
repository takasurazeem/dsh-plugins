// Tavily — https://docs.tavily.com (POST /search).
// Default provider of the fallback chain. Key: TAVILY_API_KEY.

import { http, classifyHttpFailure, ProviderError, shortText } from '../http.js';

const ENDPOINT = 'https://api.tavily.com/search';

function mapResults(json, maxResults) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const sources = [];
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || !r.url) continue;
    const source = { url: r.url };
    if (typeof r.title === 'string' && r.title.trim()) source.title = r.title;
    if (typeof r.content === 'string' && r.content.trim()) source.snippet = r.content;
    if (typeof r.published_date === 'string' && r.published_date.trim()) source.publishedAt = r.published_date;
    sources.push(source);
    if (sources.length >= maxResults) break;
  }
  return sources;
}

export const tavily = {
  id: 'tavily',
  label: 'Tavily',
  envKey: 'TAVILY_API_KEY',
  async search(query, o) {
    if (!o.key) throw new ProviderError('auth', this.id, 'no key configured (TAVILY_API_KEY)');
    const res = await http({
      url: ENDPOINT,
      method: 'POST',
      // Newer API versions prefer the Authorization header; the api_key
      // body field is kept for older deployments.
      headers: { authorization: `Bearer ${o.key}` },
      body: {
        query,
        max_results: o.maxResults,
        search_depth: 'basic',
        include_answer: false,
        api_key: o.key,
      },
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
