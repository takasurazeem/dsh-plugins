// The fallback chain — the heart of the plugin.
//
//   keyed providers in the configured priority order (Tavily → Exa →
//   Firecrawl → Brave → Serper, whatever has a key) → keyless DuckDuckGo.
//
// Per search call: keys are re-resolved (so a key added mid-process is
// picked up on the next search), the chain is walked in order, and the
// first success wins. A provider failure — missing key, auth, quota,
// rate-limit, server error, timeout, network, or unparseable response —
// is recorded per provider and the chain continues, so search never fails
// hard because one vendor is down. Only an explicit caller abort (the
// harness tool timeout or the user cancelling) stops the walk early.
//
// Result provenance: per the `provenance` config, the returned
// WebSearchResult may carry a short `content` note when keyless
// DuckDuckGo served the search — the visible marker that the fallback
// fired.

import { resolveApiKey } from './keys.js';
import { shortText } from './http.js';
import { API_PROVIDERS, DUCKDUCKGO, PROVIDERS_BY_ID } from './providers/index.js';

const CLAMP = (n) => (Number.isFinite(n) ? Math.max(1, Math.min(50, Math.trunc(n))) : 10);

export function createSearchChain({ config, ctx, env = process.env, fetch, settings }) {
  const state = {
    last: null, // {provider, query, at, sources}
    failures: new Map(), // id → {code, at, message}
  };

  /**
   * The chain for one search call: keyed providers (in priority order)
   * plus the keyless DuckDuckGo leg. Keys are resolved per call.
   */
  async function chainForCall() {
    const list = [];
    for (const id of config.priority) {
      const provider = PROVIDERS_BY_ID.get(id);
      if (!provider) continue;
      const key = await resolveApiKey(ctx, config.envKeys[id] ?? provider.envKey, env);
      if (key) list.push({ provider, key });
    }
    list.push({ provider: DUCKDUCKGO, key: '' });
    return list;
  }

  function recordFailure(id, err) {
    const code = typeof err?.code === 'string' && err.code ? err.code : 'error';
    state.failures.set(id, {
      code,
      at: new Date().toISOString(),
      message: shortText(err?.message ?? err, 300),
    });
  }

  function isAborted(err) {
    return err?.code === 'aborted' || err?.name === 'AbortError';
  }

  /**
   * @param {{query: string, maxResults?: number}} request the seam's request
   * @param {AbortSignal} [signal]
   * @returns {Promise<{sources: Array, truncated: boolean, content?: string}>}
   */
  async function search(request, signal) {
    if (settings && !settings.enabled()) {
      throw new Error(
        'Web search is disabled by the user (dsh web client: Settings → Plugins → Web Search; ' +
          'or websearch-dsh.enabled: false in ~/.dsh/settings.yaml). Do not call web_search until it is re-enabled.',
      );
    }
    const query = String(request?.query ?? '').trim();
    if (!query) throw new Error('web search query must be non-empty');
    const maxResults = CLAMP(request?.maxResults);

    const chain = await chainForCall();
    const attempted = []; // ids of keyed providers that were tried and failed this call

    for (const { provider, key } of chain) {
      if (signal?.aborted) throw abortError();
      try {
        const { sources } = await provider.search(query, {
          key,
          maxResults,
          timeoutMs: config.providerTimeoutMs,
          legTimeoutMs: Math.min(config.providerTimeoutMs, 8000),
          signal,
          fetch,
        });
        state.last = {
          provider: provider.id,
          query,
          at: new Date().toISOString(),
          sources: sources.length,
        };
        const isFallback = provider.id === DUCKDUCKGO.id;
        let content;
        if (config.provenance === 'always') {
          content = isFallback ? 'Served by DuckDuckGo (keyless fallback).' : `Served by ${provider.label}.`;
        } else if (config.provenance === 'on-fallback' && isFallback) {
          const detail = attempted
            .map((id) => {
              const f = state.failures.get(id);
              return f ? `${id} (${f.code})` : id;
            })
            .join(', ');
          content = detail
            ? `Served by DuckDuckGo (keyless fallback) after ${detail} failed.`
            : 'Served by DuckDuckGo (keyless fallback): no API keys configured.';
        }
        return { sources, truncated: false, ...(content ? { content } : {}) };
      } catch (err) {
        if (isAborted(err) || signal?.aborted) throw abortError();
        recordFailure(provider.id, err);
        if (provider.id !== DUCKDUCKGO.id) attempted.push(provider.id);
      }
    }

    const detail = [...state.failures.entries()]
      .map(([id, f]) => `${id}: ${f.code} — ${f.message}`)
      .join('; ');
    throw new Error(
      `All web search providers failed for "${shortText(query, 120)}": ${detail}. ` +
        'Check the keys (websearch_status) or the network, and try again.',
    );
  }

  function abortError() {
    const err = new Error('web search aborted');
    err.code = 'aborted';
    return err;
  }

  /** Snapshot for the websearch_status tool and /websearch command. */
  function status() {
    return {
      enabled: settings ? settings.enabled() : true,
      last: state.last,
      failures: [...state.failures.entries()].map(([provider, f]) => ({
        provider,
        ...f,
      })),
    };
  }

  return { search, status, chainForCall, allProviders: API_PROVIDERS, duckduckgo: DUCKDUCKGO };
}
