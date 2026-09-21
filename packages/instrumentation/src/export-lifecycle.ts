import {
  isReliableExportDeliveryReport,
  type ExportSnapshotInput,
  type ExporterFlushReport,
  type OtlpExporter,
} from '@agent-loop-snapshot/otel-export';

import { runWithInstrumentationSuppression } from './context.js';

export type ExporterOwnership = 'owned' | 'shared';

export interface ExportLifecycleOptions {
  readonly exporters: readonly OtlpExporter[];
  readonly ownership?: ExporterOwnership;
  readonly maxConcurrentExports?: number;
  readonly maxPendingExports?: number;
  readonly report: (message: string) => void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : Math.floor(value);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : 'unknown error';
}

function exportFailureMessage(
  delivery: Awaited<ReturnType<OtlpExporter['exportSnapshot']>>,
): string | undefined {
  if (isReliableExportDeliveryReport(delivery)) {
    return delivery.state === 'not_sent' || delivery.state === 'configuration_blocked'
      ? (delivery.diagnostics[0]?.message ?? delivery.state)
      : undefined;
  }
  return delivery.state === 'not_queued'
    ? (delivery.message ?? 'The committed snapshot could not be queued for OTLP export.')
    : undefined;
}

export function incompleteExportMessage(
  action: 'flush' | 'shutdown',
  report: ExporterFlushReport,
): string | undefined {
  const incomplete = report.deliveries.find((delivery) => delivery.state !== 'accepted');
  if (incomplete !== undefined) {
    return `OTLP export ${action} did not complete: ${incomplete.message ?? incomplete.state}.`;
  }
  if (report.deadlineExceeded) return `OTLP export ${action} exceeded its deadline.`;
  if (report.pendingCount > 0) {
    return `OTLP export ${action} left ${String(report.pendingCount)} batch(es) queued.`;
  }
  return undefined;
}

/**
 * Bounds the local, durable-registration part of exporting. `queueSnapshot`
 * waits for intent persistence, never for remote delivery; exporter background
 * flushes remain owned by the exporter itself.
 */
export class ExportLifecycle {
  private readonly exporters: readonly OtlpExporter[];
  private readonly ownership: ExporterOwnership;
  private readonly maxConcurrentExports: number;
  private readonly maxPendingExports: number;
  private readonly report: (message: string) => void;
  private readonly pending = new Set<Promise<void>>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(options: ExportLifecycleOptions) {
    this.exporters = [...new Set(options.exporters)];
    this.ownership = options.ownership ?? 'owned';
    this.maxConcurrentExports = positiveInteger(options.maxConcurrentExports, 2);
    this.maxPendingExports = positiveInteger(options.maxPendingExports, 32);
    this.report = options.report;
  }

  async queueSnapshot(snapshot: ExportSnapshotInput): Promise<void> {
    await Promise.all(this.exporters.map((exporter) => this.queueWithExporter(exporter, snapshot)));
  }

  async flush(options: { readonly deadlineMs?: number } = {}): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await Promise.all(
      this.exporters.map(async (exporter) => {
        try {
          const incomplete = incompleteExportMessage('flush', await exporter.flush(options));
          if (incomplete !== undefined) this.report(incomplete);
        } catch (error) {
          this.report(`Could not flush OTLP export: ${safeErrorMessage(error)}`);
        }
      }),
    );
  }

  async shutdown(options: { readonly deadlineMs?: number } = {}): Promise<void> {
    await Promise.allSettled([...this.pending]);
    if (this.ownership === 'shared') return;
    await Promise.all(
      this.exporters.map(async (exporter) => {
        try {
          const incomplete = incompleteExportMessage('shutdown', await exporter.shutdown(options));
          if (incomplete !== undefined) this.report(incomplete);
        } catch (error) {
          this.report(`Could not shut down OTLP export: ${safeErrorMessage(error)}`);
        }
      }),
    );
  }

  private async queueWithExporter(
    exporter: OtlpExporter,
    snapshot: ExportSnapshotInput,
  ): Promise<void> {
    if (this.pending.size >= this.maxPendingExports) {
      this.report(
        `OTLP export registration capacity (${String(this.maxPendingExports)}) is exhausted; the committed snapshot remains local and was not registered for automatic export.`,
      );
      return;
    }
    const pending = this.register(exporter, snapshot);
    this.pending.add(pending);
    try {
      await pending;
    } finally {
      this.pending.delete(pending);
    }
  }

  private async register(exporter: OtlpExporter, snapshot: ExportSnapshotInput): Promise<void> {
    await this.acquireSlot();
    try {
      const delivery = await runWithInstrumentationSuppression(() =>
        exporter.exportSnapshot(snapshot),
      );
      const failure = exportFailureMessage(delivery);
      if (failure !== undefined) this.report(failure);
    } catch (error) {
      this.report(`Could not queue committed snapshot for OTLP export: ${safeErrorMessage(error)}`);
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrentExports) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
