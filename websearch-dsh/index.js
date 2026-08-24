// websearch-dsh — a native multi-provider web search plugin for the
// DeepSeek Harness.
//
// On activation this wires up:
//   1. ONE search provider (id `websearch-dsh`) on the ctx.web seam: a
//      fallback chain over Tavily → Exa → Firecrawl → Brave → Serper
//      (whichever have keys, in priority order) plus keyless DuckDuckGo.
//      The harness's own `web_search` tool (dsh-tool-web) is the single
//      model-facing tool — this plugin never shadows it.
//   2. A `websearch_status` read-only tool: keys present, live chain,
//      last serving provider, recent per-provider failures.
//   3. The /websearch status command when a commands service is present.
//   4. A `websearch-dsh:status` model-context section (one stable
//      paragraph; zero tokens when disabled).
//   5. A bundle patch layer that points the `web` row's searchProvider
//      at this plugin, so web_search works even with no DEEPSEEK_API_KEY.
//   6. The user-facing on/off toggle: a `websearch-dsh` section in the
//      harness settings document (~/.dsh/settings.yaml), editable live
//      from the dsh web client (Settings → Plugins → Web Search). The
//      chain checks it on every search — off means web_search declines
//      without spending any API credit. The shipped client.js renders
//      the card on the Settings → Plugins → Configurable tab.
//
// Keys never live in config: each provider's key is resolved per search
// from the credentials seam (the refs the web Credentials screen writes)
// or the process environment, under the names in config.envKeys.
// DuckDuckGo needs no key and is the last-resort leg, so the composite
// provider is always `available()` — the seam's selection never
// dead-ends.

import { OWNER, PROVIDER_ID, normalizeConfig, Config } from './src/config.js';
import { createSearchChain } from './src/fallback.js';
import { API_PROVIDERS, DUCKDUCKGO, PROVIDERS_BY_ID } from './src/providers/index.js';
import { registerTools } from './src/tools.js';
import { resolveApiKey } from './src/keys.js';
import { registerWebSearchSettings } from './src/settings.js';

export const name = 'websearch-dsh';

// The only hard dependency is the web capability seam (dsh-base mounts
// it in every mode — standard, headless, web). Everything else
// (tools, credentials, systemPrompt, commands) is accessed opportunistically
// so a custom composition lacking one of them never leaves the plugin
// pending: the chain and web_search itself keep working.
export const inject = ['web'];

export { Config };

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const env = process.env;

  // The user-facing toggle (dsh web client: Settings → Plugins → Web
  // Search), durable in the settings document and live per search call.
  // Null when the composition lacks the settings service: no toggle,
  // search stays enabled.
  const settings = registerWebSearchSettings(ctx);
  const chain = createSearchChain({ config, ctx, env, settings });

  // 1. The composite provider on the ctx.web seam. `available()` is a
  // cheap constant true (the keyless DuckDuckGo leg guarantees it); the
  // real per-provider key checks happen per search call inside search().
  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    available: () => true,
    search: (request, signal) => chain.search(request, signal),
  });

  // 2. The read-only status tool (no tools service → skipped).
  const tools = ctx.get('tools');
  if (tools) registerTools(ctx, { config, chain, env });

  // 3. /websearch status (no commands service → skipped).
  const commands = ctx.get('commands');
  if (commands) {
    commands.register({
      name: 'websearch',
      description: 'Web search plugin: /websearch status',
      input: { hint: 'status' },
      handler: (invocation) => commandHandler(invocation),
    });
  }

  async function commandHandler(invocation) {
    const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || 'status').toLowerCase();
    if (sub !== 'status') {
      return { kind: 'error', text: 'Usage: /websearch status' };
    }
    const value = await buildStatusValueLive(ctx, config, chain, env);
    return { kind: 'success', text: renderStatus(value) };
  }

  // 4. The model-facing context section. The key snapshot is taken once
  // at activation (text providers may not await); the live per-search
  // truth stays with the chain, and websearch_status is always current.
  if (config.context.enabled) {
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt) {
      let snapshot = '';
      void (async () => {
        const names = [];
        for (const id of config.priority) {
          const p = PROVIDERS_BY_ID.get(id);
          if (!p) continue;
          const key = await resolveApiKey(ctx, config.envKeys[id] ?? p.envKey, env);
          if (key) names.push(p.label);
        }
        snapshot = names.length
          ? `Web search: the web_search tool is served by the websearch-dsh plugin. Providers are tried in order: ${names.join(' → ')} → DuckDuckGo (keyless). DuckDuckGo serves automatically when no API key is configured, or when every keyed provider fails (rate limit, quota, auth, outage). websearch_status (or /websearch status) shows the live chain and recent per-provider failures.`
          : 'Web search: web_search is currently served by the keyless DuckDuckGo fallback (no API key configured). Set TAVILY_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY (environment or Credentials screen) to prefer a keyed provider — the chain re-resolves on every search. websearch_status shows the live chain.';
      })();
      systemPrompt.context({
        name: `${OWNER}:status`,
        order: config.context.order,
        // Live: a user can flip the toggle at any time (Settings →
        // Plugins → Web Search), so the text re-reads it each render
        // instead of a frozen snapshot.
        text: () =>
          settings && !settings.enabled()
            ? 'Web search is currently DISABLED by the user (dsh web client: Settings → Plugins → Web Search, or websearch-dsh.enabled: false in ~/.dsh/settings.yaml). Do not call web_search until it is re-enabled.'
            : snapshot,
      });
    }
  }
}

// ── status rendering, shared by the command (the tool builds its own
//    equivalent value live in src/tools.js) ───────────────────────────────

function renderStatus(value) {
  const lines = [
    value.enabled
      ? 'Web search: enabled.'
      : 'Web search: DISABLED by the user (Settings → Plugins → Web Search, or websearch-dsh.enabled in ~/.dsh/settings.yaml).',
    'Web search providers (fallback order):',
  ];
  for (const p of value.providers) {
    const inChain = value.chain.includes(p.id);
    lines.push(
      `  ${p.id} (${p.label}) — ${inChain ? 'in chain' : 'skipped (no key)'}${p.envKey ? ` [${p.envKey}]` : ' [keyless, always available]'}${p.lastFailureCode ? ` — last failure: ${p.lastFailureCode}` : ''}`,
    );
  }
  if (value.last) {
    lines.push(`Last search: served by ${value.last.provider} — "${value.last.query}" (${value.last.sources} sources, ${value.last.at}).`);
  }
  if (value.failures?.length) {
    lines.push('Recent failures:');
    for (const f of value.failures) lines.push(`  ${f.provider}: ${f.code} — ${f.message} (${f.at})`);
  }
  return lines.join('\n');
}

// Exposed for tests and for the status tool's executor (which builds its
// own value the same way, live).
export function buildStatusValueLive(ctx, config, chain, env = process.env) {
  return (async () => {
    const providers = [];
    for (const p of API_PROVIDERS) {
      const envKey = config.envKeys[p.id] ?? p.envKey;
      const key = await resolveApiKey(ctx, envKey, env);
      providers.push({ id: p.id, label: p.label, envKey, hasKey: key.length > 0 });
    }
    providers.push({ id: DUCKDUCKGO.id, label: DUCKDUCKGO.label, envKey: '', hasKey: true });
    const value = {
      enabled: chain.status().enabled !== false,
      chain: providers.filter((p) => p.hasKey).map((p) => p.id),
      providers,
      failures: chain.status().failures,
    };
    const last = chain.status().last;
    if (last) value.last = last;
    return value;
  })();
}
