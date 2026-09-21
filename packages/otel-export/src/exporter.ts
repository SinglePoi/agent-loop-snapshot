import { createHash } from 'node:crypto';

import {
  defaultOtelExportMappingLimits,
  otelExportContractVersion,
  otelExportReliableDeliveryContractVersion,
  type ExportBatchIdentity,
  type ExportDeliveryReport,
  type ExportMappingLoss,
  type ExportSnapshotInput,
  type ExporterFlushReport,
  type OtelExportConfig,
  type OtlpExportTraceServiceRequest,
  type OtlpPersistentQueue,
  type ReliableBatchDeliveryReport,
  type ReliableDeliveryState,
  type ReliableExportDeliveryReport,
  type ReliableOtlpExporter,
} from './index.js';
import {
  DeliveryRecordStore,
  type DeliveryRecord,
  type DeliveryRecordBatch,
} from './delivery-records.js';
import { createOtlpHttpClient } from './http-client.js';
import { mapSnapshotToOtlp } from './mapper.js';
import { createOtelExportConfigFingerprint, openOtlpPersistentQueue } from './queue.js';

interface SplitBatch {
  readonly request: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
}

interface SplitResult {
  readonly batches: readonly SplitBatch[];
  readonly diagnostics: readonly ExportMappingLoss[];
}

function emptyFlush(): ExporterFlushReport {
  return {
    contractVersion: otelExportContractVersion,
    deliveries: [],
    pendingCount: 0,
    deadlineExceeded: false,
  };
}

function failedFlush(config: OtelExportConfig, message: string): ExporterFlushReport {
  return {
    contractVersion: otelExportContractVersion,
    deliveries: [
      {
        state: 'not_queued',
        reliableState: 'configuration_blocked',
        targetAlias: config.targetAlias,
        attempted: false,
        acceptedSpanCount: 0,
        rejectedSpanCount: 0,
        attempts: 0,
        message,
      },
    ],
    pendingCount: 0,
    deadlineExceeded: false,
  };
}

function encodedBytes(request: OtlpExportTraceServiceRequest): number {
  return Buffer.byteLength(JSON.stringify(request), 'utf8');
}

/** Preserves resource/scope boundaries and input order while enforcing both limits. */
function splitRequest(
  request: OtlpExportTraceServiceRequest,
  spanLimit: number,
  byteLimit: number,
): SplitResult {
  const batches: SplitBatch[] = [];
  let rejectedSpanCount = 0;
  for (const resourceSpans of request.resourceSpans) {
    for (const scopeSpans of resourceSpans.scopeSpans) {
      let spans: typeof scopeSpans.spans = [];
      const toRequest = (next: typeof scopeSpans.spans): OtlpExportTraceServiceRequest => ({
        resourceSpans: [
          {
            resource: resourceSpans.resource,
            scopeSpans: [{ scope: scopeSpans.scope, spans: next }],
          },
        ],
      });
      const commit = (): void => {
        if (spans.length === 0) return;
        batches.push({ request: toRequest(spans), spanCount: spans.length });
        spans = [];
      };
      for (const span of scopeSpans.spans) {
        const candidate = [...spans, span];
        if (candidate.length <= spanLimit && encodedBytes(toRequest(candidate)) <= byteLimit) {
          spans = candidate;
          continue;
        }
        commit();
        if (encodedBytes(toRequest([span])) > byteLimit) {
          rejectedSpanCount += 1;
          continue;
        }
        spans = [span];
      }
      commit();
    }
  }
  return {
    batches,
    diagnostics:
      rejectedSpanCount === 0
        ? []
        : [
            {
              code: 'span_rejected',
              count: rejectedSpanCount,
              message:
                'One or more encoded spans exceed the configured batch byte limit and were not queued.',
            },
          ],
  };
}

