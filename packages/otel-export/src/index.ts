import type {
  EventEnvelope,
  JsonObject,
  JsonValue,
  SnapshotCompleteness,
  SnapshotLimitation,
  SnapshotManifest,
  SnapshotSource,
  RuntimeDescriptor,
} from '@agent-loop-snapshot/schema';

/** Contract version for snapshot-to-OTLP mapping and reports. */
export const otelExportContractVersion = 'otel-export-1.0' as const;
export type OtelExportContractVersion = typeof otelExportContractVersion;

/**
 * Frozen target for the reliable-delivery migration.  No v2 producer exists
 * yet: TDX-01 through TDX-05 must implement it before this becomes the active
 * contract version.  Keeping this separate prevents a v1 queue entry from
 * being mistaken for a v2 entry merely because its JSON fields look similar.
 */
export const otelExportReliableDeliveryContractVersion = 'otel-export-2.0' as const;
export type OtelExportReliableDeliveryContractVersion =
  typeof otelExportReliableDeliveryContractVersion;

/** Versions which become part of a v2 batch identity and persistent entry. */
export const otlpJsonMappingVersion = 'otlp-json-mapping-2' as const;
export const otlpPersistentQueueVersion = 'otlp-persistent-queue-2' as const;
export type OtlpJsonMappingVersion = typeof otlpJsonMappingVersion;
export type OtlpPersistentQueueVersion = typeof otlpPersistentQueueVersion;

export type ExportContentPolicy = 'metadata-only' | 'redacted-content';

/**
 * Upper bounds applied before an OTLP request can be persisted or sent. These
 * defaults keep one untrusted snapshot from materializing an unbounded body.
 */
export const defaultOtelExportMappingLimits = {
  maxStringBytes: 16 * 1024,
  maxCollectionItems: 128,
  maxContentDepth: 16,
  maxSpans: 4_096,
  maxAttributesPerSpan: 128,
  maxEventsPerSpan: 128,
  maxLinksPerSpan: 128,
  maxSpanBytes: 256 * 1024,
  maxRequestBytes: 3 * 1024 * 1024,
} as const;

export interface OtelExportMappingLimits {
  readonly maxStringBytes: number;
  readonly maxCollectionItems: number;
  readonly maxContentDepth: number;
  readonly maxSpans: number;
  readonly maxAttributesPerSpan: number;
  readonly maxEventsPerSpan: number;
  readonly maxLinksPerSpan: number;
  readonly maxSpanBytes: number;
  readonly maxRequestBytes: number;
}

export interface OtelExportConfig {
  readonly targetAlias: string;
  /**
   * Safe, caller-chosen receiver or tenant identity. It must not contain an
   * endpoint, header value, or credential. Changing tenants requires a new
   * identity or generation even when the credential variable name is reused.
   */
  readonly destinationIdentity?: string;
  /** Explicit generation for a selected destination identity. */
  readonly destinationGeneration?: string;
  /** Exactly one of endpoint and endpointEnv must be supplied by callers. */
  readonly endpoint?: string;
  readonly endpointEnv?: string;
  /** HTTP header name to environment-variable name; values are never persisted. */
  readonly headersEnv?: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly contentPolicy?: ExportContentPolicy;
  /** Optional bounded overrides shared by SDK, CLI, dry-run, and queue paths. */
  readonly mappingLimits?: Partial<OtelExportMappingLimits>;
  readonly timeoutMs?: number;
  /** Maximum encoded OTLP/HTTP JSON bytes in one durable batch. */
  readonly batchMaxBytes?: number;
  readonly batchSpanLimit?: number;
  readonly retryMaxAttempts?: number;
  readonly retryBudgetMs?: number;
  readonly queueDir?: string;
  readonly queueMaxEntries?: number;
  readonly queueMaxBytes?: number;
  readonly queueRetentionMs?: number;
}

export type ExportSnapshotSource = SnapshotSource;

export interface ExportSnapshotInput {
  readonly manifest: Pick<
    SnapshotManifest,
    'run_id' | 'source' | 'completeness' | 'limitations' | 'terminal_status'
  > & {
    readonly runtime?: RuntimeDescriptor;
  };
  readonly events: readonly EventEnvelope<string, unknown>[];
}

export type OtlpSpanStatus = 'OK' | 'ERROR' | 'UNSET';

