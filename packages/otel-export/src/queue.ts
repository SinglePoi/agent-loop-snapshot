import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { otelExportContractVersion } from './index.js';
import type {
  ExportDeliveryReport,
  ExporterFlushReport,
  OtelExportConfig,
  OtlpExportTraceServiceRequest,
  OtlpHttpClient,
  OtlpPersistentQueue,
  OtlpPersistentQueueOptions,
  OtlpQueueBatch,
  OtlpQueueFlushOptions,
  OtlpQueueInspection,
} from './index.js';

const queueSchemaVersion = 'otel-export-queue-1.0' as const;
const defaultMaxEntries = 1_000;
const defaultMaxBytes = 64 * 1024 * 1024;
const defaultRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const defaultLockStaleMs = 5 * 60 * 1_000;

interface QueueEntry {
  readonly schemaVersion: typeof queueSchemaVersion;
  readonly batchId: string;
  readonly targetAlias: string;
  readonly configFingerprint: string;
  readonly request: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
}

interface StoredEntry {
  readonly entry: QueueEntry;
  readonly path: string;
  readonly bytes: number;
}

interface ScanResult {
  readonly entries: readonly StoredEntry[];
  readonly pendingBytes: number;
  readonly expiredCount: number;
  readonly foreignConfigCount: number;
}

