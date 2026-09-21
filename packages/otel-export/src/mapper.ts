import { createHash } from 'node:crypto';

import type {
  EventEnvelope,
  JsonObject,
  JsonValue,
  SnapshotCompleteness,
  SnapshotLimitation,
  SnapshotSource,
} from '@agent-loop-snapshot/schema';

import {
  defaultOtelExportMappingLimits,
  otelExportContractVersion,
  type ExportContentPolicy,
  type ExportDeliveryReport,
  type ExportMappingLoss,
  type ExportMappingReport,
  type ExportSnapshotInput,
  type ExportSpan,
  type OtlpAnyValue,
  type OtlpExportTraceServiceRequest,
  type OtlpKeyValue,
  type OtlpResourceSpans,
  type OtlpSpanEvent,
  type OtlpTraceSpan,
  type OtelExportDryRun,
  type OtelExportMappingLimits,
  type OtelExportMappingOptions,
  type OtelExportMappingResult,
  type OutboundRedactionPipeline,
} from './index.js';

type UnknownRecord = Record<string, unknown>;
type CallPayload = UnknownRecord & { readonly correlation_key: string };

interface CallStart {
  readonly event: EventEnvelope<string, unknown>;
  readonly kind: 'model' | 'tool';
  readonly correlationKey: string;
  readonly name: string;
}

interface CallFinish {
  readonly event: EventEnvelope<string, unknown>;
  readonly failed: boolean;
}

type CallKind = CallStart['kind'];

interface MapState {
  readonly source: SnapshotSource;
  readonly completeness: SnapshotCompleteness;
  readonly limitations: readonly SnapshotLimitation[];
  readonly policy: ExportContentPolicy;
  readonly redaction: OutboundRedactionPipeline;
  readonly limits: OtelExportMappingLimits;
  readonly losses: ExportMappingLoss[];
  droppedFieldCount: number;
}

const secretKey = /(?:api[_-]?key|authorization|password|secret|token)/iu;
const correlationKey = /^correlation[_-]?key$/iu;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}

function mappingLimits(
  overrides: Partial<OtelExportMappingLimits> | undefined,
): OtelExportMappingLimits {
  return {
    maxStringBytes: normalizedLimit(
      overrides?.maxStringBytes,
      defaultOtelExportMappingLimits.maxStringBytes,
    ),
    maxCollectionItems: normalizedLimit(
      overrides?.maxCollectionItems,
      defaultOtelExportMappingLimits.maxCollectionItems,
    ),
    maxContentDepth: normalizedLimit(
      overrides?.maxContentDepth,
      defaultOtelExportMappingLimits.maxContentDepth,
    ),
    maxSpans: normalizedLimit(overrides?.maxSpans, defaultOtelExportMappingLimits.maxSpans),
    maxAttributesPerSpan: normalizedLimit(
      overrides?.maxAttributesPerSpan,
      defaultOtelExportMappingLimits.maxAttributesPerSpan,
    ),
    maxEventsPerSpan: normalizedLimit(
      overrides?.maxEventsPerSpan,
      defaultOtelExportMappingLimits.maxEventsPerSpan,
    ),
    maxLinksPerSpan: normalizedLimit(
      overrides?.maxLinksPerSpan,
      defaultOtelExportMappingLimits.maxLinksPerSpan,
    ),
    maxSpanBytes: normalizedLimit(
      overrides?.maxSpanBytes,
      defaultOtelExportMappingLimits.maxSpanBytes,
    ),
    maxRequestBytes: normalizedLimit(
      overrides?.maxRequestBytes,
      defaultOtelExportMappingLimits.maxRequestBytes,
    ),
  };
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const size = codePoint.length === 1 ? (codePoint.charCodeAt(0) < 0x80 ? 1 : 3) : 4;
    if (bytes + size > maxBytes) return { value: value.slice(0, end), truncated: true };
    bytes += size;
    end += codePoint.length;
  }
  return { value, truncated: false };
}

function dangerousKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

