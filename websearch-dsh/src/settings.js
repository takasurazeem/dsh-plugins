// The user-facing web-search toggle, durable in the harness settings
// document (~/.dsh/settings.yaml) under the `websearch-dsh` namespace.
//
// The `settings` service (file-backed by @deepseek-ai/dsh-settings-file,
// registered by dsh-base in every profile that includes it) is the store
// the web client's Settings → Plugins page writes through: writes are
// revision-fenced, the document is file-watched, and the service
// publishes changes to registered watchers — so flipping the GUI toggle
// is visible to this very process with no restart. We register the
// namespace (base layer `enabled: true`), cache the resolved value via
// the registration's watch callback, and expose it to the search chain
// as a per-call check.
//
// Tolerant by design: a composition without the settings service
// (minimal headless setups, older dsh builds) simply has no toggle, and
// search stays enabled. The plugin's core behavior never depends on it.

// The dsh runtime provides these; a bare-repo test run can import this
// module without them, so both imports are tolerant.
let settingsNamespace;
try {
  settingsNamespace = (await import('@deepseek-ai/dsh-settings')).settingsNamespace;
} catch {
  settingsNamespace = null;
}

let z;
try {
  z = (await import('@deepseek-ai/schemastery')).default;
} catch {
  z = null;
}

/** The settings namespace this plugin owns. */
export const SETTINGS_NAMESPACE = 'websearch-dsh';

/**
 * Register the plugin's `websearch-dsh` settings namespace and return a
 * live handle, or null when the composition lacks the settings service.
 *
 * @param {object} ctx cordis plugin context.
 * @returns {null | {enabled: () => boolean, dispose: () => void}}
 *   `enabled()` is a cached read of the resolved section (base `enabled:
 *   true`, user-layer override), refreshed synchronously by the
 *   registration's watch callback, so callers never await it.
 */
export function registerWebSearchSettings(ctx) {
  const settings = ctx.get?.('settings');
  if (!settings || typeof settings.register !== 'function' || !z) return null;

  let reg;
  try {
    const ns = settingsNamespace
      ? settingsNamespace(SETTINGS_NAMESPACE)
      : SETTINGS_NAMESPACE;
    reg = settings.register(
      ns,
      z.object({ enabled: z.boolean() }),
      { base: { enabled: true } },
    );
  } catch {
    // Namespace already registered (double activation) or a schema the
    // service refuses — degrade to "no toggle, search enabled".
    return null;
  }

  let enabled = true;
  const refresh = () => {
    const value = reg.get();
    enabled = value?.enabled !== false; // absent/odd values stay enabled
  };
  refresh();
  const off = reg.watch(() => refresh());

  return {
    enabled: () => enabled,
    dispose: () => off(),
  };
}