export interface OtlpSpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes?: JsonObject;
}

/** The normalized span shape consumed by EXP-03's OTLP/HTTP encoder. */
export interface ExportSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano?: string;
  readonly status: OtlpSpanStatus;
  readonly statusMessage?: string;
  readonly attributes: JsonObject;
  readonly events: readonly JsonObject[];
  readonly links: readonly OtlpSpanLink[];
  readonly resource?: JsonObject;
  readonly scope?: JsonObject;
}

export interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values: readonly OtlpAnyValue[] };
  readonly kvlistValue?: { readonly values: readonly OtlpKeyValue[] };
}

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export interface OtlpSpanEvent {
  readonly timeUnixNano: string;
  readonly name: string;
  readonly attributes?: readonly OtlpKeyValue[];
}

export interface OtlpTraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano?: string;
  readonly status: { readonly code: number; readonly message?: string };
  readonly attributes?: readonly OtlpKeyValue[];
  readonly events?: readonly OtlpSpanEvent[];
  readonly links?: readonly {
    readonly traceId: string;
    readonly spanId: string;
    readonly attributes?: readonly OtlpKeyValue[];
  }[];
}

export interface OtlpResourceSpans {
  readonly resource: { readonly attributes?: readonly OtlpKeyValue[] };
  readonly scopeSpans: readonly {
    readonly scope: { readonly name?: string; readonly version?: string };
    readonly spans: readonly OtlpTraceSpan[];
  }[];
}

/** OTLP/HTTP JSON ExportTraceServiceRequest body, ready for EXP-03 transport. */
export interface OtlpExportTraceServiceRequest {
  readonly resourceSpans: readonly OtlpResourceSpans[];
}

export interface OutboundRedactionPipeline {
  redact(value: JsonValue, path: string): JsonValue;
}

export interface OtelExportMappingOptions {
  readonly contentPolicy?: ExportContentPolicy;
  readonly serviceName?: string;
  readonly redaction?: OutboundRedactionPipeline;
  readonly limits?: Partial<OtelExportMappingLimits>;
}

export interface OtelExportMappingResult {
  readonly request: OtlpExportTraceServiceRequest;
  readonly spans: readonly ExportSpan[];
  readonly report: ExportMappingReport;
}

export interface OtelExportDryRun {
  readonly delivery: ExportDeliveryReport;
  readonly mapping: OtelExportMappingResult;
}

export type ExportLossCode =
  | 'multiple_parents_collapsed'
  | 'unpaired_call'
  | 'content_filtered'
  | 'attribute_filtered'
  | 'artifact_content_omitted'
  | 'unknown_status_preserved'
  | 'observation_only_preserved'
  | 'unsupported_event'
  | 'ambiguous_call_finish'
  | 'invalid_source_id'
  | 'metadata_filtered'
  | 'value_truncated'
  | 'limit_exceeded'
  | 'span_rejected'
  | 'request_truncated';

export interface ExportMappingLoss {
  readonly code: ExportLossCode;
  readonly message: string;
  readonly count?: number;
  readonly paths?: readonly string[];
}

export interface ExportMappingReport {
  readonly contractVersion: OtelExportContractVersion;
  readonly source: ExportSnapshotSource;
  readonly completeness: SnapshotCompleteness;
  readonly traceId: string;
  readonly spanCount: number;
  readonly droppedFieldCount: number;
  readonly losses: readonly ExportMappingLoss[];
  readonly limitations: readonly SnapshotLimitation[];
  readonly observationOnly: boolean;
}

export interface ExportBatch {
  readonly batchId: string;
  readonly targetAlias: string;
  readonly configFingerprint: string;
  readonly spans: readonly ExportSpan[];
  readonly report: ExportMappingReport;
}

/**
 * Stable destination identity supplied by the user.  It distinguishes a
 * deliberately selected receiver or tenant from a rotating credential.  Its
 * value must be safe to hash and persist; it must never contain a credential.
 */
export interface ExportDestinationIdentity {
  readonly targetAlias: string;
  readonly destinationIdentity: string;
  readonly destinationGeneration: string;
}