function boundedJsonValue(
  value: unknown,
  state: MapState,
  path: string,
  depth = 0,
  ancestors = new Set<object>(),
): JsonValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const limited = truncateUtf8(value, state.limits.maxStringBytes);
    if (limited.truncated)
      loss(state, 'value_truncated', 'A string was truncated to the outbound byte limit.');
    return limited.value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    loss(state, 'content_filtered', 'A non-finite number was omitted from outbound content.');
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    loss(state, 'content_filtered', 'A non-JSON value was omitted from outbound content.');
    return undefined;
  }
  if (depth >= state.limits.maxContentDepth || ancestors.has(value)) {
    loss(state, 'limit_exceeded', 'Nested or cyclic content was omitted by outbound limits.');
    return undefined;
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    const count = Math.min(value.length, state.limits.maxCollectionItems);
    if (value.length > count)
      loss(state, 'limit_exceeded', 'A content array exceeded the outbound item limit.');
    for (let index = 0; index < count; index += 1) {
      const item = boundedJsonValue(
        value[index],
        state,
        `${path}/${String(index)}`,
        depth + 1,
        nextAncestors,
      );
      if (item !== undefined) result.push(item);
    }
    return result;
  }
  if (!isRecord(value)) {
    loss(state, 'content_filtered', 'A non-JSON object was omitted from outbound content.');
    return undefined;
  }
  const result: JsonObject = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (dangerousKey(key)) {
      loss(state, 'metadata_filtered', 'A dangerous object key was omitted from outbound content.');
      continue;
    }
    count += 1;
    if (count > state.limits.maxCollectionItems) {
      loss(state, 'limit_exceeded', 'A content object exceeded the outbound item limit.');
      break;
    }
    const item = boundedJsonValue(value[key], state, `${path}/${key}`, depth + 1, nextAncestors);
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function stableHex(seed: string, bytes: number): string {
  const value = createHash('sha256')
    .update(seed)
    .digest('hex')
    .slice(0, bytes * 2);
  return /^0+$/u.test(value) ? `${value.slice(0, -1)}1` : value;
}

