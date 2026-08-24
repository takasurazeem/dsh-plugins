// websearch-dsh — browser half.
//
// Registers a "Web Search" card on the dsh web client's
// Settings → Plugins → Configurable tab (the shared slot
// `settings.plugin.item`, keyed by this plugin's settings namespace).
//
// The card is ONE control: a toggle. Clicking it writes
// `websearch-dsh.enabled` to the harness settings document
// (~/.dsh/settings.yaml) through the loopback settings transport —
// one field per write, fenced by the namespace revision. The Host
// publishes the committed change, the shared settings mirror folds it
// in, and the plugin's server side (the search chain) sees it on the
// very next web_search call. No restart, no staged-draft form: a click
// is the save.
//
// The module is a plain built bundle: no build step of its own. It
// requires `react`, `react/jsx-runtime`, and the snapshot-store face of
// the harness's client runtime — all inside the web shell's implicit
// baseline (statically seeded or parser-preloaded), which is why the
// package.json dsh.client block declares no `external` list. The card
// renders nothing while its namespace is unavailable (a deployment
// without the plugin's server half, or a remote browser, where
// settings never cross the wire).
//
// Dependencies are declared on two layers, exactly like the
// first-party settings cards:
//   1. CODE edges: the `require()` calls in the factory below,
//      answered by the module table (a non-baseline package would
//      need a dsh.client.external declaration to constrain arrival).
//   2. SERVICE edges: the `inject` export — the cordis service names
//      apply() consumes: `slots` (provided by dsh-client-runtime) and
//      `settingsScope` (provided by dsh-client-ui-settings). The
//      browser fiber waits on exactly these services before the card
//      registers, so the card appears only once both first-party
//      entries are active. These must be semantic service names — the
//      browser composition never provides services under package
//      names, and a package-name inject leaves the fiber pending
//      forever ("web boot: 1 entry did not activate").
// The dsh.client.inject in package.json is informational graph
// metadata only (preflight display / HMR diffing) — the same pattern
// the first-party client packages use; it does not feed the fiber.

// Required services (the fiber's inject list) — service names, never
// package names.
const inject = ['slots', 'settingsScope'];

window.__ModuleLoader__.load({
  id: 'websearch-dsh',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const reactJsx = require('react/jsx-runtime');
    const runtime = require('@deepseek-ai/dsh-client-runtime/client');

    const NS = 'websearch-dsh';

    // ── styles (inline: a plugin card has no CSS-module build step) ───
    const card = {
      border: '1px solid var(--dsw-alias-border-l2, #333)',
      borderRadius: 10,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxWidth: 760,
      color: 'var(--dsw-alias-label-primary, #ddd)',
    };
    const title = {
      fontSize: 15,
      fontWeight: 600,
      margin: 0,
    };
    const desc = {
      margin: 0,
      fontSize: 12.5,
      lineHeight: 1.5,
      color: 'var(--dsw-alias-label-tertiary, #888)',
    };
    const row = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontSize: 13.5,
      cursor: 'pointer',
      userSelect: 'none',
    };
    const checkbox = { width: 16, height: 16, cursor: 'inherit' };
    const muted = {
      margin: 0,
      fontSize: 12,
      color: 'var(--dsw-alias-label-tertiary, #777)',
    };

    /**
     * Bridges the bound settings scope onto a snapshot store the card
     * component reads through its `useWebSearchCard` hook, and owns the
     * one-click write.
     */
    class WebSearchCardController {
      scope;
      store;
      writing = false;
      failed = false;

      constructor(scope) {
        this.scope = scope;
        this.store = runtime.createSnapshotStore(this.project());
        this.scope.subscribe(() => {
          this.store.set(this.project());
        });
      }

      project() {
        const snapshot = this.scope.getSnapshot();
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          enabled: snapshot.value?.enabled !== false, // base default: on
          writing: this.writing,
          failed: this.failed,
        };
      }

      /**
       * The face the slot registration injects. The `hooks` entry becomes
       * the `useWebSearchCard` prop; `toggle` is the one-click action.
       */
      inject() {
        return {
          hooks: { webSearchCard: this.store },
          toggle: () => this.toggle(),
        };
      }

      async toggle() {
        if (this.writing) return;
        const snapshot = this.scope.getSnapshot();
        if (snapshot.status !== 'ready' || !snapshot.writable) return;
        const next = !(snapshot.value?.enabled !== false);
        this.writing = true;
        this.failed = false;
        this.store.set(this.project());
        try {
          // One field per write, fenced by the namespace revision; the
          // Host's answer folds into the mirror and re-projects.
          await this.scope.set('enabled', next);
        } catch {
          this.failed = true;
        } finally {
          this.writing = false;
          this.store.set(this.project());
        }
      }
    }

    /** The card itself. */
    function WebSearchCard(props) {
      const state = props.useWebSearchCard((snapshot) => snapshot);
      if (!state.available) return null;
      const off = !state.enabled;
      return reactJsx.jsxs('div', {
        style: card,
        children: [
          reactJsx.jsx('h3', { style: title, children: 'Web Search' }),
          reactJsx.jsx('p', {
            style: desc,
            children:
              'web_search is served by the websearch-dsh plugin: keyed providers in priority order (Tavily → Exa → Firecrawl → Brave → Serper) with a keyless DuckDuckGo fallback. ' +
              'Turning web search off makes web_search decline instead of calling any provider, so no API credits are spent.',
          }),
          reactJsx.jsxs('label', {
            style: { ...row, cursor: state.writable ? 'pointer' : 'default' },
            children: [
              reactJsx.jsx('input', {
                type: 'checkbox',
                style: checkbox,
                checked: state.enabled,
                disabled: !state.writable || state.writing,
                onChange: () => props.toggle(),
              }),
              reactJsx.jsx('span', {
                children: state.enabled ? 'Web search is on' : 'Web search is off',
              }),
            ],
          }),
          state.failed
            ? reactJsx.jsx('p', {
                style: { ...muted, color: '#e5534b' },
                children: 'The change could not be saved; the mirror will retry the read.',
              })
            : null,
          !state.writable
            ? reactJsx.jsx('p', {
                style: muted,
                children: 'Read-only here: settings apply to the local (loopback) browser only.',
              })
            : null,
        ],
      });
    }

    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS });
      const controller = new WebSearchCardController(scope);
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NS,
            inject: () => controller.inject(),
          },
          WebSearchCard,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
