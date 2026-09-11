import { createHash } from 'node:crypto';

import {
  snapshotSchemaVersion,
  type EventEnvelope,
  type JsonObject,
  type JsonValue,
  type OtelSpanPayload,
  type SnapshotCompleteness,
  type SnapshotLimitation,
  type SnapshotManifest,
} from '@agent-loop-snapshot/schema';

/** The fixed profile understood by this package. It deliberately has a narrow scope. */
export const otelGenAiProfileVersion = 'otel-genai-1.0' as const;

export type OtelImportProfile = 'generic' | typeof otelGenAiProfileVersion;

export interface OtelImportLimits {
  readonly maxTraces?: number;
  readonly maxSpans?: number;
  readonly maxAttributesPerItem?: number;
  readonly maxAttributeValueLength?: number;
  readonly maxValueDepth?: number;
  readonly maxEventsPerSpan?: number;
  readonly maxLinksPerSpan?: number;
}

export const defaultOtelImportLimits: Required<OtelImportLimits> = {
  maxTraces: 100,
  maxSpans: 10_000,
  maxAttributesPerItem: 128,
  maxAttributeValueLength: 16_384,
  maxValueDepth: 16,
  maxEventsPerSpan: 128,
  maxLinksPerSpan: 128,
};

export interface OtelImportOptions {
  /** The generic profile always applies; this opts into the fixed GenAI attribute profile. */
  readonly profile?: OtelImportProfile;
  readonly limits?: OtelImportLimits;
}

export type OtelImportDiagnosticCode =
  | 'INVALID_REQUEST'
  | 'INVALID_RESOURCE_SPANS'
  | 'INVALID_SCOPE_SPANS'
  | 'INVALID_SPAN'
  | 'INVALID_TRACE_ID'
  | 'INVALID_SPAN_ID'
  | 'INVALID_TIMESTAMP'
  | 'NEGATIVE_DURATION'
  | 'MISSING_PARENT'
  | 'SELF_PARENT'
  | 'PARENT_CYCLE'
  | 'DUPLICATE_SPAN'
  | 'CONFLICTING_SPAN'
  | 'TRACE_LIMIT_EXCEEDED'
  | 'SPAN_LIMIT_EXCEEDED'
  | 'ATTRIBUTE_LIMIT_EXCEEDED'
  | 'VALUE_LIMIT_EXCEEDED'
  | 'DROPPED_SOURCE_DATA';

export interface OtelImportDiagnostic {
  readonly code: OtelImportDiagnosticCode;
  readonly message: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly path?: string;
}

export interface OtelImportReport {
  readonly importedSpanCount: number;
  readonly rejectedSpanCount: number;
  readonly duplicateSpanCount: number;
  readonly truncatedValueCount: number;
  readonly traceCount: number;
  readonly diagnostics: readonly OtelImportDiagnostic[];
}

export interface ImportedOtelSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano?: string;
  readonly status: 'ok' | 'error' | 'unset';
  readonly statusMessage?: string;
  readonly kind?: string;
  readonly resource: JsonObject;
  readonly scope: JsonObject;
  readonly attributes: JsonObject;
  readonly events: readonly JsonValue[];
  readonly links: readonly JsonValue[];
  /** Classification is descriptive only. It never proves tool execution. */
  readonly semantic: 'generic' | 'gen_ai_model' | 'gen_ai_tool';
}

export interface ImportedOtelTrace {
  readonly traceId: string;
  readonly spans: readonly ImportedOtelSpan[];
  readonly completeness: SnapshotCompleteness;
  readonly limitations: readonly SnapshotLimitation[];
  readonly diagnostics: readonly OtelImportDiagnostic[];
}

export interface OtelImportResult {
  readonly traces: readonly ImportedOtelTrace[];
  readonly report: OtelImportReport;
}

export interface ImportedObservationSnapshot {
  readonly manifest: SnapshotManifest;
  readonly events: readonly EventEnvelope<string, unknown>[];
}

