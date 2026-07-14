// Pure registry — no imports from platform adapters.
// Connectors are registered by the composition root (cli.ts, index.ts).
import { PlatformConnector } from './types.js';

const registry = new Map<string, PlatformConnector>();

export function registerConnector(connector: PlatformConnector) {
  registry.set(connector.platform, connector);
}

export function getConnector(platform: string): PlatformConnector {
  const c = registry.get(platform);
  if (!c) throw new Error(`Unknown platform: ${platform}. Available: ${[...registry.keys()].join(', ')}`);
  return c;
}