function isValidId(value: unknown, length: number): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${String(length)}}$`, 'iu').test(value) &&
    !/^0+$/u.test(value)
  );
}

function nano(timestamp: unknown): string {
  if (typeof timestamp === 'string') {
    const milliseconds = Date.parse(timestamp);
    if (Number.isFinite(milliseconds) && milliseconds >= 0)
      return String(BigInt(milliseconds) * 1_000_000n);
  }
  return '0';
}

function sourceFor(snapshot: ExportSnapshotInput): SnapshotSource {
  return snapshot.manifest.source ?? 'native';
}

function completenessFor(snapshot: ExportSnapshotInput): SnapshotCompleteness {
  return snapshot.manifest.completeness ?? 'complete';
}

function loss(state: MapState, code: ExportMappingLoss['code'], message: string, count = 1): void {
  const index = state.losses.findIndex((item) => item.code === code && item.message === message);
  if (index === -1) state.losses.push({ code, message, count });
  else {
    const existing = state.losses[index]!;
    state.losses[index] = { ...existing, count: (existing.count ?? 0) + count };
  }
}

/**
 * Conservative, synchronous out-bound redaction. It is intentionally a
 * second line of defence: callers must not rely on local snapshot redaction
 * when requesting redacted-content export.
 */
export function createDefaultOutboundRedactionPipeline(
  maxStringLength = 16_384,
): OutboundRedactionPipeline {
  const limit = Math.max(1, Math.floor(maxStringLength));
  const redact = (value: JsonValue, path: string): JsonValue => {
    if (typeof value === 'string') {
      const sanitized = value.replace(bearer, '[REDACTED:authorization]');
      return sanitized.length > limit ? `${sanitized.slice(0, limit)}[TRUNCATED]` : sanitized;
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.map((item, index) => redact(item, `${path}/${String(index)}`));
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (correlationKey.test(key)) {
        result[`${key}_hash`] = stableHex(`correlation:${String(nested)}`, 16);
      } else {
        result[key] = secretKey.test(key)
          ? '[REDACTED:secret]'
          : redact(nested, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      }
    }
    return result;
  };
  return { redact };
}

function attributes(value: JsonObject): OtlpKeyValue[] {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => ({ key, value: anyValue(item) }));
}

function anyValue(value: JsonValue): OtlpAnyValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value === null) return { stringValue: 'null' };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { kvlistValue: { values: attributes(value) } };
}

function serializeContent(value: JsonValue): string {
  return JSON.stringify(value);
}

function contentAttribute(state: MapState, key: string, value: unknown, path: string): JsonObject {
  const json = boundedJsonValue(value, state, path);
  if (json === undefined) {
    state.droppedFieldCount += 1;
    loss(state, 'content_filtered', 'A non-JSON content field was omitted.');
    return {};
  }
  if (state.policy === 'metadata-only') {
    state.droppedFieldCount += 1;
    loss(state, 'content_filtered', 'Content fields were omitted by metadata-only policy.');
    return {};
  }
  try {
    const redacted = boundedJsonValue(state.redaction.redact(json, path), state, path);
    if (redacted === undefined) {
      state.droppedFieldCount += 1;
      loss(state, 'content_filtered', 'A redaction result could not be safely exported.');
      return {};
    }
    return { [key]: serializeContent(redacted) };
  } catch {
    state.droppedFieldCount += 1;
    loss(state, 'content_filtered', 'A content field was omitted because redaction failed.');
    return {};
  }
}

function callPayload(event: EventEnvelope<string, unknown>): CallPayload | undefined {
  if (!isRecord(event.payload) || typeof event.payload.correlation_key !== 'string') {
    return undefined;
  }
  return event.payload as CallPayload;
}

function parentCandidates(
  event: EventEnvelope<string, unknown>,
  events: ReadonlyMap<string, EventEnvelope<string, unknown>>,
  owner: ReadonlyMap<string, string>,
): string[] {
  const candidates = new Set<string>();
  const visited = new Set<string>();
  const pending = [...event.parent_ids];
  while (pending.length > 0) {
    const eventId = pending.pop();
    if (eventId === undefined || visited.has(eventId)) continue;
    visited.add(eventId);
    const span = owner.get(eventId);
    if (span !== undefined) {
      candidates.add(span);
      continue;
    }
    pending.push(...(events.get(eventId)?.parent_ids ?? []));
  }
  return [...candidates].sort();
}

function callKindForRequested(event: EventEnvelope<string, unknown>): CallKind | undefined {
  if (event.type === 'model.requested') return 'model';
  if (event.type === 'tool.requested') return 'tool';
  return undefined;
}

function callTerminal(
  event: EventEnvelope<string, unknown>,
): { readonly kind: CallKind; readonly failed: boolean } | undefined {
  if (event.type === 'model.completed') return { kind: 'model', failed: false };
  if (event.type === 'model.failed') return { kind: 'model', failed: true };
  if (event.type === 'tool.completed') return { kind: 'tool', failed: false };
  if (event.type === 'tool.failed') return { kind: 'tool', failed: true };
  return undefined;
}

/**
 * Returns the shortest parent-graph distance to each ancestor without
 * recursion, so valid deep snapshot histories cannot overflow the stack.
 */
function ancestorDistances(
  event: EventEnvelope<string, unknown>,
  events: ReadonlyMap<string, EventEnvelope<string, unknown>>,
): ReadonlyMap<string, number> {
  const distances = new Map<string, number>();
  const pending = event.parent_ids.map((eventId) => ({ eventId, distance: 1 }));
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]!;
    const previous = distances.get(item.eventId);
    if (previous !== undefined && previous <= item.distance) continue;
    distances.set(item.eventId, item.distance);
    const parent = events.get(item.eventId);
    if (parent !== undefined) {
      pending.push(
        ...parent.parent_ids.map((eventId) => ({ eventId, distance: item.distance + 1 })),
      );
    }
  }
  return distances;
}

function mapCallFinishes(
  calls: readonly CallStart[],
  ordered: readonly EventEnvelope<string, unknown>[],
  events: ReadonlyMap<string, EventEnvelope<string, unknown>>,
  runId: string,
  state: MapState,
): ReadonlyMap<string, CallFinish> {
  const pending = new Set(calls.map((call) => call.event.event_id));
  const finishes = new Map<string, CallFinish>();

  for (const event of ordered) {
    if (event.run_id !== runId) continue;
    const terminal = callTerminal(event);
    const payload = terminal === undefined ? undefined : callPayload(event);
    if (terminal === undefined || payload === undefined) continue;
    const candidates = calls.filter(
      (call) =>
        pending.has(call.event.event_id) &&
        call.kind === terminal.kind &&
        call.correlationKey === payload.correlation_key &&
        call.event.sequence < event.sequence,
    );
    if (candidates.length === 0) continue;

    const distances = ancestorDistances(event, events);
    const related = candidates
      .map((call) => ({ call, distance: distances.get(call.event.event_id) }))
      .filter(
        (item): item is { readonly call: CallStart; readonly distance: number } =>
          item.distance !== undefined,
      );
    const nearestDistance = Math.min(...related.map((candidate) => candidate.distance));
    const choices =
      related.length === 0
        ? candidates.sort(
            (left, right) =>
              left.event.sequence - right.event.sequence ||
              left.event.event_id.localeCompare(right.event.event_id),
          )
        : related
            .filter((item) => item.distance === nearestDistance)
            .map((item) => item.call)
            .sort(
              (left, right) =>
                left.event.sequence - right.event.sequence ||
                left.event.event_id.localeCompare(right.event.event_id),
            );
    const call = choices[0];
    if (call === undefined) continue;
    if (choices.length > 1) {
      loss(
        state,
        'ambiguous_call_finish',
        'A terminal call had multiple possible requested-call matches; the earliest deterministic match was used.',
      );
    }
    finishes.set(call.event.event_id, { event, failed: terminal.failed });
    pending.delete(call.event.event_id);
  }
  return finishes;
}

function statusForTerminal(snapshot: ExportSnapshotInput): 'OK' | 'ERROR' | 'UNSET' {
  return snapshot.manifest.terminal_status === 'completed'
    ? 'OK'
    : snapshot.manifest.terminal_status === 'failed'
      ? 'ERROR'
      : 'UNSET';
}

function mapNativeOrSdk(snapshot: ExportSnapshotInput, state: MapState): ExportSpan[] {
  const ordered = [...snapshot.events].sort((left, right) => left.sequence - right.sequence);
  const byId = new Map(ordered.map((event) => [event.event_id, event]));
  const traceId = stableHex(`trace:${snapshot.manifest.run_id}`, 16);
  const runSpanId = stableHex(`span:${snapshot.manifest.run_id}:run`, 8);
  const calls: CallStart[] = [];

  for (const event of ordered) {
    if (event.run_id !== snapshot.manifest.run_id) continue;
    const kind = callKindForRequested(event);
    if (kind === undefined) continue;
    const payload = callPayload(event);
    if (payload === undefined) {
      loss(state, 'unsupported_event', 'A requested call lacked a correlation key.');
      continue;
    }
    if (calls.length >= state.limits.maxSpans - 1) {
      loss(state, 'request_truncated', 'Requested calls exceeded the outbound span limit.');
      continue;
    }
    const name = kind === 'model' ? payload.model : payload.tool;
    calls.push({
      event,
      kind,
      correlationKey: payload.correlation_key,
      name: typeof name === 'string' ? name : 'unknown',
    });
  }
  const finishes = mapCallFinishes(calls, ordered, byId, snapshot.manifest.run_id, state);

  const owner = new Map<string, string>();
  const callSpanId = new Map<string, string>();
  for (const call of calls) {
    const spanId = stableHex(
      `span:${snapshot.manifest.run_id}:${call.kind}:${call.event.event_id}`,
      8,
    );
    callSpanId.set(call.event.event_id, spanId);
    owner.set(call.event.event_id, spanId);
    const finish = finishes.get(call.event.event_id);
    if (finish !== undefined) owner.set(finish.event.event_id, spanId);
  }

  const first = ordered.find((event) => event.type === 'run.started') ?? ordered[0];
  const last =
    [...ordered].reverse().find((event) => event.type.startsWith('run.')) ?? ordered.at(-1);
  const runAttributes: JsonObject = {
    'agent_loop_snapshot.source': state.source,
    'agent_loop_snapshot.completeness': state.completeness,
    'agent_loop_snapshot.run_id_hash': stableHex(`run:${snapshot.manifest.run_id}`, 16),
  };
  if (state.limitations.length > 0) {
    runAttributes['agent_loop_snapshot.limitation_code_hashes'] = state.limitations.map((item) =>
      stableHex(`limitation:${item.code}`, 8),
    );
  }
  const runEvents: JsonObject[] = [];
  for (const event of ordered) {
    if (event.type === 'run.started' && isRecord(event.payload) && 'input' in event.payload) {
      contentAttribute(
        state,
        'agent_loop_snapshot.input',
        event.payload.input,
        `/events/${event.event_id}/payload/input`,
      );
    }
    if (
      event.type.endsWith('.requested') ||
      event.type.endsWith('.completed') ||
      event.type.endsWith('.failed') ||
      event.type === 'run.started'
    )
      continue;
    if (runEvents.length >= state.limits.maxEventsPerSpan) {
      loss(state, 'limit_exceeded', 'Run events exceeded the outbound item limit.');
      continue;
    }
    const details: JsonObject = {
      'agent_loop_snapshot.event_type_hash': stableHex(`event-type:${event.type}`, 8),
    };
    if (isRecord(event.payload)) {
      const content = contentAttribute(
        state,
        'agent_loop_snapshot.payload',
        event.payload,
        `/events/${event.event_id}/payload`,
      );
      if (state.policy === 'redacted-content') Object.assign(details, content);
    }
    runEvents.push({
      name: 'agent_loop_snapshot.event',
      time_unix_nano: nano(event.timestamp),
      attributes: details,
    });
  }
  const result: ExportSpan[] = [
    {
      traceId,
      spanId: runSpanId,
      name: 'agent.run',
      startTimeUnixNano: nano(first?.timestamp),
      ...(last === undefined ? {} : { endTimeUnixNano: nano(last.timestamp) }),
      status: statusForTerminal(snapshot),
      attributes: runAttributes,
      events: runEvents,
      links: [],
    },
  ];

  for (const call of [...calls].sort((left, right) => left.event.sequence - right.event.sequence)) {
    const finish = finishes.get(call.event.event_id);
    const parents = parentCandidates(call.event, byId, owner);
    const primaryParent = parents[0] ?? runSpanId;
    if (parents.length > 1) {
      loss(
        state,
        'multiple_parents_collapsed',
        'Multiple snapshot parents were converted to OTLP links.',
        parents.length - 1,
      );
    }
    const payload = callPayload(call.event)!;
    const payloadField = call.kind === 'model' ? 'input' : 'arguments';
    const eventAttributes: JsonObject = {
      'agent_loop_snapshot.call_kind': call.kind,
      'agent_loop_snapshot.correlation_key_hash': stableHex(
        `correlation:${call.correlationKey}`,
        16,
      ),
    };
    const requestedContent = contentAttribute(
      state,
      `agent_loop_snapshot.${payloadField}`,
      payload[payloadField],
      `/events/${call.event.event_id}/payload/${payloadField}`,
    );
    if (state.policy === 'redacted-content') {
      Object.assign(eventAttributes, requestedContent);
      if (finish !== undefined && isRecord(finish.event.payload)) {
        const field = finish.failed ? 'error' : 'output';
        Object.assign(
          eventAttributes,
          contentAttribute(
            state,
            `agent_loop_snapshot.${field}`,
            finish.event.payload[field],
            `/events/${finish.event.event_id}/payload/${field}`,
          ),
        );
      }
      eventAttributes['agent_loop_snapshot.operation_name'] = String(
        state.redaction.redact(call.name, `/events/${call.event.event_id}/payload/name`),
      );
    } else if (finish !== undefined && isRecord(finish.event.payload)) {
      const field = finish.failed ? 'error' : 'output';
      contentAttribute(
        state,
        `agent_loop_snapshot.${field}`,
        finish.event.payload[field],
        `/events/${finish.event.event_id}/payload/${field}`,
      );
    }
    if (finish === undefined) {
      loss(state, 'unpaired_call', 'A requested call has no completed or failed terminal event.');
    }
    result.push({
      traceId,
      spanId: callSpanId.get(call.event.event_id)!,
      parentSpanId: primaryParent,
      name: call.kind === 'model' ? 'model.call' : 'tool.call',
      startTimeUnixNano: nano(call.event.timestamp),
      ...(finish === undefined ? {} : { endTimeUnixNano: nano(finish.event.timestamp) }),
      status: finish === undefined ? 'UNSET' : finish.failed ? 'ERROR' : 'OK',
      attributes: eventAttributes,
      events: [],
      links: parents.slice(1).map((spanId) => ({ traceId, spanId })),
    });
  }
  return result;
}

function importedSpanFrom(
  event: EventEnvelope<string, unknown>,
  state: MapState,
): ExportSpan | undefined {
  if (!isRecord(event.payload)) return undefined;
  const payload = event.payload;
  const sourceTraceId = payload.trace_id;
  const sourceSpanId = payload.span_id;
  if (!isValidId(sourceTraceId, 32) || !isValidId(sourceSpanId, 16)) {
    loss(state, 'invalid_source_id', 'An imported span used invalid source IDs and was omitted.');
    return undefined;
  }
  const sourceParent = payload.parent_span_id;
  const spanAttributes: JsonObject = {
    'agent_loop_snapshot.source': 'otel-import',
    'agent_loop_snapshot.completeness': state.completeness,
  };
  if (state.policy === 'redacted-content' && payload.attributes !== undefined) {
    Object.assign(
      spanAttributes,
      contentAttribute(
        state,
        'agent_loop_snapshot.attributes',
        payload.attributes,
        `/events/${event.event_id}/payload/attributes`,
      ),
    );
  } else if (payload.attributes !== undefined) {
    state.droppedFieldCount += 1;
    loss(
      state,
      'attribute_filtered',
      'Imported span attributes were omitted by metadata-only policy.',
    );
  }
  if (payload.resource !== undefined || payload.scope !== undefined) {
    loss(
      state,
      'metadata_filtered',
      'Imported resource and scope metadata were replaced by the configured outbound identity.',
    );
  }
  const sourceEvents = Array.isArray(payload.events) ? payload.events : [];
  const events: JsonObject[] = [];
  if (state.policy === 'redacted-content') {
    const count = Math.min(sourceEvents.length, state.limits.maxEventsPerSpan);
    if (sourceEvents.length > count)
      loss(state, 'limit_exceeded', 'Imported events exceeded the outbound item limit.');
    for (let index = 0; index < count; index += 1) {
      events.push({
        name: 'agent_loop_snapshot.imported_event',
        time_unix_nano: nano(event.timestamp),
        attributes: contentAttribute(
          state,
          'agent_loop_snapshot.event',
          sourceEvents[index],
          `/events/${event.event_id}/payload/events/${String(index)}`,
        ),
      });
    }
  }
  const links = Array.isArray(payload.links)
    ? payload.links.flatMap((item) => {
        if (!isRecord(item) || !isValidId(item.traceId, 32) || !isValidId(item.spanId, 16))
          return [];
        return [{ traceId: item.traceId, spanId: item.spanId }];
      })
    : [];
  const status = payload.status === 'ok' ? 'OK' : payload.status === 'error' ? 'ERROR' : 'UNSET';
  if (status === 'UNSET')
    loss(state, 'unknown_status_preserved', 'An imported UNSET status was preserved.');
  return {
    traceId: sourceTraceId,
    spanId: sourceSpanId,
    ...(isValidId(sourceParent, 16) ? { parentSpanId: sourceParent } : {}),
    name: 'otel.imported_span',
    startTimeUnixNano:
      typeof payload.start_time_unix_nano === 'string'
        ? payload.start_time_unix_nano
        : nano(event.timestamp),
    ...(typeof payload.end_time_unix_nano === 'string'
      ? { endTimeUnixNano: payload.end_time_unix_nano }
      : {}),
    status,
    attributes: spanAttributes,
    events,
    links,
  };
}

function mapImported(snapshot: ExportSnapshotInput, state: MapState): ExportSpan[] {
  loss(
    state,
    'observation_only_preserved',
    'OTLP-imported snapshots remain observation-only after export.',
  );
  const candidates: EventEnvelope<string, unknown>[] = [];
  let omitted = false;
  for (const event of snapshot.events) {
    if (event.type !== 'otel.span') continue;
    if (candidates.length >= state.limits.maxSpans) {
      omitted = true;
      continue;
    }
    candidates.push(event);
  }
  candidates.sort((left, right) => left.sequence - right.sequence);
  if (omitted) {
    loss(state, 'request_truncated', 'Imported spans exceeded the outbound span limit.');
  }
  return candidates.flatMap((event) => {
    const span = importedSpanFrom(event, state);
    return span === undefined ? [] : [span];
  });
}

function resourceFor(serviceName: string): JsonObject {
  return { 'service.name': `agent-loop-snapshot-${stableHex(`service:${serviceName}`, 8)}` };
}

function scopeFor(): { name?: string; version?: string } {
  return {
    name: '@agent-loop-snapshot/otel-export',
    version: otelExportContractVersion,
  };
}

function toOtlpSpan(span: ExportSpan): OtlpTraceSpan {
  const events: OtlpSpanEvent[] = span.events.map((event) => ({
    timeUnixNano:
      typeof event.time_unix_nano === 'string' ? event.time_unix_nano : span.startTimeUnixNano,
    name: typeof event.name === 'string' ? event.name : 'agent_loop_snapshot.event',
    ...(isRecord(event.attributes) ? { attributes: attributes(event.attributes) } : {}),
  }));
  const statusCode = span.status === 'OK' ? 1 : span.status === 'ERROR' ? 2 : 0;
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    startTimeUnixNano: span.startTimeUnixNano,
    ...(span.endTimeUnixNano === undefined ? {} : { endTimeUnixNano: span.endTimeUnixNano }),
    status: {
      code: statusCode,
      ...(span.statusMessage === undefined ? {} : { message: span.statusMessage }),
    },
    attributes: attributes(span.attributes),
    ...(events.length === 0 ? {} : { events }),
    ...(span.links.length === 0
      ? {}
      : {
          links: span.links.map((link) => ({
            traceId: link.traceId,
            spanId: link.spanId,
            ...(link.attributes === undefined ? {} : { attributes: attributes(link.attributes) }),
          })),
        }),
  };
}

function toRequest(
  spans: readonly ExportSpan[],
  serviceName: string,
): OtlpExportTraceServiceRequest {
  const groups = new Map<
    string,
    { resource: JsonObject; scope: { name?: string; version?: string }; spans: ExportSpan[] }
  >();
  for (const span of spans) {
    const resource = resourceFor(serviceName);
    const scope = scopeFor();
    const key = JSON.stringify([resource, scope]);
    const group = groups.get(key) ?? { resource, scope, spans: [] };
    group.spans.push(span);
    groups.set(key, group);
  }
  const resourceSpans: OtlpResourceSpans[] = [...groups.values()].map((group) => ({
    resource: { attributes: attributes(group.resource) },
    scopeSpans: [{ scope: group.scope, spans: group.spans.map(toOtlpSpan) }],
  }));
  return { resourceSpans };
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundedAttributes(attributesValue: JsonObject, state: MapState): JsonObject {
  const entries = Object.entries(attributesValue).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length <= state.limits.maxAttributesPerSpan) return attributesValue;
  loss(state, 'limit_exceeded', 'Span attributes exceeded the outbound item limit.');
  return Object.fromEntries(entries.slice(0, state.limits.maxAttributesPerSpan)) as JsonObject;
}

function boundedSpan(span: ExportSpan, state: MapState): ExportSpan | undefined {
  const events = span.events.slice(0, state.limits.maxEventsPerSpan).map((event) => ({
    ...event,
    ...(isRecord(event.attributes)
      ? { attributes: boundedAttributes(event.attributes, state) }
      : {}),
  }));
  const links = span.links.slice(0, state.limits.maxLinksPerSpan);
  if (events.length < span.events.length || links.length < span.links.length) {
    loss(state, 'limit_exceeded', 'Span events or links exceeded outbound item limits.');
  }
  let candidate: ExportSpan = {
    ...span,
    attributes: boundedAttributes(span.attributes, state),
    events,
    links,
  };
  while (encodedBytes(toOtlpSpan(candidate)) > state.limits.maxSpanBytes) {
    if (candidate.events.length > 0) {
      candidate = { ...candidate, events: candidate.events.slice(0, -1) };
    } else if (candidate.links.length > 0) {
      candidate = { ...candidate, links: candidate.links.slice(0, -1) };
    } else {
      const keys = Object.keys(candidate.attributes).sort();
      const key = keys.at(-1);
      if (key === undefined) {
        loss(
          state,
          'span_rejected',
          'A span could not fit the outbound byte limit and was omitted.',
        );
        return undefined;
      }
      const attributesValue: JsonObject = { ...candidate.attributes };
      delete attributesValue[key];
      candidate = { ...candidate, attributes: attributesValue };
    }
    loss(state, 'limit_exceeded', 'A span was reduced to fit the outbound byte limit.');
  }
  return candidate;
}

function boundedRequest(
  spans: readonly ExportSpan[],
  serviceName: string,
  state: MapState,
): { readonly spans: readonly ExportSpan[]; readonly request: OtlpExportTraceServiceRequest } {
  const accepted = spans.flatMap((span) => {
    const bounded = boundedSpan(span, state);
    return bounded === undefined ? [] : [bounded];
  });
  while (accepted.length > 0) {
    const request = toRequest(accepted, serviceName);
    if (encodedBytes(request) <= state.limits.maxRequestBytes) return { spans: accepted, request };
    accepted.pop();
    loss(
      state,
      'request_truncated',
      'A span was omitted because the OTLP request byte limit was reached.',
    );
  }
  return { spans: accepted, request: toRequest(accepted, serviceName) };
}

/** Maps an in-memory snapshot without reading files, using the configured content policy. */
export function mapSnapshotToOtlp(
  snapshot: ExportSnapshotInput,
  options: OtelExportMappingOptions = {},
): OtelExportMappingResult {
  const source = sourceFor(snapshot);
  const baselineRedaction = createDefaultOutboundRedactionPipeline();
  const state: MapState = {
    source,
    completeness: completenessFor(snapshot),
    limitations: snapshot.manifest.limitations ?? [],
    policy: options.contentPolicy ?? 'metadata-only',
    redaction:
      options.redaction === undefined
        ? baselineRedaction
        : {
            redact(value, path) {
              return options.redaction!.redact(baselineRedaction.redact(value, path), path);
            },
          },
    limits: mappingLimits(options.limits),
    losses: [],
    droppedFieldCount: 0,
  };
  const mappedSpans =
    source === 'otel-import' ? mapImported(snapshot, state) : mapNativeOrSdk(snapshot, state);
  const bounded = boundedRequest(mappedSpans, options.serviceName ?? 'agent-loop-snapshot', state);
  const spans = bounded.spans;
  const traceId = spans[0]?.traceId ?? stableHex(`trace:${snapshot.manifest.run_id}`, 16);
  const report: ExportMappingReport = {
    contractVersion: otelExportContractVersion,
    source,
    completeness: state.completeness,
    traceId,
    spanCount: spans.length,
    droppedFieldCount: state.droppedFieldCount,
    losses: state.losses,
    limitations: state.limitations,
    observationOnly: source === 'otel-import',
  };
  return { request: bounded.request, spans, report };
}

/** Produces the exact filtered OTLP request and report without queueing or networking. */
export function dryRunOtlpExport(
  snapshot: ExportSnapshotInput,
  options: OtelExportMappingOptions & { readonly targetAlias?: string } = {},
): OtelExportDryRun {
  const mapping = mapSnapshotToOtlp(snapshot, options);
  const delivery: ExportDeliveryReport = {
    state: 'dry_run',
    targetAlias: options.targetAlias ?? 'dry-run',
    attempted: false,
    acceptedSpanCount: 0,
    rejectedSpanCount: 0,
    attempts: 0,
  };
  return { delivery, mapping };
}
