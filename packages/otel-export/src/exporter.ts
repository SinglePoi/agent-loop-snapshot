import {
  otelExportContractVersion,
  type ExportDeliveryReport,
  type ExporterFlushReport,
  type OtelExportConfig,
  type OtlpExporter,
  type OtlpExportTraceServiceRequest,
  type OtlpPersistentQueue,
} from './index.js';
import { createOtlpHttpClient } from './http-client.js';
import { mapSnapshotToOtlp } from './mapper.js';
import { createOtelExportConfigFingerprint, openOtlpPersistentQueue } from './queue.js';

function notQueued(config: OtelExportConfig, message: string): ExportDeliveryReport {
  return {
    state: 'not_queued',
    targetAlias: config.targetAlias,
    attempted: false,
    acceptedSpanCount: 0,
    rejectedSpanCount: 0,
    attempts: 0,
    message,
  };
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
    deliveries: [notQueued(config, message)],
    pendingCount: 0,
    deadlineExceeded: false,
  };
}

function splitRequest(
  request: OtlpExportTraceServiceRequest,
  spanLimit: number,
): readonly { readonly request: OtlpExportTraceServiceRequest; readonly spanCount: number }[] {
  const batches: Array<{ request: OtlpExportTraceServiceRequest; spanCount: number }> = [];
  for (const resourceSpans of request.resourceSpans) {
    for (const scopeSpans of resourceSpans.scopeSpans) {
      for (let offset = 0; offset < scopeSpans.spans.length; offset += spanLimit) {
        const spans = scopeSpans.spans.slice(offset, offset + spanLimit);
        batches.push({
          request: {
            resourceSpans: [
              {
                resource: resourceSpans.resource,
                scopeSpans: [{ scope: scopeSpans.scope, spans }],
              },
            ],
          },
          spanCount: spans.length,
        });
      }
    }
  }
  return batches;
}

/**
 * Creates the EXP-05 bridge between a committed local snapshot and the
 * already-filtered persistent OTLP queue. Calling exportSnapshot only waits
 * for the local queue commit; delivery runs in the background and can later
 * be bounded by flush() or shutdown().
 */
export function createOtlpExporter(config: OtelExportConfig): OtlpExporter {
  const client = createOtlpHttpClient(config);
  let queuePromise: Promise<OtlpPersistentQueue> | undefined;
  let background: Promise<void> = Promise.resolve();
  const maxCompletedBackgroundDeliveries = 128;
  let completedBackgroundDeliveries: ExportDeliveryReport[] = [];
  let backgroundDeadlineExceeded = false;

  const rememberBackgroundReport = (report: ExporterFlushReport): void => {
    backgroundDeadlineExceeded ||= report.deadlineExceeded;
    completedBackgroundDeliveries = [...completedBackgroundDeliveries, ...report.deliveries].slice(
      -maxCompletedBackgroundDeliveries,
    );
  };

  const takeBackgroundReport = (): ExporterFlushReport => {
    const report: ExporterFlushReport = {
      contractVersion: otelExportContractVersion,
      deliveries: completedBackgroundDeliveries,
      pendingCount: 0,
      deadlineExceeded: backgroundDeadlineExceeded,
    };
    completedBackgroundDeliveries = [];
    backgroundDeadlineExceeded = false;
    return report;
  };

  const queue = (): Promise<OtlpPersistentQueue> => {
    queuePromise ??= openOtlpPersistentQueue({
      queueDir: config.queueDir ?? '',
      targetAlias: config.targetAlias,
      configFingerprint: createOtelExportConfigFingerprint(config),
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

  const scheduleFlush = (): void => {
    background = background
      .then(async () => {
        const opened = await queue();
        rememberBackgroundReport(await opened.flush(client));
      })
      // A queued delivery failure is observable through later flush/shutdown
      // and must never become an unhandled rejection in an agent process.
      .catch(() => {
        rememberBackgroundReport(
          failedFlush(config, 'The persistent OTLP queue could not be flushed in the background.'),
        );
      });
  };

  return {
    contractVersion: otelExportContractVersion,
    async exportSnapshot(snapshot): Promise<ExportDeliveryReport> {
      if (config.queueDir === undefined || config.queueDir.trim() === '') {
        return notQueued(config, 'OTLP export requires a persistent queueDir.');
      }
      const mapping = mapSnapshotToOtlp(snapshot, {
        ...(config.contentPolicy === undefined ? {} : { contentPolicy: config.contentPolicy }),
        ...(config.mappingLimits === undefined ? {} : { limits: config.mappingLimits }),
        serviceName: config.serviceName,
      });
      try {
        const opened = await queue();
        const spanLimit = Math.max(1, Math.floor(config.batchSpanLimit ?? 512));
        let lastDelivery = notQueued(config, 'The OTLP snapshot contains no spans to send.');
        let queuedAny = false;
        for (const batch of splitRequest(mapping.request, spanLimit)) {
          lastDelivery = await opened.enqueue(batch);
          if (lastDelivery.state !== 'queued') {
            if (queuedAny) scheduleFlush();
            return lastDelivery;
          }
          queuedAny = true;
        }
        if (queuedAny) scheduleFlush();
        return lastDelivery;
      } catch {
        return notQueued(
          config,
          'The export batch could not be committed to the persistent queue.',
        );
      }
    },
    async flush(options = {}): Promise<ExporterFlushReport> {
      await background;
      if (config.queueDir === undefined || config.queueDir.trim() === '') return emptyFlush();
      try {
        const backgroundReport = takeBackgroundReport();
        const current = await (await queue()).flush(client, options);
        return {
          ...current,
          deliveries: [...backgroundReport.deliveries, ...current.deliveries],
          deadlineExceeded: current.deadlineExceeded || backgroundReport.deadlineExceeded,
        };
      } catch {
        return failedFlush(config, 'The persistent OTLP queue could not be flushed.');
      }
    },
    async shutdown(options = {}): Promise<ExporterFlushReport> {
      await background;
      if (config.queueDir === undefined || config.queueDir.trim() === '') return emptyFlush();
      try {
        const backgroundReport = takeBackgroundReport();
        const current = await (await queue()).shutdown(client, options);
        return {
          ...current,
          deliveries: [...backgroundReport.deliveries, ...current.deliveries],
          deadlineExceeded: current.deadlineExceeded || backgroundReport.deadlineExceeded,
        };
      } catch {
        return failedFlush(config, 'The persistent OTLP queue could not be shut down.');
      }
    },
  };
}