export class OtlpQueueError extends Error {
  constructor(
    readonly code: 'QUEUE_LOCKED' | 'QUEUE_LOCK_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'OtlpQueueError';
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeBatchId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return (
    isRecord(value) &&
    value.schemaVersion === queueSchemaVersion &&
    isSafeBatchId(value.batchId) &&
    typeof value.targetAlias === 'string' &&
    typeof value.configFingerprint === 'string' &&
    isRecord(value.request) &&
    Array.isArray(value.request.resourceSpans) &&
    typeof value.spanCount === 'number' &&
    Number.isSafeInteger(value.spanCount) &&
    value.spanCount >= 0 &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.attempts === 'number' &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/** Computes a stable fingerprint without resolving or embedding credential values. */
export function createOtelExportConfigFingerprint(config: OtelExportConfig): string {
  const headersEnv = Object.fromEntries(
    Object.entries(config.headersEnv ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const publicConfig = {
    targetAlias: config.targetAlias,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.endpointEnv === undefined ? {} : { endpointEnv: config.endpointEnv }),
    headersEnv,
    serviceName: config.serviceName,
    contentPolicy: config.contentPolicy ?? 'metadata-only',
  };
  return createHash('sha256').update(canonicalJson(publicConfig)).digest('hex');
}

async function atomicWrite(path: string, value: unknown, allowExisting = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (allowExisting) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function decorate(delivery: ExportDeliveryReport, entry: QueueEntry): ExportDeliveryReport {
  return { ...delivery, batchId: entry.batchId, targetAlias: entry.targetAlias };
}

class PersistentQueue implements OtlpPersistentQueue {
  private readonly root: string;
  private readonly entriesDirectory: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly lockStaleMs: number;

  constructor(private readonly options: OtlpPersistentQueueOptions) {
    this.root = resolve(options.queueDir);
    this.entriesDirectory = join(this.root, 'entries');
    this.lockPath = join(this.root, 'consumer.lock');
    this.now = options.now ?? Date.now;
    this.maxEntries = positive(options.maxEntries, defaultMaxEntries);
    this.maxBytes = positive(options.maxBytes, defaultMaxBytes);
    this.retentionMs = positive(options.retentionMs, defaultRetentionMs);
    this.lockStaleMs = positive(options.lockStaleMs, defaultLockStaleMs);
  }

  async initialize(): Promise<void> {
    await mkdir(this.entriesDirectory, { recursive: true });
  }

  async enqueue(batch: OtlpQueueBatch): Promise<ExportDeliveryReport> {
    try {
      return await this.withLock(async () => {
        const scan = await this.scan(true);
        const batchId = batch.batchId ?? randomUUID();
        if (
          !isSafeBatchId(batchId) ||
          !Number.isSafeInteger(batch.spanCount) ||
          batch.spanCount < 0
        ) {
          return this.notQueued('The queue batch is invalid.');
        }
        const entry: QueueEntry = {
          schemaVersion: queueSchemaVersion,
          batchId,
          targetAlias: this.options.targetAlias,
          configFingerprint: this.options.configFingerprint,
          request: batch.request,
          spanCount: batch.spanCount,
          createdAt: this.now(),
          expiresAt: this.now() + this.retentionMs,
          attempts: 0,
        };
        const bytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
        if (scan.entries.length >= this.maxEntries || scan.pendingBytes + bytes > this.maxBytes) {
          return this.notQueued('The persistent export queue is at capacity.');
        }
        try {
          await atomicWrite(this.entryPath(batchId), entry);
        } catch {
          return this.notQueued('The export batch could not be committed to the persistent queue.');
        }
        return {
          state: 'queued',
          targetAlias: this.options.targetAlias,
          batchId,
          attempted: false,
          acceptedSpanCount: 0,
          rejectedSpanCount: 0,
          attempts: 0,
        };
      });
    } catch {
      return this.notQueued('The persistent export queue is currently unavailable.');
    }
  }

  async inspect(): Promise<OtlpQueueInspection> {
    const scan = await this.scan(false);
    return {
      pendingCount: scan.entries.length,
      pendingBytes: scan.pendingBytes,
      expiredCount: scan.expiredCount,
      foreignConfigCount: scan.foreignConfigCount,
    };
  }

  flush(client: OtlpHttpClient, options: OtlpQueueFlushOptions = {}): Promise<ExporterFlushReport> {
    return this.flushInternal(client, options);
  }

  shutdown(
    client: OtlpHttpClient,
    options: OtlpQueueFlushOptions = {},
  ): Promise<ExporterFlushReport> {
    return this.flushInternal(client, options);
  }

  private async flushInternal(
    client: OtlpHttpClient,
    options: OtlpQueueFlushOptions,
  ): Promise<ExporterFlushReport> {
    return this.withLock(async () => {
      const startedAt = this.now();
      const deadlineMs =
        options.deadlineMs === undefined
          ? undefined
          : positive(options.deadlineMs, Number.MAX_SAFE_INTEGER);
      const deliveries: ExportDeliveryReport[] = [];
      let deadlineExceeded = false;
      const scan = await this.scan(true);
      const eligible = scan.entries
        .filter(
          ({ entry }) =>
            entry.targetAlias === this.options.targetAlias &&
            entry.configFingerprint === this.options.configFingerprint,
        )
        .sort(
          (left, right) =>
            left.entry.createdAt - right.entry.createdAt ||
            left.entry.batchId.localeCompare(right.entry.batchId),
        );

      for (const stored of eligible) {
        const remaining =
          deadlineMs === undefined ? undefined : deadlineMs - (this.now() - startedAt);
        if (remaining !== undefined && remaining <= 0) {
          deadlineExceeded = true;
          break;
        }
        const controller = new AbortController();
        const timeout =
          remaining === undefined
            ? undefined
            : setTimeout(
                () => controller.abort(new Error('Queue flush deadline exceeded.')),
                remaining,
              );
        let delivery: ExportDeliveryReport;
        try {
          delivery = await client.send(stored.entry.request, stored.entry.spanCount, {
            signal: controller.signal,
          });
        } catch {
          delivery = {
            state: 'unknown_delivery',
            targetAlias: stored.entry.targetAlias,
            attempted: true,
            acceptedSpanCount: 0,
            rejectedSpanCount: 0,
            attempts: 1,
            message: 'The OTLP sender ended without a delivery report.',
          };
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        const decorated = decorate(delivery, stored.entry);
        deliveries.push(decorated);
        if (decorated.state === 'accepted' || decorated.state === 'rejected') {
          await unlink(stored.path).catch(() => undefined);
        } else {
          const updated: QueueEntry = {
            ...stored.entry,
            attempts: stored.entry.attempts + decorated.attempts,
          };
          await atomicWrite(stored.path, updated, true);
        }
        if (deadlineMs !== undefined && this.now() - startedAt >= deadlineMs) {
          deadlineExceeded = true;
          break;
        }
      }

      const pending = await this.scan(false);
      return {
        contractVersion: otelExportContractVersion,
        deliveries,
        pendingCount: pending.entries.length,
        deadlineExceeded,
      };
    });
  }

  private notQueued(message: string): ExportDeliveryReport {
    return {
      state: 'not_queued',
      targetAlias: this.options.targetAlias,
      attempted: false,
      acceptedSpanCount: 0,
      rejectedSpanCount: 0,
      attempts: 0,
      message,
    };
  }

  private entryPath(batchId: string): string {
    return join(this.entriesDirectory, `${batchId}.json`);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireLock();
    try {
      return await operation();
    } finally {
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, createdAt: this.now() })}\n`,
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new OtlpQueueError(
            'QUEUE_LOCK_FAILED',
            'Could not acquire the persistent queue lock.',
          );
        }
        try {
          const lock = await stat(this.lockPath);
          if (this.now() - lock.mtimeMs > this.lockStaleMs) {
            await unlink(this.lockPath);
            continue;
          }
        } catch {
          continue;
        }
        throw new OtlpQueueError(
          'QUEUE_LOCKED',
          'Another process is flushing this persistent queue.',
        );
      }
    }
    throw new OtlpQueueError('QUEUE_LOCKED', 'Another process is flushing this persistent queue.');
  }

  private async scan(removeExpired: boolean): Promise<ScanResult> {
    await this.initialize();
    const entries: StoredEntry[] = [];
    let pendingBytes = 0;
    let expiredCount = 0;
    let foreignConfigCount = 0;
    const files = await readdir(this.entriesDirectory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const path = join(this.entriesDirectory, file.name);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(raw) as unknown;
      } catch {
        continue;
      }
      if (!isQueueEntry(entry)) continue;
      const bytes = Buffer.byteLength(raw);
      if (entry.expiresAt <= this.now()) {
        expiredCount += 1;
        if (removeExpired) await unlink(path).catch(() => undefined);
        continue;
      }
      pendingBytes += bytes;
      if (
        entry.targetAlias !== this.options.targetAlias ||
        entry.configFingerprint !== this.options.configFingerprint
      ) {
        foreignConfigCount += 1;
      }
      entries.push({ entry, path, bytes });
    }
    return { entries, pendingBytes, expiredCount, foreignConfigCount };
  }
}

export async function openOtlpPersistentQueue(
  options: OtlpPersistentQueueOptions,
): Promise<OtlpPersistentQueue> {
  const queue = new PersistentQueue(options);
  await queue.initialize();
  return queue;
}
