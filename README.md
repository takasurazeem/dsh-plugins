# dsh-plugins

Two **native plugins** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — the agent runtime where models, tools, skills, sessions, sandboxes, and the UI are all composable plug-ins.

| Plugin | What it gives your agent |
| --- | --- |
| **[gmail-dsh](gmail-dsh/)** | Your Gmail, natively: search and read the mailbox, send (thread-aware), and manage labels. Google OAuth 2.0 (PKCE) with per-account grants in the DSH credential store, approval prompts on every send/label change, a `/gmail` command, and a zero-token-until-authorized model-context section. |
| **[websearch-dsh](websearch-dsh/)** | `web_search` that survives the real world: a fallback chain over **Tavily → Exa → Firecrawl → Brave → Serper → DuckDuckGo (keyless)**, so search works even with **no DeepSeek API key**, rides through per-provider rate limits/quota/outages, and carries a one-click on/off toggle in the web GUI. |

Both are **MIT-licensed** and dependency-light (no MCP server, no sidecar process, no third-party runtime beyond the harness itself).

---

## Why "native" instead of MCP?

Model Context Protocol servers work, but they run *beside* the harness: a separate process, its own lifecycle, and a translation layer that can't express harness-native capabilities. These plugins register **directly on the harness seams**:

- **Tools** — real entries in the tool runtime (schema-validated, with the harness's approval service gating mutating operations: `gmail_send` / `gmail_labels` ask the user; reads never do; `websearch_status` is read-only).
- **Credentials** — secrets live in the DSH credential store (`~/.dsh/.credentials.yaml` / env), never in config files or chat. The Gmail refresh token is a grant record owned by the plugin; web-search keys are resolved *per call*.
- **Settings** (websearch) — the on/off toggle persists in `~/.dsh/settings.yaml` through the harness's live-watched settings service; a GUI click takes effect on the next call, no restart.
- **System prompt** — one stable, cache-safe paragraph tells the model what's connected; it costs **zero tokens while idle**.
- **Commands** — `/gmail …` and `/websearch …` for humans in chat.

The payoff: no extra process to keep alive, harness-level approval semantics, and configuration that behaves like first-party features.

---

## Quick start

Prerequisites: dsh ≥ 0.1.2 installed (both plugins were developed against `0.1.1-rc.2` and up), Node 20+.

### 1. Clone this repo

```sh
git clone https://github.com/takasurazeem/dsh-plugins.git
```

### 2. Add both to your profile

Edit your profile's `package.json` (e.g. `~/.dsh/profiles/web/package.json`):

```json
{
  "dependencies": {
    "gmail-dsh": "file:/path/to/dsh-plugins/gmail-dsh",
    "websearch-dsh": "file:/path/to/dsh-plugins/websearch-dsh"
  },
  "dsh": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "gmail-dsh",
      "websearch-dsh"
    ]
  }
}
```

then in the profile directory:

```sh
pnpm install
```

For **live development** of a plugin, symlink the checkout instead of letting pnpm copy it, so edits apply on the next composition:

```sh
ln -sfn /path/to/dsh-plugins/gmail-dsh    node_modules/gmail-dsh
ln -sfn /path/to/dsh-plugins/websearch-dsh node_modules/websearch-dsh
```

### 3. Restart

```sh
dsh web
```

### 4. Per-plugin setup

- **gmail-dsh** → run `/gmail auth` in chat after storing your Google OAuth client id/secret. Full instructions: [gmail-dsh/README.md](gmail-dsh/README.md).
- **websearch-dsh** → works immediately (keyless DuckDuckGo leg). To prefer keyed providers, put any subset of `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY` in `~/.dsh/.env` (or the Credentials screen). The on/off toggle lives at **Settings → Plugins → Web Search** in the web GUI. Full instructions: [websearch-dsh/README.md](websearch-dsh/README.md).

### 5. Verify

| Check | Command / where | Expect |
| --- | --- | --- |
| Gmail tools | `/gmail status` in chat | Authorized accounts, scopes, client status |
| Gmail search | ask the agent "search my inbox for …" | results via `gmail_search` |
| Web search | ask the agent a factual question / call `web_search` | sources — keyed provider first, DDG last |
| Web search status | `/websearch status` | live chain, key presence, last serving provider, failures |
| Web search toggle | Settings → Plugins → Configurable in the GUI | Web Search card; flip and re-search — instant |

---

## Repository layout

```
dsh-plugins/
├── README.md            ← you are here
├── LICENSE              ← MIT (root; each plugin carries its own copy)
├── gmail-dsh/
│   ├── index.js         ← plugin entry: wires tools, approval gate, /gmail, context
│   ├── src/
│   │   ├── config.js    ← Config contract + normalization (env names, scopes, approval)
│   │   ├── oauth.js     ← PKCE flow: auth URL, loopback callback, refresh rotation
│   │   ├── gmail.js     ← Gmail REST client (search/read/send/labels, paged)
│   │   └── tools.js     ← tool definitions + pre-execute approval decisions
│   ├── cordis.patch.yml ← bundle layer: row config only (deployment knobs)
│   ├── test.mjs         ← 100% offline suite (node test.mjs)
│   └── README.md
└── websearch-dsh/
    ├── index.js         ← plugin entry: registers the composite provider + status
    ├── client.js        ← web client: the Settings→Plugins toggle card (plain bundle)
    ├── src/
    │   ├── config.js    ← Config contract (env keys, priority, timeout, provenance)
    │   ├── fallback.js  ← the chain: per-call key resolution, walk, provenance, toggle guard
    │   ├── http.js      ← fetch wrapper: timeouts, abort, failure classification
    │   ├── keys.js      ← per-call key resolution (credential store → env)
    │   ├── settings.js  ← the settings.yaml toggle namespace (live-watched)
    │   ├── tools.js     ← websearch_status
    │   └── providers/   ← tavily, exa, firecrawl, brave, serper, duckduckgo (3 legs)
    ├── cordis.patch.yml ← bundle layer: searchProvider row + search-multi insert
    ├── test.mjs         ← 100% offline suite (node test.mjs)
    └── README.md
```

## Developing

Each plugin is self-contained and testable from a bare checkout (no dsh install required):

```sh
cd gmail-dsh    && node test.mjs   # offline: faked HTTP, faked credential store
cd websearch-dsh && node test.mjs  # offline: faked fetch routes per provider
```

When the harness's packages are resolvable (e.g. the plugin is wired into a profile with its `node_modules` symlinks pointing at the dsh farm), the suites run their full variant against the real `dsh-tools`, `dsh-credentials`, `dsh-settings`, and `schemastery` packages.

Useful verification commands (with a scratch `DSH_HOME`):

```sh
dsh --profile <name> --dump-config     # composition + bundle patch layer land cleanly
```

## Notes

- **Community project.** These plugins are not affiliated with or endorsed by DeepSeek or the dsh maintainers; they target the public dsh plugin seams (cordis composition, tool runtime, credential store, settings service) as documented in the harness.
- **Your data stays yours.** Gmail credentials are stored only in your local DSH credential store; web-search keys only in your env/credential store. Neither plugin phones home or includes telemetry.
- **API keys.** Web-search provider keys are your own (each provider has a free tier — see [websearch-dsh/README.md](websearch-dsh/README.md#provider-reference)). The Gmail plugin needs a Desktop-type OAuth client you create in your own Google Cloud project.

## License

MIT — see [LICENSE](LICENSE). Each plugin directory carries its own MIT license file for standalone installation.
