// Per-search API-key resolution, mirroring the harness's own DeepSeek
// search provider:
//
//   1. the credentials seam (`ctx.credentials.resolve(ref)`) — refs written
//      by the web Credentials screen, exactly how GMAIL_OAUTH_* and
//      DEEPSEEK_API_KEY resolve there;
//   2. the process environment of the `dsh web` process.
//
// Resolved once per operation (per search call, per provider) so a key
// added or rotated in the store reaches the next search without a plugin
// restart, and so a wrong ref name (outside the grammar) reads as
// "not set" instead of throwing — the seam's own doctrine.

let dshCredentials = null;
try {
  dshCredentials = await import('@deepseek-ai/dsh-credentials');
} catch {
  // Bare checkout outside a dsh profile — the env path still works.
}

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolve one provider's key.
 *
 * @param {object} [ctx] cordis context (the credentials seam is optional;
 *   absent → env only).
 * @param {string} envKey the credential-ref / env-var name (e.g. TAVILY_API_KEY).
 * @param {object} [env] the environment to read (process.env by default;
 *   injectable for tests).
 * @returns {Promise<string>} the key, or '' when not configured anywhere.
 */
export async function resolveApiKey(ctx, envKey, env = process.env) {
  if (envKey && REF_PATTERN.test(String(envKey))) {
    const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : ctx?.credentials;
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const ref = dshCredentials ? dshCredentials.credentialRef(envKey) : envKey;
        const rec = await credentials.resolve(ref);
        const v = rec?.value;
        if (typeof v === 'string' && v.trim()) return v.trim();
      } catch {
        // malformed ref or transient seam error — fall through to env.
      }
    }
  }
  const v = env ? env[envKey] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}
