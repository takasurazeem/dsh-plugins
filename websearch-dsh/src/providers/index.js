// The provider registry. Adding a new keyed provider is: write a module
// shaped like the others (id, label, envKey, search(query, opts) →
// {sources}), export it here, and add its id to DEFAULT_PRIORITY in
// src/config.js (and its default env-var name to DEFAULT_ENV_KEYS).
// DuckDuckGo is intentionally not in the priority list — it is the
// keyless last-resort leg, always appended last by the chain.

import { tavily } from './tavily.js';
import { exa } from './exa.js';
import { firecrawl } from './firecrawl.js';
import { brave } from './brave.js';
import { serper } from './serper.js';
import { duckduckgo } from './duckduckgo.js';

export const API_PROVIDERS = [tavily, exa, firecrawl, brave, serper];
export { tavily, exa, firecrawl, brave, serper, duckduckgo };
export const DUCKDUCKGO = duckduckgo;
export const ALL_PROVIDERS = [...API_PROVIDERS, duckduckgo];
export const PROVIDERS_BY_ID = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));
