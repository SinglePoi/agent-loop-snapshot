import type {
  EventEnvelope,
  JsonObject,
  JsonValue,
  SnapshotCompleteness,
  SnapshotLimitation,
  SnapshotSource,
} from '@agent-loop-snapshot/schema';

/** Contract version for snapshot-to-OTLP mapping and reports. */
export const otelExportContractVersion = 'otel-export-1.0' as const;
export type OtelExportContractVersion = typeof otelExportContractVersion;

export type ExportContentPolicy = 'metadata-only' | 'redacted-content';

export interface OtelExportConfig {
  readonly targetAlias: string;
  /** Exactly one of endpoint and endpointEnv must be supplied by callers. */
  readonly endpoint?: string;
  readonly endpointEnv?: string;
  /** HTTP header name to environment-variable name; values are never persisted. */
  readonly headersEnv?: Readonly<Record<string, string>>;
  readonly serviceName: string;
  readonly contentPolicy?: ExportContentPolicy;
  readonly timeoutMs?: number;
  readonly batchSpanLimit?: number;
  readonly retryMaxAttempts?: number;
  readonly retryBudgetMs?: number;
  readonly queueDir?: string;
}

export type ExportSnapshotSource = SnapshotSource;

export interface ExportSnapshotInput {
  readonly manifest: {
    readonly run_id: string;
    readonly source?: SnapshotSource;
    readonly completeness?: SnapshotCompleteness;
    readonly limitations?: readonly SnapshotLimitation[];
    readonly runtime?: JsonObject;
    readonly terminal_status?: 'completed' | 'failed' | 'aborted' | 'unknown' | null;
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
  | 'invalid_source_id';

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

export type ExportDeliveryState =
  | 'dry_run'
  | 'not_queued'
  | 'queued'
  | 'accepted'
  | 'retryable'
  | 'rejected'
  | 'exhausted'
  | 'unknown_delivery';

export interface ExportDeliveryReport {
  readonly state: ExportDeliveryState;
  readonly targetAlias: string;
  readonly batchId?: string;
  readonly attempted: boolean;
  readonly acceptedSpanCount: number;
  readonly rejectedSpanCount: number;
  readonly retryAfterMs?: number;
  readonly attempts: number;
  readonly message?: string;
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
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface OtlpHttpSendOptions {
  readonly signal?: AbortSignal;
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
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly retentionMs?: number;
  readonly lockStaleMs?: number;
  /** Test seam; production defaults to Date.now. */
  readonly now?: () => number;
}

export interface OtlpQueueBatch {
  /** Must be the already-filtered request returned by EXP-02. */
  readonly request: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
  readonly batchId?: string;
}

export interface OtlpQueueInspection {
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly expiredCount: number;
  readonly foreignConfigCount: number;
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
  readonly contractVersion: OtelExportContractVersion;
  readonly exportSnapshot: (snapshot: ExportSnapshotInput) => Promise<ExportDeliveryReport>;
  readonly flush: (options?: { readonly deadlineMs?: number }) => Promise<ExporterFlushReport>;
  readonly shutdown: (options?: { readonly deadlineMs?: number }) => Promise<ExporterFlushReport>;
}

export function isExportEndpointConfigured(config: OtelExportConfig): boolean {
  return (config.endpoint !== undefined) !== (config.endpointEnv !== undefined);
}

export {
  createDefaultOutboundRedactionPipeline,
  dryRunOtlpExport,
  mapSnapshotToOtlp,
} from './mapper.js';
export { createOtlpHttpClient } from './http-client.js';
export {
  createOtelExportConfigFingerprint,
  openOtlpPersistentQueue,
  OtlpQueueError,
} from './queue.js';
