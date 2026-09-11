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

interface MapState {
  readonly source: SnapshotSource;
  readonly completeness: SnapshotCompleteness;
  readonly limitations: readonly SnapshotLimitation[];
  readonly policy: ExportContentPolicy;
  readonly redaction: OutboundRedactionPipeline;
  readonly losses: ExportMappingLoss[];
  droppedFieldCount: number;
}

const secretKey = /(?:api[_-]?key|authorization|password|secret|token)/iu;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(asJsonValue);
    return items.every((item) => item !== undefined) ? (items as JsonValue[]) : undefined;
  }
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      const parsed = asJsonValue(nested);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result;
  }
  return undefined;
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
      result[key] = secretKey.test(key)
        ? '[REDACTED:secret]'
        : redact(nested, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
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
  const json = asJsonValue(value);
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
  return { [key]: serializeContent(state.redaction.redact(json, path)) };
}

function callPayload(event: EventEnvelope<string, unknown>): CallPayload | undefined {
  if (!isRecord(event.payload) || typeof event.payload.correlation_key !== 'string') {
    return undefined;
  }
  return { ...event.payload, correlation_key: event.payload.correlation_key };
}

function parentCandidates(
  event: EventEnvelope<string, unknown>,
  events: ReadonlyMap<string, EventEnvelope<string, unknown>>,
  owner: ReadonlyMap<string, string>,
): string[] {
  const candidates = new Set<string>();
  const visited = new Set<string>();
  const visit = (eventId: string): void => {
    if (visited.has(eventId)) return;
    visited.add(eventId);
    const span = owner.get(eventId);
    if (span !== undefined) {
      candidates.add(span);
      return;
    }
    events.get(eventId)?.parent_ids.forEach(visit);
  };
  event.parent_ids.forEach(visit);
  return [...candidates].sort();
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
  const calls = new Map<string, CallStart>();
  const finishes = new Map<string, CallFinish>();

  for (const event of ordered) {
    if (event.type !== 'model.requested' && event.type !== 'tool.requested') continue;
    const payload = callPayload(event);
    if (payload === undefined) {
      loss(state, 'unsupported_event', 'A requested call lacked a correlation key.');
      continue;
    }
    const name = event.type === 'model.requested' ? payload.model : payload.tool;
    calls.set(payload.correlation_key, {
      event,
      kind: event.type === 'model.requested' ? 'model' : 'tool',
      correlationKey: payload.correlation_key,
      name: typeof name === 'string' ? name : 'unknown',
    });
  }
  for (const event of ordered) {
    if (!event.type.endsWith('.completed') && !event.type.endsWith('.failed')) continue;
    const payload = callPayload(event);
    if (payload !== undefined && calls.has(payload.correlation_key)) {
      finishes.set(payload.correlation_key, { event, failed: event.type.endsWith('.failed') });
    }
  }

  const owner = new Map<string, string>();
  const callSpanId = new Map<string, string>();
  for (const call of calls.values()) {
    const spanId = stableHex(
      `span:${snapshot.manifest.run_id}:${call.kind}:${call.correlationKey}`,
      8,
    );
    callSpanId.set(call.correlationKey, spanId);
    owner.set(call.event.event_id, spanId);
    const finish = finishes.get(call.correlationKey);
    if (finish !== undefined) owner.set(finish.event.event_id, spanId);
  }

  const first = ordered.find((event) => event.type === 'run.started') ?? ordered[0];
  const last =
    [...ordered].reverse().find((event) => event.type.startsWith('run.')) ?? ordered.at(-1);
  const runAttributes: JsonObject = {
    'agent_loop_snapshot.source': state.source,
    'agent_loop_snapshot.completeness': state.completeness,
    'agent_loop_snapshot.run_id': snapshot.manifest.run_id,
  };
  if (state.limitations.length > 0) {
    runAttributes['agent_loop_snapshot.limitation_codes'] = state.limitations.map(
      (item) => item.code,
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
    const details: JsonObject = { 'agent_loop_snapshot.event_type': event.type };
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

  for (const call of [...calls.values()].sort(
    (left, right) => left.event.sequence - right.event.sequence,
  )) {
    const finish = finishes.get(call.correlationKey);
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
      'agent_loop_snapshot.correlation_key': call.correlationKey,
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
      spanId: callSpanId.get(call.correlationKey)!,
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
  const resource = asJsonValue(payload.resource);
  const scope = asJsonValue(payload.scope);
  const attributesValue = asJsonValue(payload.attributes);
  const spanAttributes: JsonObject = {
    'agent_loop_snapshot.source': 'otel-import',
    'agent_loop_snapshot.completeness': state.completeness,
  };
  if (state.policy === 'redacted-content' && attributesValue !== undefined) {
    Object.assign(
      spanAttributes,
      contentAttribute(
        state,
        'agent_loop_snapshot.attributes',
        attributesValue,
        `/events/${event.event_id}/payload/attributes`,
      ),
    );
  } else if (attributesValue !== undefined) {
    state.droppedFieldCount += 1;
    loss(
      state,
      'attribute_filtered',
      'Imported span attributes were omitted by metadata-only policy.',
    );
  }
  const sourceEvents = Array.isArray(payload.events) ? payload.events : [];
  const events = sourceEvents.flatMap((item, index) => {
    const value = asJsonValue(item);
    if (value === undefined || state.policy === 'metadata-only') return [];
    return [
      {
        name: 'agent_loop_snapshot.imported_event',
        time_unix_nano: nano(event.timestamp),
        attributes: contentAttribute(
          state,
          'agent_loop_snapshot.event',
          value,
          `/events/${event.event_id}/payload/events/${String(index)}`,
        ),
      },
    ];
  });
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
    ...(isRecord(resource) ? { resource } : {}),
    ...(isRecord(scope) ? { scope } : {}),
  };
}

function mapImported(snapshot: ExportSnapshotInput, state: MapState): ExportSpan[] {
  loss(
    state,
    'observation_only_preserved',
    'OTLP-imported snapshots remain observation-only after export.',
  );
  return snapshot.events
    .filter((event) => event.type === 'otel.span')
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((event) => {
      const span = importedSpanFrom(event, state);
      return span === undefined ? [] : [span];
    });
}

function resourceFor(span: ExportSpan, serviceName: string): JsonObject {
  const resource = span.resource;
  if (!isRecord(resource)) return { 'service.name': serviceName };
  const nested = resource.attributes;
  if (!isRecord(nested)) return { 'service.name': serviceName };
  const name = typeof nested['service.name'] === 'string' ? nested['service.name'] : serviceName;
  return { 'service.name': name };
}

function scopeFor(span: ExportSpan): { name?: string; version?: string } {
  if (!isRecord(span.scope))
    return { name: '@agent-loop-snapshot/otel-export', version: otelExportContractVersion };
  return {
    ...(typeof span.scope.name === 'string'
      ? { name: span.scope.name }
      : { name: '@agent-loop-snapshot/otel-export' }),
    ...(typeof span.scope.version === 'string' ? { version: span.scope.version } : {}),
  };
}

function toOtlpSpan(span: ExportSpan): OtlpTraceSpan {
  const events: OtlpSpanEvent[] = span.events.map((event) => ({
    timeUnixNano:
      typeof event.time_unix_nano === 'string' ? event.time_unix_nano : span.startTimeUnixNano,
    name: typeof event.name === 'string' ? event.name : 'agent_loop_snapshot.event',
    ...(isRecord(event.attributes) ? { attributes: attributes(event.attributes) } : {}),
  }));
  const statusCode = span.status === 'OK' ? 2 : span.status === 'ERROR' ? 3 : 0;
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
    const resource = resourceFor(span, serviceName);
    const scope = scopeFor(span);
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

/** Maps an in-memory snapshot without reading files, using the configured content policy. */
export function mapSnapshotToOtlp(
  snapshot: ExportSnapshotInput,
  options: OtelExportMappingOptions = {},
): OtelExportMappingResult {
  const source = sourceFor(snapshot);
  const state: MapState = {
    source,
    completeness: completenessFor(snapshot),
    limitations: snapshot.manifest.limitations ?? [],
    policy: options.contentPolicy ?? 'metadata-only',
    redaction: options.redaction ?? createDefaultOutboundRedactionPipeline(),
    losses: [],
    droppedFieldCount: 0,
  };
  const spans =
    source === 'otel-import' ? mapImported(snapshot, state) : mapNativeOrSdk(snapshot, state);
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
  return { request: toRequest(spans, options.serviceName ?? 'agent-loop-snapshot'), spans, report };
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