type UnknownRecord = Record<string, unknown>;

interface CollectedSpan extends ImportedOtelSpan {
  readonly sourcePath: string;
  readonly fingerprint: string;
  parentPresent: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Avoid invoking accessors when callers pass a non-JSON object by mistake. */
function ownValue(record: UnknownRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}

function resolvedLimits(input: OtelImportLimits | undefined): Required<OtelImportLimits> {
  return {
    maxTraces: positiveLimit(input?.maxTraces, defaultOtelImportLimits.maxTraces),
    maxSpans: positiveLimit(input?.maxSpans, defaultOtelImportLimits.maxSpans),
    maxAttributesPerItem: positiveLimit(
      input?.maxAttributesPerItem,
      defaultOtelImportLimits.maxAttributesPerItem,
    ),
    maxAttributeValueLength: positiveLimit(
      input?.maxAttributeValueLength,
      defaultOtelImportLimits.maxAttributeValueLength,
    ),
    maxValueDepth: positiveLimit(input?.maxValueDepth, defaultOtelImportLimits.maxValueDepth),
    maxEventsPerSpan: positiveLimit(
      input?.maxEventsPerSpan,
      defaultOtelImportLimits.maxEventsPerSpan,
    ),
    maxLinksPerSpan: positiveLimit(input?.maxLinksPerSpan, defaultOtelImportLimits.maxLinksPerSpan),
  };
}

function isValidId(value: string, length: number): boolean {
  return new RegExp(`^[0-9a-f]{${String(length)}}$`, 'i').test(value) && !/^0+$/u.test(value);
}

function asNano(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as UnknownRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(ownValue(record, key))}`)
    .join(',')}}`;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function runId(traceId: string): `run_${string}` {
  return `run_${deterministicUuid(`otlp-run:${traceId}`)}`;
}

function eventId(traceId: string, source: string): `evt_${string}` {
  return `evt_${deterministicUuid(`otlp-event:${traceId}:${source}`)}`;
}

function truncate(value: string, limits: Required<OtelImportLimits>, state: ParseState): string {
  if (value.length <= limits.maxAttributeValueLength) return value;
  state.truncatedValueCount += 1;
  state.diagnostics.push({
    code: 'VALUE_LIMIT_EXCEEDED',
    message: `A string value was truncated to ${String(limits.maxAttributeValueLength)} characters.`,
  });
  return value.slice(0, limits.maxAttributeValueLength);
}

interface ParseState {
  readonly limits: Required<OtelImportLimits>;
  readonly profile: OtelImportProfile;
  readonly diagnostics: OtelImportDiagnostic[];
  truncatedValueCount: number;
  rejectedSpanCount: number;
  duplicateSpanCount: number;
}

function parseAnyValue(value: unknown, state: ParseState, depth = 0): JsonValue {
  if (!isRecord(value) || depth >= state.limits.maxValueDepth) {
    if (depth >= state.limits.maxValueDepth) {
      state.truncatedValueCount += 1;
      state.diagnostics.push({
        code: 'VALUE_LIMIT_EXCEEDED',
        message: `An attribute value exceeded nesting depth ${String(state.limits.maxValueDepth)}.`,
      });
    }
    return null;
  }
  const stringValue = ownValue(value, 'stringValue');
  if (typeof stringValue === 'string') return truncate(stringValue, state.limits, state);
  const boolValue = ownValue(value, 'boolValue');
  if (typeof boolValue === 'boolean') return boolValue;
  const intValue = ownValue(value, 'intValue');
  if (typeof intValue === 'string' || typeof intValue === 'number') return String(intValue);
  const doubleValue = ownValue(value, 'doubleValue');
  if (typeof doubleValue === 'number' && Number.isFinite(doubleValue)) return doubleValue;
  const bytesValue = ownValue(value, 'bytesValue');
  if (typeof bytesValue === 'string') return truncate(bytesValue, state.limits, state);
  const arrayValue = ownValue(value, 'arrayValue');
  if (isRecord(arrayValue)) {
    return (asArray(ownValue(arrayValue, 'values')) ?? []).map((item) =>
      parseAnyValue(item, state, depth + 1),
    );
  }
  const kvlistValue = ownValue(value, 'kvlistValue');
  if (isRecord(kvlistValue))
    return parseAttributes(ownValue(kvlistValue, 'values'), state, depth + 1);
  return null;
}

function parseAttributes(value: unknown, state: ParseState, depth = 0): JsonObject {
  const attributes: JsonObject = {};
  const items = asArray(value) ?? [];
  for (const [index, item] of items.entries()) {
    if (index >= state.limits.maxAttributesPerItem) {
      state.truncatedValueCount += 1;
      state.diagnostics.push({
        code: 'ATTRIBUTE_LIMIT_EXCEEDED',
        message: `Attributes were truncated after ${String(state.limits.maxAttributesPerItem)} entries.`,
      });
      break;
    }
    if (!isRecord(item)) continue;
    const key = nonEmptyText(ownValue(item, 'key'));
    if (key === undefined) continue;
    attributes[truncate(key, state.limits, state)] = parseAnyValue(
      ownValue(item, 'value'),
      state,
      depth,
    );
  }
  return attributes;
}

function parseEntity(value: unknown, state: ParseState, scope = false): JsonObject {
  const record = isRecord(value) ? value : {};
  const attributes = parseAttributes(ownValue(record, 'attributes'), state);
  const result: JsonObject = { attributes };
  for (const key of scope ? ['name', 'version', 'schemaUrl'] : ['schemaUrl']) {
    const entry = nonEmptyText(ownValue(record, key));
    if (entry !== undefined) result[key] = truncate(entry, state.limits, state);
  }
  const dropped = ownValue(record, 'droppedAttributesCount');
  if (typeof dropped === 'number' && dropped > 0) result.dropped_attributes_count = dropped;
  return result;
}

function statusFor(value: unknown): { status: ImportedOtelSpan['status']; message?: string } {
  if (!isRecord(value)) return { status: 'unset' };
  const code = ownValue(value, 'code');
  const status = code === 2 ? 'ok' : code === 3 ? 'error' : 'unset';
  const message = nonEmptyText(ownValue(value, 'message'));
  return { status, ...(message === undefined ? {} : { message }) };
}

function kindFor(value: unknown): string | undefined {
  if (typeof value !== 'number') return undefined;
  return (
    ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'][value] ??
    `unknown:${String(value)}`
  );
}

function parseEvents(value: unknown, state: ParseState): JsonValue[] {
  const events: JsonValue[] = [];
  for (const [index, item] of (asArray(value) ?? []).entries()) {
    if (index >= state.limits.maxEventsPerSpan) {
      state.truncatedValueCount += 1;
      break;
    }
    if (!isRecord(item)) continue;
    const name = text(ownValue(item, 'name'), 'unnamed');
    const event: JsonObject = {
      name: truncate(name, state.limits, state),
      attributes: parseAttributes(ownValue(item, 'attributes'), state),
    };
    const timestamp = asNano(ownValue(item, 'timeUnixNano'));
    if (timestamp !== undefined) event.time_unix_nano = timestamp;
    const dropped = ownValue(item, 'droppedAttributesCount');
    if (typeof dropped === 'number' && dropped > 0) event.dropped_attributes_count = dropped;
    events.push(event);
  }
  return events;
}

function parseLinks(value: unknown, state: ParseState): JsonValue[] {
  const links: JsonValue[] = [];
  for (const [index, item] of (asArray(value) ?? []).entries()) {
    if (index >= state.limits.maxLinksPerSpan) {
      state.truncatedValueCount += 1;
      break;
    }
    if (!isRecord(item)) continue;
    const traceId = text(ownValue(item, 'traceId')).toLowerCase();
    const spanId = text(ownValue(item, 'spanId')).toLowerCase();
    if (!isValidId(traceId, 32) || !isValidId(spanId, 16)) continue;
    const link: JsonObject = {
      trace_id: traceId,
      span_id: spanId,
      attributes: parseAttributes(ownValue(item, 'attributes'), state),
    };
    const flags = ownValue(item, 'flags');
    if (typeof flags === 'number') link.flags = flags;
    links.push(link);
  }
  return links;
}

function classify(
  attributes: JsonObject,
  profile: OtelImportProfile,
): ImportedOtelSpan['semantic'] {
  if (profile !== otelGenAiProfileVersion) return 'generic';
  const operation = attributes['gen_ai.operation.name'];
  if (operation === 'execute_tool') return 'gen_ai_tool';
  if (
    operation === 'chat' ||
    operation === 'generate_content' ||
    operation === 'text_completion' ||
    operation === 'embeddings'
  ) {
    return 'gen_ai_model';
  }
  return 'generic';
}

function wasDropped(record: UnknownRecord): boolean {
  return ['droppedAttributesCount', 'droppedEventsCount', 'droppedLinksCount'].some(
    (key) => typeof ownValue(record, key) === 'number' && (ownValue(record, key) as number) > 0,
  );
}

function collectSpan(
  raw: unknown,
  resource: JsonObject,
  scope: JsonObject,
  sourcePath: string,
  state: ParseState,
): CollectedSpan | undefined {
  if (!isRecord(raw)) {
    state.rejectedSpanCount += 1;
    state.diagnostics.push({
      code: 'INVALID_SPAN',
      message: 'A span is not an object.',
      path: sourcePath,
    });
    return undefined;
  }
  const traceId = text(ownValue(raw, 'traceId')).toLowerCase();
  const spanId = text(ownValue(raw, 'spanId')).toLowerCase();
  if (!isValidId(traceId, 32)) {
    state.rejectedSpanCount += 1;
    state.diagnostics.push({
      code: 'INVALID_TRACE_ID',
      message: 'A span has an invalid traceId.',
      path: sourcePath,
    });
    return undefined;
  }
  if (!isValidId(spanId, 16)) {
    state.rejectedSpanCount += 1;
    state.diagnostics.push({
      code: 'INVALID_SPAN_ID',
      message: 'A span has an invalid spanId.',
      traceId,
      path: sourcePath,
    });
    return undefined;
  }
  const start = asNano(ownValue(raw, 'startTimeUnixNano'));
  if (start === undefined) {
    state.rejectedSpanCount += 1;
    state.diagnostics.push({
      code: 'INVALID_TIMESTAMP',
      message: 'A span has no valid startTimeUnixNano.',
      traceId,
      spanId,
    });
    return undefined;
  }
  const end = asNano(ownValue(raw, 'endTimeUnixNano'));
  if (end !== undefined && BigInt(end) < BigInt(start)) {
    state.rejectedSpanCount += 1;
    state.diagnostics.push({
      code: 'NEGATIVE_DURATION',
      message: 'A span ends before it starts.',
      traceId,
      spanId,
    });
    return undefined;
  }
  const parentRaw = text(ownValue(raw, 'parentSpanId')).toLowerCase();
  const parentPresent = parentRaw !== '';
  const parentSpanId = isValidId(parentRaw, 16) ? parentRaw : undefined;
  const attributes = parseAttributes(ownValue(raw, 'attributes'), state);
  const status = statusFor(ownValue(raw, 'status'));
  const kind = kindFor(ownValue(raw, 'kind'));
  const span: CollectedSpan = {
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name: truncate(text(ownValue(raw, 'name'), 'unnamed'), state.limits, state),
    startTimeUnixNano: start,
    ...(end === undefined ? {} : { endTimeUnixNano: end }),
    status: status.status,
    ...(status.message === undefined
      ? {}
      : { statusMessage: truncate(status.message, state.limits, state) }),
    ...(kind === undefined ? {} : { kind }),
    resource,
    scope,
    attributes,
    events: parseEvents(ownValue(raw, 'events'), state),
    links: parseLinks(ownValue(raw, 'links'), state),
    semantic: classify(attributes, state.profile),
    sourcePath,
    fingerprint: stableJson(raw),
    parentPresent,
  };
  if (wasDropped(raw)) {
    state.diagnostics.push({
      code: 'DROPPED_SOURCE_DATA',
      message: 'A span reports dropped source telemetry.',
      traceId,
      spanId,
    });
  }
  return span;
}

function limitation(
  code: SnapshotLimitation['code'],
  message: string,
  current: SnapshotLimitation[],
): void {
  if (!current.some((entry) => entry.code === code)) current.push({ code, message });
}

function traceRelatedDiagnostics(
  all: readonly OtelImportDiagnostic[],
  traceId: string,
): OtelImportDiagnostic[] {
  return all.filter(
    (diagnostic) => diagnostic.traceId === traceId || diagnostic.traceId === undefined,
  );
}

function spanOrder(left: CollectedSpan, right: CollectedSpan): number {
  const start = BigInt(left.startTimeUnixNano) - BigInt(right.startTimeUnixNano);
  if (start !== 0n) return start < 0n ? -1 : 1;
  return left.spanId.localeCompare(right.spanId);
}

function normalizeTrace(
  traceId: string,
  rawSpans: readonly CollectedSpan[],
  state: ParseState,
): ImportedOtelTrace {
  const limitations: SnapshotLimitation[] = [];
  const byId = new Map<string, CollectedSpan>();
  for (const span of rawSpans) {
    const existing = byId.get(span.spanId);
    if (existing === undefined) {
      byId.set(span.spanId, span);
    } else if (existing.fingerprint === span.fingerprint) {
      state.duplicateSpanCount += 1;
      state.diagnostics.push({
        code: 'DUPLICATE_SPAN',
        message: 'An identical source span was deduplicated.',
        traceId,
        spanId: span.spanId,
      });
    } else {
      state.rejectedSpanCount += 1;
      byId.delete(span.spanId);
      state.diagnostics.push({
        code: 'CONFLICTING_SPAN',
        message: 'Conflicting source spans share an ID and were isolated.',
        traceId,
        spanId: span.spanId,
      });
      limitation('invalid_source_data', 'Conflicting source span IDs were isolated.', limitations);
    }
  }
  const spans = [...byId.values()];
  const parents = new Map<string, string | undefined>();
  let naturalRoots = 0;
  for (const span of spans) {
    if (!span.parentPresent) naturalRoots += 1;
    if (span.parentPresent && span.parentSpanId === undefined) {
      state.diagnostics.push({
        code: 'MISSING_PARENT',
        message: 'A span has an invalid parentSpanId.',
        traceId,
        spanId: span.spanId,
      });
      limitation('missing_parent', 'At least one span has an invalid parent.', limitations);
      parents.set(span.spanId, undefined);
    } else if (span.parentSpanId === span.spanId) {
      state.diagnostics.push({
        code: 'SELF_PARENT',
        message: 'A span cannot parent itself.',
        traceId,
        spanId: span.spanId,
      });
      limitation('invalid_source_data', 'A self-parent span was detached.', limitations);
      parents.set(span.spanId, undefined);
    } else if (span.parentSpanId !== undefined && !byId.has(span.parentSpanId)) {
      state.diagnostics.push({
        code: 'MISSING_PARENT',
        message: 'A span parent is absent from this trace.',
        traceId,
        spanId: span.spanId,
      });
      limitation(
        'missing_parent',
        'At least one span parent is absent from the imported trace.',
        limitations,
      );
      parents.set(span.spanId, undefined);
    } else {
      parents.set(span.spanId, span.parentSpanId);
    }
  }
  if (spans.length > 0 && naturalRoots === 0) {
    limitation('missing_root', 'The source trace does not contain a root span.', limitations);
  }
  for (const span of spans) {
    const seen = new Map<string, number>();
    const chain: string[] = [];
    let current: string | undefined = span.spanId;
    while (current !== undefined && !seen.has(current)) {
      seen.set(current, chain.length);
      chain.push(current);
      current = parents.get(current);
    }
    if (current !== undefined) {
      const cycle = chain.slice(seen.get(current)!);
      const detached = [...cycle].sort().at(-1)!;
      parents.set(detached, undefined);
      state.diagnostics.push({
        code: 'PARENT_CYCLE',
        message: `A parent cycle was broken at span ${detached}.`,
        traceId,
        spanId: detached,
      });
      limitation('invalid_source_data', 'A cyclic parent relationship was detached.', limitations);
    }
  }
  const children = new Map<string, CollectedSpan[]>();
  const roots: CollectedSpan[] = [];
  for (const span of spans) {
    const parent = parents.get(span.spanId);
    if (parent === undefined) roots.push(span);
    else {
      const list = children.get(parent) ?? [];
      list.push(span);
      children.set(parent, list);
    }
  }
  roots.sort(spanOrder);
  children.forEach((value) => value.sort(spanOrder));
  const ordered: CollectedSpan[] = [];
  const visit = (span: CollectedSpan): void => {
    const normalized = { ...span };
    delete normalized.parentSpanId;
    const normalizedParent = parents.get(span.spanId);
    if (normalizedParent !== undefined) normalized.parentSpanId = normalizedParent;
    ordered.push(normalized);
    children.get(span.spanId)?.forEach(visit);
  };
  roots.forEach(visit);
  if (ordered.length !== spans.length) {
    // This is defensive after cycle removal; do not silently lose a disconnected item.
    spans
      .filter((span) => !ordered.some((item) => item.spanId === span.spanId))
      .sort(spanOrder)
      .forEach(visit);
  }
  const traceDiagnostics = traceRelatedDiagnostics(state.diagnostics, traceId);
  if (traceDiagnostics.some((item) => item.code === 'DROPPED_SOURCE_DATA')) {
    limitation('sampled_or_dropped', 'The source reported dropped telemetry.', limitations);
  }
  if (state.truncatedValueCount > 0)
    limitation('payload_truncated', 'Import limits truncated source values.', limitations);
  if (ordered.some((span) => span.semantic === 'gen_ai_tool')) {
    limitation(
      'unknown_side_effect',
      'A GenAI tool span does not prove a tool was executed.',
      limitations,
    );
  }
  const completeness: SnapshotCompleteness = limitations.length === 0 ? 'unknown' : 'partial';
  return { traceId, spans: ordered, completeness, limitations, diagnostics: traceDiagnostics };
}

/**
 * Parses an already-decoded OTLP/HTTP JSON ExportTraceServiceRequest.
 * It neither follows URLs nor writes files, so callers can apply their own
 * redaction policy before CAP-07 persists the resulting observation snapshot.
 */
export function importOtlpTraces(
  input: unknown,
  options: OtelImportOptions = {},
): OtelImportResult {
  const state: ParseState = {
    limits: resolvedLimits(options.limits),
    profile: options.profile ?? 'generic',
    diagnostics: [],
    truncatedValueCount: 0,
    rejectedSpanCount: 0,
    duplicateSpanCount: 0,
  };
  if (!isRecord(input)) {
    state.diagnostics.push({ code: 'INVALID_REQUEST', message: 'OTLP request must be an object.' });
    return {
      traces: [],
      report: {
        importedSpanCount: 0,
        rejectedSpanCount: 0,
        duplicateSpanCount: 0,
        truncatedValueCount: 0,
        traceCount: 0,
        diagnostics: state.diagnostics,
      },
    };
  }
  const collected = new Map<string, CollectedSpan[]>();
  let acceptedSpans = 0;
  for (const [resourceIndex, resourceSpans] of (
    asArray(ownValue(input, 'resourceSpans')) ?? []
  ).entries()) {
    if (!isRecord(resourceSpans)) {
      state.diagnostics.push({
        code: 'INVALID_RESOURCE_SPANS',
        message: 'A resourceSpans item is not an object.',
        path: `/resourceSpans/${String(resourceIndex)}`,
      });
      continue;
    }
    const resource = parseEntity(ownValue(resourceSpans, 'resource'), state);
    for (const [scopeIndex, scopeSpans] of (
      asArray(ownValue(resourceSpans, 'scopeSpans')) ?? []
    ).entries()) {
      if (!isRecord(scopeSpans)) {
        state.diagnostics.push({
          code: 'INVALID_SCOPE_SPANS',
          message: 'A scopeSpans item is not an object.',
          path: `/resourceSpans/${String(resourceIndex)}/scopeSpans/${String(scopeIndex)}`,
        });
        continue;
      }
      const scope = parseEntity(ownValue(scopeSpans, 'scope'), state, true);
      for (const [spanIndex, rawSpan] of (asArray(ownValue(scopeSpans, 'spans')) ?? []).entries()) {
        if (acceptedSpans >= state.limits.maxSpans) {
          state.rejectedSpanCount += 1;
          state.diagnostics.push({
            code: 'SPAN_LIMIT_EXCEEDED',
            message: `The import limit of ${String(state.limits.maxSpans)} spans was reached.`,
          });
          continue;
        }
        const span = collectSpan(
          rawSpan,
          resource,
          scope,
          `/resourceSpans/${String(resourceIndex)}/scopeSpans/${String(scopeIndex)}/spans/${String(spanIndex)}`,
          state,
        );
        if (span === undefined) continue;
        if (!collected.has(span.traceId) && collected.size >= state.limits.maxTraces) {
          state.rejectedSpanCount += 1;
          state.diagnostics.push({
            code: 'TRACE_LIMIT_EXCEEDED',
            message: `The import limit of ${String(state.limits.maxTraces)} traces was reached.`,
            traceId: span.traceId,
          });
          continue;
        }
        const spans = collected.get(span.traceId) ?? [];
        spans.push(span);
        collected.set(span.traceId, spans);
        acceptedSpans += 1;
      }
    }
  }
  const traces = [...collected.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([traceId, spans]) => normalizeTrace(traceId, spans, state));
  const importedSpanCount = traces.reduce((count, trace) => count + trace.spans.length, 0);
  return {
    traces,
    report: {
      importedSpanCount,
      rejectedSpanCount: state.rejectedSpanCount,
      duplicateSpanCount: state.duplicateSpanCount,
      truncatedValueCount: state.truncatedValueCount,
      traceCount: traces.length,
      diagnostics: state.diagnostics,
    },
  };
}

function isoFromNanos(value: string): string {
  const milliseconds = BigInt(value) / 1_000_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return new Date(0).toISOString();
  const date = new Date(Number(milliseconds));
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function offsetMs(value: string, first: string): number {
  const offset = (BigInt(value) - BigInt(first)) / 1_000_000n;
  return offset > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Number(offset < 0n ? 0n : offset);
}

/**
 * Converts one normalized trace into the versioned, observation-only snapshot
 * documents that CAP-07 will persist. No current-time Recorder is involved.
 */
export function toObservationSnapshot(trace: ImportedOtelTrace): ImportedObservationSnapshot {
  const id = runId(trace.traceId);
  const firstNanos =
    trace.spans.reduce<string | undefined>(
      (earliest, span) =>
        earliest === undefined || BigInt(span.startTimeUnixNano) < BigInt(earliest)
          ? span.startTimeUnixNano
          : earliest,
      undefined,
    ) ?? '0';
  const lastNanos = trace.spans.reduce((latest, span) => {
    const candidate = span.endTimeUnixNano ?? span.startTimeUnixNano;
    return BigInt(candidate) > BigInt(latest) ? candidate : latest;
  }, firstNanos);
  const rootEventId = eventId(trace.traceId, 'run.started');
  const spanEventIds = new Map(
    trace.spans.map((span) => [span.spanId, eventId(trace.traceId, span.spanId)]),
  );
  const events: EventEnvelope<string, unknown>[] = [
    {
      schema_version: snapshotSchemaVersion,
      run_id: id,
      event_id: rootEventId,
      parent_ids: [],
      sequence: 1,
      timestamp: isoFromNanos(firstNanos),
      monotonic_offset_ms: 0,
      type: 'run.started',
      actor: 'otel.import',
      payload: {
        runtime: {
          name: 'opentelemetry',
          version: 'otlp-json',
          adapter: '@agent-loop-snapshot/otel-import',
        },
      },
      security: { side_effect: 'read_only', redactions: [] },
    },
  ];
  trace.spans.forEach((span, index) => {
    const payload: OtelSpanPayload = {
      trace_id: span.traceId,
      span_id: span.spanId,
      name: span.name,
      status: span.status,
      start_time_unix_nano: span.startTimeUnixNano,
      ...(span.endTimeUnixNano === undefined ? {} : { end_time_unix_nano: span.endTimeUnixNano }),
      ...(span.parentSpanId === undefined ? {} : { parent_span_id: span.parentSpanId }),
      ...(span.statusMessage === undefined ? {} : { status_message: span.statusMessage }),
      ...(span.kind === undefined ? {} : { kind: span.kind }),
      resource: span.resource,
      scope: span.scope,
      attributes: span.attributes,
      events: [...span.events],
      links: [...span.links],
      semantic: span.semantic,
    };
    events.push({
      schema_version: snapshotSchemaVersion,
      run_id: id,
      event_id: spanEventIds.get(span.spanId)!,
      parent_ids: [
        span.parentSpanId === undefined ? rootEventId : spanEventIds.get(span.parentSpanId)!,
      ],
      sequence: index + 2,
      timestamp: isoFromNanos(span.startTimeUnixNano),
      monotonic_offset_ms: offsetMs(span.startTimeUnixNano, firstNanos),
      type: 'otel.span',
      actor: 'otel.import',
      payload,
      security: { side_effect: 'read_only', redactions: [] },
    });
  });
  events.push({
    schema_version: snapshotSchemaVersion,
    run_id: id,
    event_id: eventId(trace.traceId, 'run.observed'),
    parent_ids:
      trace.spans.length === 0 ? [rootEventId] : [spanEventIds.get(trace.spans.at(-1)!.spanId)!],
    sequence: events.length + 1,
    timestamp: isoFromNanos(lastNanos),
    monotonic_offset_ms: offsetMs(lastNanos, firstNanos),
    type: 'run.observed',
    actor: 'otel.import',
    payload: { outcome: 'unknown', summary: 'OTLP trace imported as observation-only evidence.' },
    security: { side_effect: 'read_only', redactions: [] },
  });
  return {
    manifest: {
      schema_version: snapshotSchemaVersion,
      snapshot_type: 'run-snapshot',
      run_id: id,
      created_at: isoFromNanos(firstNanos),
      updated_at: isoFromNanos(lastNanos),
      run_state: 'finished',
      terminal_status: 'unknown',
      runtime: {
        name: 'opentelemetry',
        version: 'otlp-json',
        adapter: '@agent-loop-snapshot/otel-import',
      },
      source: 'otel-import',
      completeness: trace.completeness,
      limitations: [...trace.limitations],
      last_sequence: events.length,
      event_count: events.length,
      root_event_id: rootEventId,
      completed_at: isoFromNanos(lastNanos),
    },
    events,
  };
}