/** Frozen v2 batch identity. The encoded payload is not part of this shape. */
export interface ExportBatchIdentity extends ExportDestinationIdentity {
  readonly reliableDeliveryContractVersion: OtelExportReliableDeliveryContractVersion;
  readonly mappingVersion: OtlpJsonMappingVersion;
  readonly queueVersion: OtlpPersistentQueueVersion;
  readonly contentPolicy: ExportContentPolicy;
  readonly encoding: 'otlp-http-json';
  /** Hash of the resolved destination and non-secret delivery configuration. */
  readonly targetFingerprint: string;
  readonly batchId: string;
}

export type ExportDeliveryState =
  | 'dry_run'
  | 'not_queued'
  | 'queued'
  | 'accepted'
  | 'retryable'
  | 'rejected'
  | 'exhausted'
  | 'unknown_delivery';

/**
 * Canonical states for reliable delivery.  v1 aliases above remain exported
 * for source compatibility until TDX-05 migrates the factory and CLI.
 */
export type ReliableDeliveryState =
  | 'not_sent'
  | 'configuration_blocked'
  | 'pending'
  | 'accepted'
  | 'accepted_with_warnings'
  | 'partially_rejected'
  | 'permanently_rejected'
  | 'retry_scheduled'
  | 'retry_exhausted'
  | 'unknown_delivery';

export interface ExportDeliveryReport {
  readonly state: ExportDeliveryState;
  /**
   * More specific delivery meaning while the v1 `state` union remains
   * source-compatible. TDX-05 will make this the primary report state.
   */
  readonly reliableState?: ReliableDeliveryState;
  readonly targetAlias: string;
  readonly batchId?: string;
  readonly attempted: boolean;
  readonly acceptedSpanCount: number;
  readonly rejectedSpanCount: number;
  readonly retryAfterMs?: number;
  readonly attempts: number;
  readonly message?: string;
}

/** One batch outcome in a reliable-delivery job. */
export interface ReliableBatchDeliveryReport {
  readonly identity: ExportBatchIdentity;
  readonly state: ReliableDeliveryState;
  readonly attempted: boolean;
  readonly acceptedSpanCount: number;
  readonly rejectedSpanCount: number;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  /** Sanitized diagnostic only; never include endpoint, headers, or payload. */
  readonly message?: string;
}

/**
 * The v2 aggregate result. A single snapshot may create several batches, so a
 * queue acknowledgement is deliberately not represented as remote acceptance.
 */
export interface ReliableExportDeliveryReport {
  readonly reliableDeliveryContractVersion: OtelExportReliableDeliveryContractVersion;
  readonly sourceRunId: string;
  readonly state: ReliableDeliveryState;
  readonly batches: readonly ReliableBatchDeliveryReport[];
  readonly pendingBatchCount: number;
  readonly pendingSpanCount: number;
  readonly unknownDeliveryBatchCount: number;
  /** Mapping or batching diagnostics that prevented a span from being queued. */
  readonly diagnostics: readonly ExportMappingLoss[];
}

export interface OtlpPartialSuccess {
  readonly rejectedSpans: number;
  readonly errorMessage?: string;
}

export interface ExporterFlushReport {
  readonly contractVersion: OtelExportContractVersion;
  readonly deliveries: readonly ExportDeliveryReport[];
  readonly pendingCount: number;
  readonly deadlineExceeded: boolean;
}

