# dsh-plugins

Umbrella home for the native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugins in this account. Each plugin lives in its own standalone repository:

| Plugin | Repository | What it gives your agent |
| --- | --- | --- |
| **gmail-dsh** | [takasurazeem/gmail-dsh](https://github.com/takasurazeem/gmail-dsh) | Your Gmail, natively: search/read, approval-gated send (thread-aware) and label management, Google OAuth 2.0 (PKCE) with per-account grants in the DSH credential store, a `/gmail` command, and a zero-token-until-authorized model-context section. |
| **websearch-dsh** | [takasurazeem/websearch-dsh](https://github.com/takasurazeem/websearch-dsh) | `web_search` that survives the real world: a fallback chain over **Tavily → Exa → Firecrawl → Brave → Serper → DuckDuckGo (keyless)** — works without a DEEPSEEK_API_KEY, rides through rate limits/quota/outages, with a one-click on/off toggle in the web GUI. |

## Install

Each repo is self-contained; see its README for full setup. In short — for a profile like `~/.dsh/profiles/web`:

```json
{
  "dependencies": {
    "gmail-dsh": "file:/path/to/gmail-dsh",
    "websearch-dsh": "file:/path/to/websearch-dsh"
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

then `pnpm install` in the profile directory and restart `dsh web`. After that: `/gmail auth` once in chat, and (optionally) drop any subset of the web-search provider keys into `~/.dsh/.env`.

## Why "native" instead of MCP?

MCP servers run *beside* the harness: a separate process, its own lifecycle, and a translation layer that can't express harness-native capabilities. These plugins register **directly on the harness seams** — tools (with the harness approval service gating mutations), the credential store, the settings document (live-watched), the system prompt, and the web client — so they behave like first-party features: no sidecar to keep alive, approval prompts the harness owns, and configuration that updates without restarts.

## Notes

- **Community project.** Not affiliated with or endorsed by DeepSeek or the dsh maintainers; targets the public dsh plugin seams (cordis composition, tool runtime, credential store, settings service).
- **Your data stays yours.** Gmail credentials live only in your local DSH credential store; web-search keys only in your env/credential store. No telemetry, no phoning home.

## License

Each plugin is MIT-licensed under its own repository.
