// Config defaults and normalization for websearch-dsh.
//
// DSH credentials doctrine: config carries references, never secrets. The
// provider API keys are resolved per search through the credentials seam
// (ctx.credentials refs — the same names the web Credentials screen writes)
// or the process environment, using the env-var names in `envKeys`.
//
// The bundle patch layer deliberately does NOT restate `envKeys` or
// `priority`: an explicit value in a patch layer overrides the code
// defaults, so a restated list would silently pin whatever the code had at
// bundle-authoring time (the same lesson as gmail's stale `scopes`
// regression). The defaults below are the single source of truth; override
// them in your own profile patch layer if you must.

export const OWNER = 'websearch-dsh';

// The id under which this plugin registers its composite provider on the
// ctx.web seam — and the value the bundle's patch layer puts into the
// `web` row's `searchProvider` config so the built-in web_search tool is
// served by this plugin instead of the DeepSeek route.
export const PROVIDER_ID = 'websearch-dsh';

// Provider id → default env-var name (credential ref name) holding its key.
export const DEFAULT_ENV_KEYS = {
  tavily: 'TAVILY_API_KEY',
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
};

// The keyless last-resort leg. Always present in the chain; it is the
// "DuckDuckGo fallback" of the plugin's contract.
export const DUCKDUCKGO_ID = 'duckduckgo';

// Fallback-chain order across the keyed providers (DuckDuckGo always last).
// Tavily first per the deployment default; re-order in your own profile
// patch layer.
export const DEFAULT_PRIORITY = ['tavily', 'exa', 'firecrawl', 'brave', 'serper'];

export const defaults = {
  envKeys: DEFAULT_ENV_KEYS,
  priority: DEFAULT_PRIORITY,
  // Per-provider request budget (ms). A failing provider consumes its
  // budget before the chain moves on, so the worst-case serial walk over
  // five keyed providers is bounded by ~5× this before DuckDuckGo is
  // reached. The tool-level searchTimeoutMs (the harness enforces it by
  // aborting the shared signal) is the outer bound.
  providerTimeoutMs: 10_000,
  // What the "served by <provider>" provenance note on the web_search
  // result says:
  //   'off'         — never annotate (cleanest output)
  //   'on-fallback' — annotate only when keyless DuckDuckGo served the
  //                   search, i.e. the fallback actually happened (no keys
  //                   configured, or every keyed provider failed)
  //   'always'      — always annotate with the serving provider
  provenance: 'on-fallback',
  context: { enabled: true, order: 118 },
};

const str = (v, d) => (typeof v === 'string' ? v : d);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const enumOf = (v, allowed, d) => (allowed.includes(v) ? v : d);

function envKeysMap(v, d) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return d;
  const out = {};
  for (const id of Object.keys(d)) {
    const x = v[id];
    out[id] = typeof x === 'string' && x.trim() ? x : d[id];
  }
  return out;
}

function priorityList(v, known) {
  if (!Array.isArray(v)) return known;
  const out = [];
  for (const x of v) {
    if (typeof x === 'string' && known.includes(x) && !out.includes(x)) out.push(x);
  }
  return out.length ? out : known;
}

/**
 * Normalize arbitrary row config into the exact shape the plugin consumes.
 * Defensive on purpose: the loader may hand us a sparse or partially typed
 * object, and patch layers replace whole row configs, so every field is
 * restated explicitly here.
 */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cx = r.context && typeof r.context === 'object' ? r.context : {};
  return {
    envKeys: envKeysMap(r.envKeys, defaults.envKeys),
    priority: priorityList(r.priority, DEFAULT_PRIORITY),
    providerTimeoutMs: num(r.providerTimeoutMs, defaults.providerTimeoutMs),
    provenance: enumOf(r.provenance, ['off', 'on-fallback', 'always'], defaults.provenance),
    context: {
        enabled: bool(cx.enabled, defaults.context.enabled),
        order: num(cx.order, defaults.context.order),
      },
  };
}

/**
 * The plugin `Config` export, matched to the real DSH contract:
 *   - the cordis runtime's `resolveConfig` calls
 *     `Config['~standard'].validate(raw)` synchronously and expects either
 *     `{value}` (the normalized config) or `{issues}` (a ValidationError is
 *     raised). It throws if the result is a promise.
 *   - the cordis loader reads the optional `Config.simplify` hook to
 *     normalize the row config before HMR write-back.
 * `normalizeConfig` is the source of truth for both.
 */
export const Config = {
  '~standard': {
    version: 1,
    validate(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'websearch-dsh config must be a plain object' }] };
      }
      return { value: normalizeConfig(value) };
    },
  },
  simplify: (value) => normalizeConfig(value),
  defaults,
};