export interface OtlpHttpRuntime {
  /** Test seam; production defaults to the platform fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
  /** Test seam; production resolves names from process.env while sending. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Wall clock used only for HTTP-date Retry-After values. */
  readonly now?: () => number;
  /** Monotonic clock used for request and retry-budget accounting. */
  readonly monotonicNow?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface OtlpHttpSendOptions {
  readonly signal?: AbortSignal;
  /** Refuse a send if the currently resolved destination no longer matches. */
  readonly expectedTargetFingerprint?: string;
}

export interface OtlpHttpClient {
  /** Sends one already-filtered OTLP request. It never maps snapshots or retries business work. */
  send(
    request: OtlpExportTraceServiceRequest,
    spanCount: number,
    options?: OtlpHttpSendOptions,
  ): Promise<ExportDeliveryReport>;
}

export interface OtlpPersistentQueueOptions {
  readonly queueDir: string;
  readonly targetAlias: string;
  /** Hash of non-sensitive destination and content-policy configuration. */
  readonly configFingerprint: string;
  /** Safe identity and generation, used to make tenant changes explicit. */
  readonly destinationIdentity?: string;
  readonly destinationGeneration?: string;
  readonly mappingVersion?: OtlpJsonMappingVersion;
  readonly contentPolicy?: ExportContentPolicy;
  readonly encoding?: 'otlp-http-json';
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly retentionMs?: number;
  /** Consumer lease duration. The legacy name is retained as an alias. */
  readonly leaseDurationMs?: number;
  readonly lockStaleMs?: number;
  readonly retryMaxAttempts?: number;
  readonly retryBudgetMs?: number;
  readonly maxEntryBytes?: number;
  /** Test seam; production defaults to Date.now. */
  readonly now?: () => number;
}

export interface OtlpQueueBatch {
  /** Must be the already-filtered request returned by EXP-02. */
  readonly request: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
  readonly batchId?: string;
  /** Optional safe source reference for delivery/archive diagnostics. */
  readonly sourceSnapshotId?: string;
}

export interface OtlpQueueInspection {
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly oldestPendingAgeMs?: number;
  readonly expiredCount: number;
  readonly foreignConfigCount: number;
  readonly archivedCount: number;
  readonly archivedBytes: number;
  readonly quarantinedCount: number;
  readonly quarantinedBytes: number;
  readonly rejectedCount: number;
  readonly exhaustedCount: number;
  readonly unknownDeliveryCount: number;
}

export interface OtlpQueueFlushOptions {
  readonly deadlineMs?: number;
}

export interface OtlpPersistentQueue {
  enqueue(batch: OtlpQueueBatch): Promise<ExportDeliveryReport>;
  inspect(): Promise<OtlpQueueInspection>;
  flush(client: OtlpHttpClient, options?: OtlpQueueFlushOptions): Promise<ExporterFlushReport>;
  shutdown(client: OtlpHttpClient, options?: OtlpQueueFlushOptions): Promise<ExporterFlushReport>;
}

/**
 * EXP-01 deliberately exposes no network behavior. This marker lets later
 * implementations advertise the fixed contract without coupling Recorder to
 * an HTTP client.
 */
export interface OtlpExporter {
  /** v1 remains accepted while SDK/CLI consumers migrate to aggregate reports. */
  readonly contractVersion: OtelExportContractVersion | OtelExportReliableDeliveryContractVersion;
  /**
   * Persist the snapshot's export intent before queue insertion. The result
   * covers every resulting batch; a local `pending` acknowledgement is not a
   * claim that the receiver accepted it.
   */
  readonly exportSnapshot: (
    snapshot: ExportSnapshotInput,
  ) => Promise<ExportDeliveryReport | ReliableExportDeliveryReport>;
  /** Resume only intent records under this exporter's configured queue directory. */
  readonly resume?: () => Promise<readonly ReliableExportDeliveryReport[]>;
  readonly flush: (options?: { readonly deadlineMs?: number }) => Promise<ExporterFlushReport>;
  readonly shutdown: (options?: { readonly deadlineMs?: number }) => Promise<ExporterFlushReport>;
}

/** The v2 factory result; it remains structurally usable where v1 exporters are accepted. */
export interface ReliableOtlpExporter {
  readonly contractVersion: OtelExportReliableDeliveryContractVersion;
  readonly exportSnapshot: (snapshot: ExportSnapshotInput) => Promise<ReliableExportDeliveryReport>;
  readonly resume: () => Promise<readonly ReliableExportDeliveryReport[]>;
  readonly flush: (options?: { readonly deadlineMs?: number }) => Promise<ExporterFlushReport>;
  readonly shutdown: (options?: { readonly deadlineMs?: number }) => Promise<ExporterFlushReport>;
}

export function isExportEndpointConfigured(config: OtelExportConfig): boolean {
  return (config.endpoint !== undefined) !== (config.endpointEnv !== undefined);
}

export function isReliableExportDeliveryReport(
  report: ExportDeliveryReport | ReliableExportDeliveryReport,
): report is ReliableExportDeliveryReport {
  return 'reliableDeliveryContractVersion' in report;
}

export {
  createDefaultOutboundRedactionPipeline,
  dryRunOtlpExport,
  mapSnapshotToOtlp,
} from './mapper.js';
export { createOtlpHttpClient } from './http-client.js';
export { createOtlpExporter } from './exporter.js';
export {
  createOtelExportConfigFingerprint,
  openOtlpPersistentQueue,
  OtlpQueueError,
} from './queue.js';
