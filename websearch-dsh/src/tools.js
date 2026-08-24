// The `websearch_status` tool: live introspection of the fallback chain.
//
// The model-facing search experience is the harness's own `web_search`
// tool (dsh-tool-web over the ctx.web seam) — this plugin never shadows
// it. This read-only tool answers "which providers are configured, what
// is the current chain, who served the last search, and what failed
// recently?" It never prompts.

import { API_PROVIDERS, DUCKDUCKGO } from './providers/index.js';
import { FAILURE_CODES } from './http.js';
import { resolveApiKey } from './keys.js';

// The dsh runtime provides @deepseek-ai/dsh-tools; a bare-repo test run can
// import this module without it. The import is tolerant: when the package is
// absent, registerTools() degrades to a no-op (no status tool, no command)
// while everything else in the plugin keeps working.
let dshTools = null;
try {
  dshTools = await import('@deepseek-ai/dsh-tools');
} catch {
  dshTools = null;
}

const dt = (def) => {
  if (!dshTools) throw new Error('@deepseek-ai/dsh-tools is not available in this runtime');
  return dshTools.defineTool(def);
};

const text = (s) => [{ type: 'text', text: String(s) }];

/**
 * Register `websearch_status` on the tool runtime.
 *
 * @param {object} ctx cordis context. The tools service is resolved
 *   leniently via `ctx.get('tools')` — the real ctx is a strict proxy
 *   whose direct property reads throw for any service outside the
 *   plugin's `inject` list, and `tools` is deliberately not injected (the
 *   plugin must activate without it). Plain-object doubles that expose
 *   `tools` as a property are also honored (test fakes).
 * @param {object} deps
 *   config — normalized row config
 *   chain  — the createSearchChain() instance
 *   env    — environment read for key presence (process.env by default)
 */
export function registerTools(ctx, deps) {
  if (!dshTools) return; // bare runtime without the dsh packages → no status tool
  const { config, chain, env = process.env } = deps;

  async function buildStatus() {
    const providers = [];
    for (const p of API_PROVIDERS) {
      const envKey = config.envKeys[p.id] ?? p.envKey;
      const key = await resolveApiKey(ctx, envKey, env);
      providers.push({
        id: p.id,
        label: p.label,
        envKey,
        hasKey: key.length > 0,
      });
    }
    providers.push({ id: DUCKDUCKGO.id, label: DUCKDUCKGO.label, envKey: '', hasKey: true });

    const { last, failures, enabled } = chain.status();
    const chainIds = [];
    for (const p of providers) {
      // duckduckgo is always in the chain; keyed providers when keyed.
      if (p.hasKey) chainIds.push(p.id);
    }

    const value = {
      chain: chainIds,
      providers,
      failures,
      enabled: enabled !== false,
    };
    if (last) {
      value.last = {
        provider: last.provider,
        query: last.query,
        at: last.at,
        sources: last.sources,
      };
    }
    return value;
  }

  // The real cordis ctx is a strict proxy: a direct property read for a
  // service outside the plugin's `inject` list throws (`cannot get
  // property "tools" without inject`), so resolve leniently — the same
  // pattern as resolveApiKey() in src/keys.js. index.js already gates on
  // presence before calling here; the plain-property branch only serves
  // test doubles that expose `tools` directly.
  const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools;
  if (!tools) return; // composition without a tools service → nothing to register
  tools.register(dt({
    name: 'websearch_status',
    description:
      'Status of the websearch-dsh search plugin: which provider API keys are present (Tavily, Exa, Firecrawl, Brave, Serper), the current fallback chain (keyed providers in priority order, then keyless DuckDuckGo), the provider that served the most recent web_search call, and recent per-provider failures (rate limit, quota, auth, …). Read-only; call it to diagnose a search that fell back or failed.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            required: true,
            description:
              'Whether the user has web search enabled (Settings → Plugins → Web Search, or websearch-dsh.enabled in ~/.dsh/settings.yaml). When false, web_search declines without calling any provider.',
          },
          chain: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Provider ids tried in order for the next search call.',
          },
          providers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                envKey: { type: 'string', required: true },
                hasKey: { type: 'boolean', required: true },
              },
              additionalProperties: false,
            },
            required: true,
          },
          last: {
            type: 'object',
            properties: {
              provider: { type: 'string', required: true },
              query: { type: 'string', required: true },
              at: { type: 'string', required: true },
              sources: { type: 'integer', required: true },
            },
            additionalProperties: false,
          },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                provider: { type: 'string', required: true },
                code: { type: 'string', required: true },
                at: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
            required: true,
          },
        },
        additionalProperties: false,
      },
      render: (_args, v) => {
        const lines = [
          v.enabled
            ? 'Web search: enabled.'
            : 'Web search: DISABLED by the user — web_search will decline until re-enabled (Settings → Plugins → Web Search, or websearch-dsh.enabled in ~/.dsh/settings.yaml).',
          'Web search providers (fallback order):',
        ];
        for (const p of v.providers) {
          const inChain = v.chain.includes(p.id);
          lines.push(
            `  ${p.id} (${p.label}) — ${inChain ? 'in chain' : 'skipped (no key)'}${p.envKey ? ` [${p.envKey}]` : ' [keyless, always available]'}`,
          );
        }
        if (v.last) {
          lines.push(`Last search: served by ${v.last.provider} — "${v.last.query}" (${v.last.sources} sources, ${v.last.at}).`);
        } else {
          lines.push('Last search: none yet in this process.');
        }
        if (v.failures.length) {
          lines.push('Recent failures:');
          for (const f of v.failures) {
            lines.push(`  ${f.provider}: ${f.code} — ${f.message} (${f.at})`);
          }
        }
        lines.push(
          'Keys: set the env vars above in the launching environment or store them as credential refs; the chain re-resolves on every search. ' +
            'To revert to the built-in DeepSeek route, point the `web` row config searchProvider back to deepseek-official in your profile patch layer.',
        );
        return text(lines.join('\n'));
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute() {
      return buildStatus();
    },
  }));
}

export { FAILURE_CODES };
