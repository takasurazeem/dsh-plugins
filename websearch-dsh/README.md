# websearch-dsh

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that replaces the harness's built-in single-provider `web_search` backend with a **resilient multi-provider fallback chain** — so `web_search` works **without a DEEPSEEK_API_KEY**, survives per-provider rate limits / quota exhaustion / outages, and — when no key is configured at all — still answers via keyless DuckDuckGo.

Part of the [dsh-plugins](../README.md) repo. MIT-licensed. No MCP server, no sidecar process: it registers on the harness `web` seam, and the built-in `web_search` tool stays the single model-facing tool.

---

## Table of contents

- [What you get](#what-you-get)
- [How the chain works](#how-the-chain-works)
- [The on/off toggle](#the-onoff-toggle)
- [Setup](#setup)
- [Provider reference](#provider-reference)
- [Failure classification](#failure-classification)
- [The DuckDuckGo leg](#the-duckduckgo-leg)
- [Verification](#verification)
- [Configuration reference](#configuration-reference)
- [Developing the plugin](#developing-the-plugin)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Reverting / uninstalling](#reverting--uninstalling)
- [License](#license)

---

## What you get

| Surface | What it does |
| --- | --- |
| The `web_search` tool | Unchanged from the harness's perspective — same tool, same model, now served by the chain. |
| `websearch_status` tool | Read-only: which providers have keys, the live chain, last serving provider, recent per-provider failures, toggle state. |
| `/websearch status` command | Same info, rendered for humans in chat. |
| Model-context section | One stable paragraph (zero tokens until it matters): what serves `web_search`, in what order, and whether the user has it enabled. Re-reads the live state on each render. |
| GUI toggle card | **Settings → Plugins → Configurable → Web Search** in the dsh web client: one click, no restart. |
| Bundle patch layer | Points the harness `web` row's `searchProvider` at this plugin, so search works with no DeepSeek key at all. |

## How the chain works

```
web_search "…"
   │
   ├─ toggle off?  ──▶  decline immediately (no provider called, no credit spent)
   │
   ├─ resolve keys per call ──▶ credential store refs first, then process env
   │
   ├─ Tavily ──fail──▶ Exa ──fail──▶ Firecrawl ──fail──▶ Brave ──fail──▶ Serper
   │        (only providers with a non-empty key are in the chain; priority order)
   │
   └─ DuckDuckGo (always last, no key required)
         └─ 3 legs in order: d.js JSON → lite HTML → Instant API
```

Key properties:

- **Keys are resolved on every search** — from the DSH credential store (the refs the web Credentials screen writes) first, then `process.env`. A key added to `~/.dsh/.env` or stored in the Credentials screen after startup is picked up on the next search, **no restart**. Keys are never stored by the plugin.
- **Any failure falls through.** Auth, quota, rate limit, timeout, network, and parse failures each advance the chain to the next provider. Only a *caller abort* (the model/harness cancelling the search) stops the walk early.
- **One combined error** is reported only when *every* leg fails, naming each provider and why: `All web search providers failed for "…": tavily: auth — …; serper: quota — …; duckduckgo: network — …`.
- **Provenance** (default `on-fallback`): when the keyless DuckDuckGo leg is what served, the result carries a note the model can see — e.g. `Served by DuckDuckGo (keyless fallback) after tavily (rate), exa (auth) failed.` `always` annotates every provider; `off` stays silent.
- **Clamping**: `maxResults` is clamped to 1–50 (default 10); empty queries are rejected before any network I/O.

## The on/off toggle

The plugin registers a `websearch-dsh` namespace in the harness **settings document** (`~/.dsh/settings.yaml`) through the live-watched `settings` service:

```yaml
# created on first GUI click (or by hand):
websearch-dsh:
  enabled: false
```

- **Default is on** (the registered `base` layer is `{enabled: true}`; an absent section means enabled).
- **The search chain checks the flag on every call.** Off → `web_search` declines with a model-friendly message ("disabled by the user … do not call web_search until it is re-enabled") before any provider is contacted — so **zero API credit is spent while off**. `websearch_status`, the `/websearch` command, and the model-context section all reflect the state.
- **The GUI card** (a plain JS bundle shipped as `client.js` — no build step) renders on **Settings → Plugins → Configurable**. One click on the checkbox performs one revision-fenced write of `enabled`; the committed change is published by the settings service, the client mirror folds it in, and the server side sees it on the next call. **No restart, ever.**
- **External edits work too**: the settings file is watched, so editing `~/.dsh/settings.yaml` by hand applies live.
- **Loopback only**: dsh's settings transport serves the local browser. A remote browser sees the card as read-only (the flag is still global on the machine).
- **Tolerant**: a composition without the settings service simply has no toggle; search stays enabled. The plugin never hard-depends on it.

## Setup

### 1. API keys (any subset — all optional)

dsh loads two env layers at startup: the project `<cwd>/.env` and the user layer **`~/.dsh/.env`** (skipped when the project directory *is* your home directory). `.env` values only fill names **not already exported in the launching shell** — shell exports win. Quoted or unquoted values parse identically (Node's built-in env parser); `#` starts a comment.

```bash
# ~/.dsh/.env   (chmod 600 recommended)
TAVILY_API_KEY="tvly-…"      # best all-round; generous free tier
EXA_API_KEY="…"              # neural/keyword search
FIRECRAWL_API_KEY="fc-…"     # search + scrape
BRAVE_API_KEY="BSA…"         # Brave Search API
SERPER_API_KEY="…"           # Google SERP data
```

Or store them in the dsh web GUI's **Credentials** screen under the same names — credential refs are checked before the environment and are re-read on every search.

**If no key is configured, everything works via DuckDuckGo** (see [The DuckDuckGo leg](#the-duckduckgo-leg)).

### 2. Wire it into your profile

In your profile's `package.json` (e.g. `~/.dsh/profiles/web/package.json`):

```json
{
  "dependencies": {
    "websearch-dsh": "file:/path/to/dsh-plugins/websearch-dsh"
  },
  "dsh": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "websearch-dsh"
    ]
  }
}
```

then `pnpm install` in the profile directory. For live development, symlink the checkout instead of copying:

```sh
ln -sfn /path/to/dsh-plugins/websearch-dsh node_modules/websearch-dsh
```

The plugin's bundle patch layer (`cordis.patch.yml`) does the rest:

- inserts a `search-multi` row carrying the deployment knobs (timeout, provenance, context), and
- re-points the `web` row: `searchProvider: websearch-dsh`.

It deliberately carries **only deployment knobs** — never the key names or priority, which stay in code so they can't go stale.

### 3. Restart dsh

```sh
dsh web
```

A restart is needed once for the composition. After that: keys, the toggle, and every other runtime change apply live.

## Provider reference

| # | Provider | Endpoint | Auth | Free tier (at time of writing) | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | [Tavily](https://tavily.com) | `POST api.tavily.com/search` | `Authorization: Bearer` (legacy `api_key` also accepted) | ~1,000 credits/mo | Strong for research queries; `search_depth: advanced` used; results include snippets + relevance score. |
| 2 | [Exa](https://exa.ai) | `POST api.exa.ai/search` | `x-api-key` header | ~1,000 credits/mo | Neural/keyword/auto search; maps `text` → snippet, carries `publishedDate`. |
| 3 | [Firecrawl](https://firecrawl.dev) | `POST api.firecrawl.dev/v1/search` | `Authorization: Bearer` | ~500 credits | Also a scraping API; in-band `success:false` responses are classified (quota text → `quota`). |
| 4 | [Brave Search](https://brave.com/search/api/) | `GET api.search.brave.com/res/v1/web/search` | `X-Subscription-Token` header | ~2,000 queries/mo | GET with query string; maps the `web.results` block. |
| 5 | [Serper](https://serper.dev) | `POST google.serper.dev/search` | `X-API-KEY` header | ~2,500 credits | Google SERP data; maps `organic` (skips ads/answers). |
| 6 | [DuckDuckGo](https://duckduckgo.com) | 3 legs, see below | **none** | unlimited (rate-limited) | Keyless last resort; serialized across concurrent searches. |

Each provider module (`src/providers/<id>.js`) is a pure function of `(query, {key, maxResults, timeoutMs, legTimeoutMs, signal, fetch}) → {sources, truncated}` — trivially swappable or extendable. To add a provider: implement it, add it to `src/providers/index.js`, extend `DEFAULT_PRIORITY`/`DEFAULT_ENV_KEYS` in `src/config.js`.

## Failure classification

`src/http.js` classifies every failure so the chain (and the status tool) can report *why*:

| Code | Triggered by | Chain behavior |
| --- | --- | --- |
| `auth` | 401 / 403 (no quota text) | skip provider, try next |
| `quota` | 402, or 403/429 with quota-ish text ("quota", "credits", "exhausted", …) | skip provider, try next |
| `rate` | 429 (bare) | skip provider, try next |
| `timeout` | per-provider budget exceeded (default 10 s; DDG legs also cap at 8 s each) | skip provider, try next |
| `network` | fetch rejects (DNS, connection reset, TLS) | skip provider, try next |
| `parse` | 2xx but the body isn't the expected shape | skip provider, try next |
| `aborted` | the *caller's* signal aborted | **stop the whole walk** and rethrow |

Failures are remembered per provider in `websearch_status` (most recent first) and named in the combined all-failed error.

## The DuckDuckGo leg

Three attempts, in order, per search (a vendor's API has changed underfoot — the npm `duckduckgo-search` package is broken against current endpoints, so this plugin ships a fixed, dependency-free port):

1. **`d.js`** — harvest a `vqd` token from the HTML search page, then query `links.duckduckgo.com/d.js` for the JSON result set (deduped, tag/entity stripped).
2. **Lite HTML** — `lite.duckduckgo.com/lite` results page; result links are `uddg`-resolved and decoded.
3. **Instant API** — `api.duckduckgo.com/?q=…&format=json` (title + first paragraph + related topics).

Concurrency is **serialized** across searches (one in-flight leg at a time) as a politeness measure. Current status (2026-08): serving normally; from some networks/IPs DuckDuckGo intermittently returns an anti-bot **202 challenge** instead of results — the three legs usually get through, and when a challenge does bite you get the clear combined error naming it, not a hang.

## Verification

| Check | What to look for |
| --- | --- |
| `web_search` in chat, no `DEEPSEEK_API_KEY` set | Works: keyed providers first, DDG last. |
| `websearch_status` tool / `/websearch status` | `Web search: enabled.` (or `DISABLED`), live chain, key presence per provider, last serving provider, recent failures. |
| Settings → Plugins → Configurable in the web GUI | The **Web Search** card with the on/off checkbox. |
| `~/.dsh/settings.yaml` after a click | A `websearch-dsh: { enabled: … }` section appears. |
| `node test.mjs` in the plugin directory | 66/66 (one network test self-skips when offline). |

## Configuration reference

All fields optional; defaults shown. (These are the fields of the `search-multi` row the bundle patch inserts; a full custom composition can also set them on any plugin row.)

| Field | Default | Meaning |
| --- | --- | --- |
| `envKeys` | `{ TAVILY_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, BRAVE_API_KEY, SERPER_API_KEY }` | Env/credential names, per provider. |
| `priority` | `[tavily, exa, firecrawl, brave, serper]` | Chain order; unknown ids dropped, order preserved. |
| `providerTimeoutMs` | `10000` | Overall budget per provider call (each DDG leg also caps at 8 s). |
| `provenance` | `on-fallback` | `off` — never annotate · `on-fallback` — annotate when keyless DDG served · `always` — annotate every serving provider. |
| `context.enabled` | `true` | Emit the model-context section at all. |
| `context.order` | `118` | Ordering among model-context sections. |

## Developing the plugin

```sh
node test.mjs        # offline suite, plain Node, no framework
```

The suite covers: config normalization/`~standard` validation, the HTTP + classification layer, per-call key resolution, **every provider's request shape and response mapping** (faked fetch routes), the fallback chain (fall-throughs, provenance, clamping, abort semantics, DDG serialization, live key changes, the toggle), the status tool, and the settings/client contract (fake `settings` service + a fake `window.__ModuleLoader__` harness that runs the real `client.js`). Run it from a checkout with the dsh packages resolvable (e.g. your live-symlinked profile's `node_modules`) for the full variant against real `dsh-tools`/`dsh-credentials`/`dsh-settings`/`schemastery`; from a bare clone it degrades gracefully and still exercises everything that doesn't need them.

Composition check with a scratch `DSH_HOME`:

```sh
dsh --profile <name> --dump-config   # expect the websearch-dsh rows, no errors
```

## FAQ

**Why one composite provider instead of five?** The harness's `web` seam selects one `searchProvider` at construction time (`dsh-web` pins it — there is no runtime re-selection seam). A single composite provider is the only way to do failover *and* keep the built-in `web_search` tool as the single model-facing surface.

**Why not an MCP server?** Same reasoning as [the repo README](../README.md#why-native-instead-of-mcp): no sidecar process, harness-level settings/approval integration, and the GUI toggle.

**Does it work outside the web GUI?** Yes — the chain, tools, command, and context section are server-side and work in `dsh chat`/headless too. Only the toggle *card* is a web-client feature (the settings.yaml file works everywhere).

**Will it spend my credits while I'm just chatting?** Only when `web_search` is actually called and the toggle is on. The model-context section is one static paragraph.

**Can I reorder providers?** Yes — `priority` in the row config (e.g. put `serper` first). Unknown ids are dropped with a validation warning, never a crash.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `web_search` says "disabled by the user" | The toggle is off — flip it in the GUI or set `websearch-dsh.enabled: true` in `~/.dsh/settings.yaml`. |
| Status shows a provider without a key although you set the env | Check you set it in a layer dsh reads (`~/.dsh/.env` or the launching shell) and restarted dsh once; or use the Credentials screen (live). |
| Every search is served by DuckDuckGo with a provenance note | The keyed providers are failing — read `websearch_status` → failures (auth = bad key, quota = free tier exhausted, rate = throttled). |
| Combined "All web search providers failed" error | Network-level: the machine can't reach any provider API (or DDG is challenging you). The error lists each provider's code — fix the one that matches your setup. |
| The GUI card is missing | You're on a pre-0.1.2 GUI build, or a remote browser (loopback-only feature) — or the plugin isn't in the profile's `dsh.bundles`. |
| `web_search` still says "no API key for DEEPSEEK_API_KEY" after install | You haven't restarted `dsh web` since wiring the profile, or the bundle patch layer isn't applied (check `dsh --dump-config` for `searchProvider: websearch-dsh`). |

## Reverting / uninstalling

Re-point the `web` row in a profile-level bundle patch (`searchProvider: deepseek-official`) or simply remove `websearch-dsh` from the profile's `dsh.bundles`, then restart. Nothing else the plugin does depends on it; the settings section (if any) is inert without the plugin.

## License

MIT — see [LICENSE](LICENSE).
