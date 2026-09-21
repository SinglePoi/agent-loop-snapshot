import { createHash } from 'node:crypto';

import type { OtelExportConfig } from './index.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Returns the normalized resolved receiver URL only for hashing in memory.
 * Callers must persist the resulting digest, never this potentially sensitive
 * URL (for example, its query can contain a receiver routing token).
 */
function resolvedEndpoint(
  config: OtelExportConfig,
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = config.endpoint ?? environment[config.endpointEnv ?? ''];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

/**
 * Hashes the actual configured destination and delivery semantics without
 * exposing a URL, header value, or credential in a queue entry or report.
 */
export function createOtelExportConfigFingerprint(
  config: OtelExportConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const endpoint =
    resolvedEndpoint(config, environment) ?? `unresolved:${config.endpointEnv ?? ''}`;
  const headersEnv = Object.fromEntries(
    Object.entries(config.headersEnv ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const identity = {
    targetAlias: config.targetAlias,
    destinationIdentity: config.destinationIdentity ?? config.targetAlias,
    destinationGeneration: config.destinationGeneration ?? 'legacy-1',
    endpoint,
    headersEnv,
    serviceName: config.serviceName,
    contentPolicy: config.contentPolicy ?? 'metadata-only',
    mappingVersion: 'otlp-json-mapping-2',
    encoding: 'otlp-http-json',
  };
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}