function canonicalJson(value: unknown, ancestors = new Set<unknown>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '"[undefined]"';
  if (ancestors.has(value)) return '"[circular]"';
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function reliableState(delivery: ExportDeliveryReport): ReliableDeliveryState {
  if (delivery.reliableState !== undefined) return delivery.reliableState;
  switch (delivery.state) {
    case 'accepted':
      return 'accepted';
    case 'retryable':
      return 'retry_scheduled';
    case 'rejected':
      return 'permanently_rejected';
    case 'exhausted':
      return 'retry_exhausted';
    case 'unknown_delivery':
      return 'unknown_delivery';
    case 'queued':
      return 'pending';
    default:
      return 'not_sent';
  }
}

function isFinal(state: ReliableDeliveryState): boolean {
  return (
    state === 'accepted' ||
    state === 'accepted_with_warnings' ||
    state === 'partially_rejected' ||
    state === 'permanently_rejected' ||
    state === 'retry_exhausted' ||
    state === 'unknown_delivery'
  );
}

function reportState(batches: readonly DeliveryRecordBatch[]): ReliableDeliveryState {
  const states = batches.map((batch) => batch.state);
  if (states.length === 0) return 'not_sent';
  if (states.some((state) => state === 'unknown_delivery')) return 'unknown_delivery';
  if (states.some((state) => state === 'partially_rejected')) return 'partially_rejected';
  if (states.some((state) => state === 'permanently_rejected')) return 'permanently_rejected';
  if (states.some((state) => state === 'retry_exhausted')) return 'retry_exhausted';
  if (states.some((state) => state === 'pending' || state === 'retry_scheduled')) return 'pending';
  if (states.every((state) => state === 'accepted_with_warnings')) return 'accepted_with_warnings';
  if (states.every((state) => state === 'accepted' || state === 'accepted_with_warnings')) {
    return 'accepted';
  }
  if (states.some((state) => state === 'configuration_blocked')) return 'configuration_blocked';
  return 'not_sent';
}

function reportFor(
  record: DeliveryRecord,
  diagnostics: readonly ExportMappingLoss[] = [],
): ReliableExportDeliveryReport {
  const batches: ReliableBatchDeliveryReport[] = record.batches.map((batch) => ({
    identity: { ...record.identity, batchId: batch.batchId },
    state: batch.state,
    attempted: batch.attempts > 0,
    acceptedSpanCount:
      batch.state === 'accepted' || batch.state === 'accepted_with_warnings' ? batch.spanCount : 0,
    rejectedSpanCount:
      batch.state === 'partially_rejected' || batch.state === 'permanently_rejected'
        ? batch.spanCount
        : 0,
    attempts: batch.attempts,
    ...(batch.message === undefined ? {} : { message: batch.message }),
  }));
  return {
    reliableDeliveryContractVersion: otelExportReliableDeliveryContractVersion,
    sourceRunId: record.sourceRunId,
    state: reportState(record.batches),
    batches,
    pendingBatchCount: record.batches.filter((batch) => !isFinal(batch.state)).length,
    pendingSpanCount: record.batches
      .filter((batch) => !isFinal(batch.state))
      .reduce((total, batch) => total + batch.spanCount, 0),
    unknownDeliveryBatchCount: record.batches.filter((batch) => batch.state === 'unknown_delivery')
      .length,
    diagnostics,
  };
}

function rejectedOnlyReport(
  snapshot: ExportSnapshotInput,
  diagnostics: readonly ExportMappingLoss[],
): ReliableExportDeliveryReport {
  return {
    reliableDeliveryContractVersion: otelExportReliableDeliveryContractVersion,
    sourceRunId: snapshot.manifest.run_id,
    state: 'not_sent',
    batches: [],
    pendingBatchCount: 0,
    pendingSpanCount: 0,
    unknownDeliveryBatchCount: 0,
    diagnostics,
  };
}

/**
 * Creates the durable snapshot-to-OTLP exporter. It owns its queue and the
 * adjacent delivery-intent journal; shutdown rejects future snapshots and
 * shares one final flush between repeated callers.
 */
export function createOtlpExporter(config: OtelExportConfig): ReliableOtlpExporter {
  const client = createOtlpHttpClient(config);
  const configFingerprint = createOtelExportConfigFingerprint(config);
  const identity: Omit<ExportBatchIdentity, 'batchId'> = {
    targetAlias: config.targetAlias,
    destinationIdentity: config.destinationIdentity ?? config.targetAlias,
    destinationGeneration: config.destinationGeneration ?? 'legacy-1',
    reliableDeliveryContractVersion: otelExportReliableDeliveryContractVersion,
    mappingVersion: 'otlp-json-mapping-2',
    queueVersion: 'otlp-persistent-queue-2',
    contentPolicy: config.contentPolicy ?? 'metadata-only',
    encoding: 'otlp-http-json',
    targetFingerprint: configFingerprint,
  };
  const records =
    config.queueDir === undefined || config.queueDir.trim() === ''
      ? undefined
      : new DeliveryRecordStore(config.queueDir);
  let queuePromise: Promise<OtlpPersistentQueue> | undefined;
  let background: Promise<void> = Promise.resolve();
  let completedBackgroundDeliveries: ExportDeliveryReport[] = [];
  let backgroundDeadlineExceeded = false;
  let acceptingSnapshots = true;
  let shutdownPromise: Promise<ExporterFlushReport> | undefined;

  const queue = (): Promise<OtlpPersistentQueue> => {
    queuePromise ??= openOtlpPersistentQueue({
      queueDir: config.queueDir ?? '',
      targetAlias: config.targetAlias,
      configFingerprint,
      ...(config.destinationIdentity === undefined
        ? {}
        : { destinationIdentity: config.destinationIdentity }),
      ...(config.destinationGeneration === undefined
        ? {}
        : { destinationGeneration: config.destinationGeneration }),
      contentPolicy: config.contentPolicy ?? 'metadata-only',
      ...(config.retryMaxAttempts === undefined
        ? {}
        : { retryMaxAttempts: config.retryMaxAttempts }),
      ...(config.retryBudgetMs === undefined ? {} : { retryBudgetMs: config.retryBudgetMs }),
      ...(config.queueMaxEntries === undefined ? {} : { maxEntries: config.queueMaxEntries }),
      ...(config.queueMaxBytes === undefined ? {} : { maxBytes: config.queueMaxBytes }),
      ...(config.queueRetentionMs === undefined ? {} : { retentionMs: config.queueRetentionMs }),
    });
    return queuePromise;
  };

  const settleReports = async (deliveries: readonly ExportDeliveryReport[]): Promise<void> => {
    if (records === undefined || deliveries.length === 0) return;
    const byId = new Map(
      deliveries.flatMap((delivery) =>
        delivery.batchId === undefined ? [] : [[delivery.batchId, delivery] as const],
      ),
    );
    for (const record of await records.list()) {
      if (record.identity.targetFingerprint !== configFingerprint) continue;
      const next = record.batches.map((batch) => {
        const delivery = byId.get(batch.batchId);
        if (delivery === undefined) return batch;
        return {
          ...batch,
          state: reliableState(delivery),
          attempts: batch.attempts + delivery.attempts,
          updatedAt: Date.now(),
          ...(delivery.message === undefined ? {} : { message: delivery.message }),
        };
      });
      if (next.some((batch, index) => batch !== record.batches[index]))
        await records.update(record, next);
    }
  };

  const rememberBackgroundReport = async (report: ExporterFlushReport): Promise<void> => {
    backgroundDeadlineExceeded ||= report.deadlineExceeded;
    completedBackgroundDeliveries = [...completedBackgroundDeliveries, ...report.deliveries].slice(
      -128,
    );
    await settleReports(report.deliveries);
  };

  const scheduleFlush = (): void => {
    background = background
      .then(async () => {
        const report = await (await queue()).flush(client);
        await rememberBackgroundReport(report);
      })
      .catch(async () => {
        await rememberBackgroundReport(
          failedFlush(config, 'The persistent OTLP queue could not be flushed in the background.'),
        );
      });
  };

  const enqueueRecord = async (record: DeliveryRecord): Promise<DeliveryRecord> => {
    if (records === undefined) return record;
    const opened = await queue();
    const next: DeliveryRecordBatch[] = [];
    for (const batch of record.batches) {
      if (isFinal(batch.state)) {
        next.push(batch);
        continue;
      }
      const delivery = await opened.enqueue({
        batchId: batch.batchId,
        request: batch.request,
        spanCount: batch.spanCount,
        sourceSnapshotId: record.sourceRunId,
      });
      next.push({
        ...batch,
        state: reliableState(delivery),
        attempts: batch.attempts + delivery.attempts,
        updatedAt: Date.now(),
        ...(delivery.message === undefined ? {} : { message: delivery.message }),
      });
    }
    return records.update(record, next);
  };

  const resume = async (): Promise<readonly ReliableExportDeliveryReport[]> => {
    if (records === undefined) return [];
    const recovered: ReliableExportDeliveryReport[] = [];
    for (const record of await records.list()) {
      if (record.identity.targetFingerprint !== configFingerprint) continue;
      const queued = await enqueueRecord(record);
      if (queued.batches.some((batch) => batch.state === 'pending')) scheduleFlush();
      recovered.push(reportFor(queued));
    }
    return recovered;
  };

  return {
    contractVersion: otelExportReliableDeliveryContractVersion,
    async exportSnapshot(snapshot): Promise<ReliableExportDeliveryReport> {
      if (!acceptingSnapshots) {
        return rejectedOnlyReport(snapshot, [
          {
            code: 'span_rejected',
            message: 'The OTLP exporter has already shut down and accepts no new snapshots.',
          },
        ]);
      }
      if (records === undefined) {
        return rejectedOnlyReport(snapshot, [
          {
            code: 'span_rejected',
            message: 'OTLP export requires a persistent queueDir to guarantee recovery.',
          },
        ]);
      }
      const mapping = mapSnapshotToOtlp(snapshot, {
        ...(config.contentPolicy === undefined ? {} : { contentPolicy: config.contentPolicy }),
        ...(config.mappingLimits === undefined ? {} : { limits: config.mappingLimits }),
        serviceName: config.serviceName,
      });
      const spanLimit = Math.max(1, Math.floor(config.batchSpanLimit ?? 512));
      const byteLimit = Math.max(
        1,
        Math.floor(
          config.batchMaxBytes ??
            config.mappingLimits?.maxRequestBytes ??
            defaultOtelExportMappingLimits.maxRequestBytes,
        ),
      );
      const split = splitRequest(mapping.request, spanLimit, byteLimit);
      const diagnostics = [...mapping.report.losses, ...split.diagnostics];
      if (split.batches.length === 0) return rejectedOnlyReport(snapshot, diagnostics);
      const snapshotFingerprint = fingerprint({
        manifest: snapshot.manifest,
        events: snapshot.events,
      });
      const record = await records.register({
        sourceRunId: snapshot.manifest.run_id,
        identity,
        batches: split.batches.map((batch, position) => ({
          ...batch,
          batchId: `batch-${fingerprint({
            snapshotFingerprint,
            identity,
            mappingLimits: config.mappingLimits ?? {},
            spanLimit,
            byteLimit,
            position,
            request: batch.request,
          })}`,
        })),
      });
      try {
        const queued = await enqueueRecord(record);
        if (queued.batches.some((batch) => batch.state === 'pending')) scheduleFlush();
        return reportFor(queued, diagnostics);
      } catch {
        return reportFor(record, [
          ...diagnostics,
          {
            code: 'span_rejected',
            message:
              'The export intent was saved, but queue insertion failed; resume from this configured queue directory.',
          },
        ]);
      }
    },
    resume,
    async flush(options = {}): Promise<ExporterFlushReport> {
      await background;
      if (records === undefined) return emptyFlush();
      try {
        const current = await (await queue()).flush(client, options);
        await settleReports(current.deliveries);
        const deliveries = [...completedBackgroundDeliveries, ...current.deliveries];
        const deadlineExceeded = current.deadlineExceeded || backgroundDeadlineExceeded;
        completedBackgroundDeliveries = [];
        backgroundDeadlineExceeded = false;
        return { ...current, deliveries, deadlineExceeded };
      } catch {
        return failedFlush(config, 'The persistent OTLP queue could not be flushed.');
      }
    },
    shutdown(options = {}): Promise<ExporterFlushReport> {
      acceptingSnapshots = false;
      shutdownPromise ??= (async () => {
        await background;
        if (records === undefined) return emptyFlush();
        try {
          const current = await (await queue()).shutdown(client, options);
          await settleReports(current.deliveries);
          const deliveries = [...completedBackgroundDeliveries, ...current.deliveries];
          const deadlineExceeded = current.deadlineExceeded || backgroundDeadlineExceeded;
          completedBackgroundDeliveries = [];
          backgroundDeadlineExceeded = false;
          return { ...current, deliveries, deadlineExceeded };
        } catch {
          return failedFlush(config, 'The persistent OTLP queue could not be shut down.');
        }
      })();
      return shutdownPromise;
    },
  };
}
