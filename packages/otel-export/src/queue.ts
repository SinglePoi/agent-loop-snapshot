import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { otelExportContractVersion } from './index.js';
import type {
  ExportDeliveryReport,
  ExporterFlushReport,
  OtlpExportTraceServiceRequest,
  OtlpHttpClient,
  OtlpPersistentQueue,
  OtlpPersistentQueueOptions,
  OtlpQueueBatch,
  OtlpQueueFlushOptions,
  OtlpQueueInspection,
  ReliableDeliveryState,
} from './index.js';

export { createOtelExportConfigFingerprint } from './delivery-identity.js';

const queueSchemaVersion = 'otlp-persistent-queue-2' as const;
const archiveSchemaVersion = 'otlp-persistent-queue-archive-2' as const;
const leaseSchemaVersion = 'otlp-persistent-queue-lease-2' as const;
const metadataLockSchemaVersion = 'otlp-persistent-queue-metadata-lock-2' as const;
const defaultMaxEntries = 1_000;
const defaultMaxBytes = 64 * 1024 * 1024;
const defaultRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const defaultLeaseDurationMs = 30_000;
const defaultRetryMaxAttempts = 12;
const defaultRetryBudgetMs = 24 * 60 * 60 * 1_000;
const defaultMaxEntryBytes = 4 * 1024 * 1024;
const metadataLockDurationMs = 10_000;
const maxTimerMs = 2_147_483_647;

interface QueueIdentity {
  readonly targetAlias: string;
  readonly destinationIdentity: string;
  readonly destinationGeneration: string;
  readonly targetFingerprint: string;
  readonly mappingVersion: 'otlp-json-mapping-2';
  readonly contentPolicy: 'metadata-only' | 'redacted-content';
  readonly encoding: 'otlp-http-json';
}

interface QueueDeliveryState {
  readonly attempts: number;
  readonly firstAttemptAt?: number;
  readonly retryDeadlineAt?: number;
  readonly nextAttemptAt?: number;
  readonly lastState?: ReliableDeliveryState;
  readonly lastAttemptAt?: number;
}

interface QueueEntry {
  readonly schemaVersion: typeof queueSchemaVersion;
  readonly batchId: string;
  readonly identity: QueueIdentity;
  readonly request: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
  readonly sourceSnapshotId?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly delivery: QueueDeliveryState;
}

interface QueueArchive {
  readonly schemaVersion: typeof archiveSchemaVersion;
  readonly batchId: string;
  readonly identity: QueueIdentity;
  readonly spanCount: number;
  readonly sourceSnapshotId?: string;
  readonly createdAt: number;
  readonly archivedAt: number;
  readonly expiresAt: number;
  readonly finalState: ReliableDeliveryState;
  readonly attempts: number;
  readonly acceptedSpanCount: number;
  readonly rejectedSpanCount: number;
  readonly receiptAt?: number;
  readonly message?: string;
}

interface ConsumerLease {
  readonly schemaVersion: typeof leaseSchemaVersion;
  readonly ownerToken: string;
  readonly expiresAt: number;
}

interface MetadataLock {
  readonly schemaVersion: typeof metadataLockSchemaVersion;
  readonly ownerToken: string;
  readonly expiresAt: number;
}

interface StoredEntry {
  readonly entry: QueueEntry;
  readonly path: string;
  readonly bytes: number;
}

interface StorageUsage {
  readonly count: number;
  readonly bytes: number;
  readonly archiveCount: number;
  readonly archiveBytes: number;
  readonly quarantineCount: number;
  readonly quarantineBytes: number;
  readonly rejectedCount: number;
  readonly exhaustedCount: number;
  readonly unknownDeliveryCount: number;
}

interface EntryScan {
  readonly entries: readonly StoredEntry[];
  readonly expiredCount: number;
  readonly foreignConfigCount: number;
  readonly invalidCount: number;
}

export class OtlpQueueError extends Error {
  constructor(
    readonly code: 'QUEUE_LOCKED' | 'QUEUE_LOCK_FAILED' | 'QUEUE_LEASE_LOST',
    message: string,
  ) {
    super(message);
    this.name = 'OtlpQueueError';
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum = maxTimerMs,
): number {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved >= 1 && resolved <= maximum
    ? resolved
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeBatchId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[\r\n]/u.test(value)
  );
}

function isQueueIdentity(value: unknown): value is QueueIdentity {
  return (
    isRecord(value) &&
    isSafeIdentity(value.targetAlias) &&
    isSafeIdentity(value.destinationIdentity) &&
    isSafeIdentity(value.destinationGeneration) &&
    isSafeIdentity(value.targetFingerprint) &&
    value.mappingVersion === 'otlp-json-mapping-2' &&
    (value.contentPolicy === 'metadata-only' || value.contentPolicy === 'redacted-content') &&
    value.encoding === 'otlp-http-json'
  );
}

function isQueueDeliveryState(value: unknown): value is QueueDeliveryState {
  if (
    !isRecord(value) ||
    typeof value.attempts !== 'number' ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0
  ) {
    return false;
  }
  for (const key of [
    'firstAttemptAt',
    'retryDeadlineAt',
    'nextAttemptAt',
    'lastAttemptAt',
  ] as const) {
    if (
      value[key] !== undefined &&
      (!Number.isFinite(value[key]) || typeof value[key] !== 'number')
    ) {
      return false;
    }
  }
  return value.lastState === undefined || isReliableDeliveryState(value.lastState);
}

function isReliableDeliveryState(value: unknown): value is ReliableDeliveryState {
  return (
    value === 'not_sent' ||
    value === 'configuration_blocked' ||
    value === 'pending' ||
    value === 'accepted' ||
    value === 'accepted_with_warnings' ||
    value === 'partially_rejected' ||
    value === 'permanently_rejected' ||
    value === 'retry_scheduled' ||
    value === 'retry_exhausted' ||
    value === 'unknown_delivery'
  );
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return (
    isRecord(value) &&
    value.schemaVersion === queueSchemaVersion &&
    isSafeBatchId(value.batchId) &&
    isQueueIdentity(value.identity) &&
    isRecord(value.request) &&
    Array.isArray(value.request.resourceSpans) &&
    typeof value.spanCount === 'number' &&
    Number.isSafeInteger(value.spanCount) &&
    value.spanCount >= 0 &&
    (value.sourceSnapshotId === undefined || isSafeIdentity(value.sourceSnapshotId)) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    isQueueDeliveryState(value.delivery)
  );
}

function isArchive(value: unknown): value is QueueArchive {
  return (
    isRecord(value) &&
    value.schemaVersion === archiveSchemaVersion &&
    isSafeBatchId(value.batchId) &&
    isQueueIdentity(value.identity) &&
    typeof value.spanCount === 'number' &&
    Number.isSafeInteger(value.spanCount) &&
    value.spanCount >= 0 &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.archivedAt === 'number' &&
    Number.isFinite(value.archivedAt) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    isReliableDeliveryState(value.finalState) &&
    typeof value.attempts === 'number' &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    typeof value.acceptedSpanCount === 'number' &&
    Number.isSafeInteger(value.acceptedSpanCount) &&
    value.acceptedSpanCount >= 0 &&
    typeof value.rejectedSpanCount === 'number' &&
    Number.isSafeInteger(value.rejectedSpanCount) &&
    value.rejectedSpanCount >= 0
  );
}

function isLease(value: unknown): value is ConsumerLease {
  return (
    isRecord(value) &&
    value.schemaVersion === leaseSchemaVersion &&
    typeof value.ownerToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  );
}

function isMetadataLock(value: unknown): value is MetadataLock {
  return (
    isRecord(value) &&
    value.schemaVersion === metadataLockSchemaVersion &&
    typeof value.ownerToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  );
}

function safeMessage(state: ReliableDeliveryState): string | undefined {
  switch (state) {
    case 'accepted_with_warnings':
      return 'Collector accepted the batch with a sanitized warning.';
    case 'partially_rejected':
      return 'Collector partially rejected the batch; it was not automatically retried.';
    case 'permanently_rejected':
      return 'Collector permanently rejected the batch.';
    case 'retry_exhausted':
      return 'The persistent retry budget was exhausted.';
    case 'unknown_delivery':
      return 'The receiver outcome is unknown; a later manual retry may duplicate data.';
    default:
      return undefined;
  }
}

function reliableState(delivery: ExportDeliveryReport): ReliableDeliveryState {
  if (delivery.reliableState !== undefined) return delivery.reliableState;
  switch (delivery.state) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'permanently_rejected';
    case 'retryable':
      return 'retry_scheduled';
    case 'exhausted':
      return 'retry_exhausted';
    case 'unknown_delivery':
      return 'unknown_delivery';
    case 'queued':
      return 'pending';
    default:
      return 'configuration_blocked';
  }
}

function exportState(state: ReliableDeliveryState): ExportDeliveryReport['state'] {
  switch (state) {
    case 'accepted':
    case 'accepted_with_warnings':
      return 'accepted';
    case 'partially_rejected':
    case 'permanently_rejected':
      return 'rejected';
    case 'retry_scheduled':
      return 'retryable';
    case 'retry_exhausted':
      return 'exhausted';
    case 'unknown_delivery':
      return 'unknown_delivery';
    case 'pending':
      return 'queued';
    default:
      return 'not_queued';
  }
}

function deliveryIsFinal(state: ReliableDeliveryState): boolean {
  return (
    state === 'accepted' ||
    state === 'accepted_with_warnings' ||
    state === 'partially_rejected' ||
    state === 'permanently_rejected' ||
    state === 'retry_exhausted' ||
    state === 'unknown_delivery'
  );
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(path: string, maximumBytes: number): Promise<unknown | undefined> {
  let details;
  try {
    details = await lstat(path);
  } catch {
    return undefined;
  }
  if (!details.isFile() || details.size > maximumBytes) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function atomicWrite(
  path: string,
  temporaryDirectory: string,
  value: unknown,
  replace = false,
): Promise<void> {
  const temporary = join(temporaryDirectory, `${randomUUID()}.tmp`);
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

class PersistentQueue implements OtlpPersistentQueue {
  private readonly root: string;
  private readonly entriesDirectory: string;
  private readonly archiveDirectory: string;
  private readonly quarantineDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly metadataLockPath: string;
  private readonly leasePath: string;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly leaseDurationMs: number;
  private readonly retryMaxAttempts: number;
  private readonly retryBudgetMs: number;
  private readonly maxEntryBytes: number;
  private readonly identity: QueueIdentity;

  constructor(private readonly options: OtlpPersistentQueueOptions) {
    this.root = resolve(options.queueDir);
    this.entriesDirectory = join(this.root, 'entries');
    this.archiveDirectory = join(this.root, 'archive');
    this.quarantineDirectory = join(this.root, 'quarantine');
    this.temporaryDirectory = join(this.root, 'temporary');
    this.metadataLockPath = join(this.root, 'metadata.lock');
    this.leasePath = join(this.root, 'consumer.lease');
    this.now = options.now ?? Date.now;
    this.maxEntries = positiveInteger(options.maxEntries, defaultMaxEntries);
    this.maxBytes = positiveInteger(options.maxBytes, defaultMaxBytes);
    this.retentionMs = positiveInteger(options.retentionMs, defaultRetentionMs);
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? options.lockStaleMs,
      defaultLeaseDurationMs,
    );
    this.retryMaxAttempts = positiveInteger(
      options.retryMaxAttempts,
      defaultRetryMaxAttempts,
      10_000,
    );
    this.retryBudgetMs = positiveInteger(options.retryBudgetMs, defaultRetryBudgetMs);
    this.maxEntryBytes = positiveInteger(options.maxEntryBytes, defaultMaxEntryBytes);
    this.identity = {
      targetAlias: options.targetAlias,
      destinationIdentity: options.destinationIdentity ?? options.targetAlias,
      destinationGeneration: options.destinationGeneration ?? 'legacy-1',
      targetFingerprint: options.configFingerprint,
      mappingVersion: options.mappingVersion ?? 'otlp-json-mapping-2',
      contentPolicy: options.contentPolicy ?? 'metadata-only',
      encoding: options.encoding ?? 'otlp-http-json',
    };
  }

  async initialize(): Promise<void> {
    await Promise.all(
      [
        this.entriesDirectory,
        this.archiveDirectory,
        this.quarantineDirectory,
        this.temporaryDirectory,
      ].map(async (directory) => mkdir(directory, { recursive: true })),
    );
  }

  async enqueue(batch: OtlpQueueBatch): Promise<ExportDeliveryReport> {
    try {
      return await this.withMetadataLock(async () => {
        await this.cleanupTemporaryFiles();
        const entries = await this.scanEntries(true);
        const usage = await this.storageUsage(true);
        const batchId = batch.batchId ?? randomUUID();
        if (
          !isSafeBatchId(batchId) ||
          !Number.isSafeInteger(batch.spanCount) ||
          batch.spanCount < 0 ||
          (batch.sourceSnapshotId !== undefined && !isSafeIdentity(batch.sourceSnapshotId))
        ) {
          return this.notQueued('The queue batch is invalid.');
        }
        const entry: QueueEntry = {
          schemaVersion: queueSchemaVersion,
          batchId,
          identity: this.identity,
          request: batch.request,
          spanCount: batch.spanCount,
          ...(batch.sourceSnapshotId === undefined
            ? {}
            : { sourceSnapshotId: batch.sourceSnapshotId }),
          createdAt: this.now(),
          expiresAt: this.now() + this.retentionMs,
          delivery: { attempts: 0 },
        };
        const bytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
        if (bytes > this.maxEntryBytes) {
          return this.notQueued('The export batch exceeds the persistent queue entry limit.');
        }
        if (entries.entries.some(({ entry: existing }) => existing.batchId === batchId)) {
          return {
            state: 'queued',
            reliableState: 'pending',
            targetAlias: this.options.targetAlias,
            batchId,
            attempted: false,
            acceptedSpanCount: 0,
            rejectedSpanCount: 0,
            attempts: 0,
            message: 'The export batch is already durably queued.',
          };
        }
        const archived = await readJson(this.archivePath(batchId), this.maxEntryBytes);
        if (isArchive(archived)) {
          return {
            state: exportState(archived.finalState),
            reliableState: archived.finalState,
            targetAlias: this.options.targetAlias,
            batchId,
            attempted: false,
            acceptedSpanCount: archived.acceptedSpanCount,
            rejectedSpanCount: archived.rejectedSpanCount,
            attempts: archived.attempts,
            message: 'The export batch already has a durable terminal receipt.',
          };
        }
        if (usage.count >= this.maxEntries || usage.bytes + bytes > this.maxBytes) {
          return this.notQueued('The persistent export queue is at capacity.');
        }
        try {
          await atomicWrite(this.entryPath(batchId), this.temporaryDirectory, entry);
        } catch {
          return this.notQueued('The export batch could not be committed to the persistent queue.');
        }
        return {
          state: 'queued',
          reliableState: 'pending',
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
    const entries = await this.scanEntries(false);
    const usage = await this.storageUsage(false);
    const oldest = entries.entries.reduce<number | undefined>(
      (current, stored) =>
        current === undefined || stored.entry.createdAt < current
          ? stored.entry.createdAt
          : current,
      undefined,
    );
    return {
      pendingCount: entries.entries.length,
      pendingBytes: entries.entries.reduce((total, stored) => total + stored.bytes, 0),
      ...(oldest === undefined ? {} : { oldestPendingAgeMs: Math.max(0, this.now() - oldest) }),
      expiredCount: entries.expiredCount,
      foreignConfigCount: entries.foreignConfigCount,
      archivedCount: usage.archiveCount,
      archivedBytes: usage.archiveBytes,
      quarantinedCount: usage.quarantineCount + entries.invalidCount,
      quarantinedBytes: usage.quarantineBytes,
      rejectedCount: usage.rejectedCount,
      exhaustedCount: usage.exhaustedCount,
      unknownDeliveryCount: usage.unknownDeliveryCount,
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
    const lease = await this.acquireLease();
    let leaseLost = false;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(
      () => {
        if (renewal !== undefined) return;
        renewal = this.renewLease(lease)
          .catch(() => {
            leaseLost = true;
          })
          .finally(() => {
            renewal = undefined;
          });
      },
      Math.max(10, Math.floor(this.leaseDurationMs / 3)),
    );
    try {
      await this.withMetadataLock(async () => this.cleanupTemporaryFiles());
      const startedAt = this.now();
      const deadlineMs =
        options.deadlineMs === undefined
          ? undefined
          : positiveInteger(options.deadlineMs, maxTimerMs);
      const deliveries: ExportDeliveryReport[] = [];
      let deadlineExceeded = false;
      const scan = await this.scanEntries(true);
      const eligible = scan.entries
        .filter(({ entry }) => this.matchesCurrentIdentity(entry.identity))
        .sort(
          (left, right) =>
            left.entry.createdAt - right.entry.createdAt ||
            left.entry.batchId.localeCompare(right.entry.batchId),
        );

      for (const stored of eligible) {
        if (leaseLost || !(await this.ownsLease(lease))) {
          leaseLost = true;
          break;
        }
        if (
          stored.entry.delivery.nextAttemptAt !== undefined &&
          stored.entry.delivery.nextAttemptAt > this.now()
        ) {
          continue;
        }
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
                Math.max(1, Math.min(maxTimerMs, Math.floor(remaining))),
              );
        let delivery: ExportDeliveryReport;
        try {
          delivery = await client.send(stored.entry.request, stored.entry.spanCount, {
            signal: controller.signal,
            expectedTargetFingerprint: stored.entry.identity.targetFingerprint,
          });
        } catch {
          delivery = {
            state: 'unknown_delivery',
            reliableState: 'unknown_delivery',
            targetAlias: stored.entry.identity.targetAlias,
            attempted: true,
            acceptedSpanCount: 0,
            rejectedSpanCount: 0,
            attempts: 1,
            message: 'The OTLP sender ended without a delivery report.',
          };
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        if (leaseLost || !(await this.ownsLease(lease))) {
          leaseLost = true;
          deliveries.push({
            ...delivery,
            reliableState: 'unknown_delivery',
            state: 'unknown_delivery',
            batchId: stored.entry.batchId,
            targetAlias: stored.entry.identity.targetAlias,
            message: 'The consumer lease changed before the delivery result could be committed.',
          });
          break;
        }
        const decorated = this.decorate(delivery, stored.entry);
        deliveries.push(decorated);
        await this.commitDelivery(stored, decorated, lease);
        if (deadlineMs !== undefined && this.now() - startedAt >= deadlineMs) {
          deadlineExceeded = true;
          break;
        }
      }

      const pending = await this.scanEntries(false);
      return {
        contractVersion: otelExportContractVersion,
        deliveries,
        pendingCount: pending.entries.length,
        deadlineExceeded,
      };
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await this.releaseLease(lease);
    }
  }

  private async commitDelivery(
    stored: StoredEntry,
    delivery: ExportDeliveryReport,
    lease: ConsumerLease,
  ): Promise<void> {
    await this.withMetadataLock(async () => {
      if (!(await this.ownsLeaseUnlocked(lease))) {
        throw new OtlpQueueError('QUEUE_LEASE_LOST', 'The consumer lease is no longer owned.');
      }
      const state = reliableState(delivery);
      const now = this.now();
      const attempts = stored.entry.delivery.attempts + delivery.attempts;
      const firstAttemptAt =
        stored.entry.delivery.firstAttemptAt ?? (delivery.attempted ? now : undefined);
      const retryDeadlineAt =
        stored.entry.delivery.retryDeadlineAt ??
        (firstAttemptAt === undefined ? undefined : firstAttemptAt + this.retryBudgetMs);
      if (deliveryIsFinal(state)) {
        const message = safeMessage(state);
        const archive: QueueArchive = {
          schemaVersion: archiveSchemaVersion,
          batchId: stored.entry.batchId,
          identity: stored.entry.identity,
          spanCount: stored.entry.spanCount,
          ...(stored.entry.sourceSnapshotId === undefined
            ? {}
            : { sourceSnapshotId: stored.entry.sourceSnapshotId }),
          createdAt: stored.entry.createdAt,
          archivedAt: now,
          expiresAt: stored.entry.expiresAt,
          finalState: state,
          attempts,
          acceptedSpanCount: delivery.acceptedSpanCount,
          rejectedSpanCount: delivery.rejectedSpanCount,
          ...(state === 'accepted' || state === 'accepted_with_warnings' ? { receiptAt: now } : {}),
          ...(message === undefined ? {} : { message }),
        };
        await atomicWrite(
          this.archivePath(stored.entry.batchId),
          this.temporaryDirectory,
          archive,
          true,
        );
        await unlink(stored.path).catch(() => undefined);
        return;
      }

      if (state === 'retry_scheduled') {
        const retryDelay = delivery.retryAfterMs ?? this.backoffMs(attempts);
        if (
          attempts >= this.retryMaxAttempts ||
          (retryDeadlineAt !== undefined && now + retryDelay >= retryDeadlineAt)
        ) {
          await this.archiveExhausted(stored.entry, attempts, now);
          await unlink(stored.path).catch(() => undefined);
          return;
        }
        const updated: QueueEntry = {
          ...stored.entry,
          delivery: {
            attempts,
            ...(firstAttemptAt === undefined ? {} : { firstAttemptAt }),
            ...(retryDeadlineAt === undefined ? {} : { retryDeadlineAt }),
            nextAttemptAt: now + retryDelay,
            lastState: 'retry_scheduled',
            lastAttemptAt: now,
          },
        };
        await atomicWrite(stored.path, this.temporaryDirectory, updated, true);
        return;
      }

      const updated: QueueEntry = {
        ...stored.entry,
        delivery: {
          attempts,
          ...(firstAttemptAt === undefined ? {} : { firstAttemptAt }),
          ...(retryDeadlineAt === undefined ? {} : { retryDeadlineAt }),
          lastState: state,
          lastAttemptAt: now,
        },
      };
      await atomicWrite(stored.path, this.temporaryDirectory, updated, true);
    });
  }

  private async archiveExhausted(entry: QueueEntry, attempts: number, now: number): Promise<void> {
    const archive: QueueArchive = {
      schemaVersion: archiveSchemaVersion,
      batchId: entry.batchId,
      identity: entry.identity,
      spanCount: entry.spanCount,
      ...(entry.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: entry.sourceSnapshotId }),
      createdAt: entry.createdAt,
      archivedAt: now,
      expiresAt: entry.expiresAt,
      finalState: 'retry_exhausted',
      attempts,
      acceptedSpanCount: 0,
      rejectedSpanCount: 0,
      message: 'The persistent retry budget was exhausted.',
    };
    await atomicWrite(this.archivePath(entry.batchId), this.temporaryDirectory, archive, true);
  }

  private decorate(delivery: ExportDeliveryReport, entry: QueueEntry): ExportDeliveryReport {
    return { ...delivery, batchId: entry.batchId, targetAlias: entry.identity.targetAlias };
  }

  private notQueued(message: string): ExportDeliveryReport {
    return {
      state: 'not_queued',
      reliableState: 'not_sent',
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

  private archivePath(batchId: string): string {
    return join(this.archiveDirectory, `${batchId}.json`);
  }

  private matchesCurrentIdentity(identity: QueueIdentity): boolean {
    return (
      identity.targetAlias === this.identity.targetAlias &&
      identity.destinationIdentity === this.identity.destinationIdentity &&
      identity.destinationGeneration === this.identity.destinationGeneration &&
      identity.targetFingerprint === this.identity.targetFingerprint &&
      identity.mappingVersion === this.identity.mappingVersion &&
      identity.contentPolicy === this.identity.contentPolicy &&
      identity.encoding === this.identity.encoding
    );
  }

  private backoffMs(attempts: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.min(16, Math.max(0, attempts - 1)));
  }

  private async acquireLease(): Promise<ConsumerLease> {
    return this.withMetadataLock(async () => {
      const existing = await readJson(this.leasePath, this.maxEntryBytes);
      if (isLease(existing) && existing.expiresAt > this.now()) {
        throw new OtlpQueueError(
          'QUEUE_LOCKED',
          'Another process is flushing this persistent queue.',
        );
      }
      if (existing !== undefined) await unlink(this.leasePath).catch(() => undefined);
      const lease: ConsumerLease = {
        schemaVersion: leaseSchemaVersion,
        ownerToken: randomUUID(),
        expiresAt: this.now() + this.leaseDurationMs,
      };
      await atomicWrite(this.leasePath, this.temporaryDirectory, lease);
      return lease;
    });
  }

  private async renewLease(lease: ConsumerLease): Promise<void> {
    await this.withMetadataLock(async () => {
      if (!(await this.ownsLeaseUnlocked(lease))) {
        throw new OtlpQueueError('QUEUE_LEASE_LOST', 'The consumer lease is no longer owned.');
      }
      await atomicWrite(
        this.leasePath,
        this.temporaryDirectory,
        { ...lease, expiresAt: this.now() + this.leaseDurationMs },
        true,
      );
    });
  }

  private async ownsLease(lease: ConsumerLease): Promise<boolean> {
    return this.withMetadataLock(async () => this.ownsLeaseUnlocked(lease));
  }

  private async ownsLeaseUnlocked(lease: ConsumerLease): Promise<boolean> {
    const current = await readJson(this.leasePath, this.maxEntryBytes);
    return (
      isLease(current) && current.ownerToken === lease.ownerToken && current.expiresAt > this.now()
    );
  }

  private async releaseLease(lease: ConsumerLease): Promise<void> {
    await this.withMetadataLock(async () => {
      const current = await readJson(this.leasePath, this.maxEntryBytes);
      if (isLease(current) && current.ownerToken === lease.ownerToken) {
        await unlink(this.leasePath).catch(() => undefined);
      }
    }).catch(() => undefined);
  }

  private async withMetadataLock<T>(operation: () => Promise<T>): Promise<T> {
    const ownerToken = randomUUID();
    await this.acquireMetadataLock(ownerToken);
    try {
      return await operation();
    } finally {
      await this.releaseMetadataLock(ownerToken);
    }
  }

  private async acquireMetadataLock(ownerToken: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const handle = await open(this.metadataLockPath, 'wx');
        try {
          await handle.writeFile(
            `${JSON.stringify({
              schemaVersion: metadataLockSchemaVersion,
              ownerToken,
              expiresAt: this.now() + metadataLockDurationMs,
            })}\n`,
            'utf8',
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
            'Could not acquire the persistent queue metadata lock.',
          );
        }
        const existing = await readJson(this.metadataLockPath, this.maxEntryBytes);
        if (!isMetadataLock(existing) || existing.expiresAt <= this.now()) {
          await this.retireMetadataLock();
          continue;
        }
        await pause(5);
      }
    }
    throw new OtlpQueueError('QUEUE_LOCKED', 'The persistent queue metadata lock is busy.');
  }

  private async releaseMetadataLock(ownerToken: string): Promise<void> {
    const current = await readJson(this.metadataLockPath, this.maxEntryBytes);
    if (isMetadataLock(current) && current.ownerToken === ownerToken) {
      await unlink(this.metadataLockPath).catch(() => undefined);
    }
  }

  /**
   * Claims an expired lock with a hard link before removing it. Comparing the
   * linked inode avoids deleting a new lock created after this process read
   * the stale one.
   */
  private async retireMetadataLock(): Promise<void> {
    const claim = join(this.temporaryDirectory, `${randomUUID()}.metadata-claim`);
    try {
      await link(this.metadataLockPath, claim);
      const [current, claimed] = await Promise.all([lstat(this.metadataLockPath), lstat(claim)]);
      if (current.dev !== claimed.dev || current.ino !== claimed.ino) return;
      const value = await readJson(this.metadataLockPath, this.maxEntryBytes);
      if (!isMetadataLock(value) || value.expiresAt <= this.now()) {
        await unlink(this.metadataLockPath).catch(() => undefined);
      }
    } catch {
      // Another process released or replaced the lock. The next acquisition
      // attempt observes its current owner.
    } finally {
      await unlink(claim).catch(() => undefined);
    }
  }

  private async scanEntries(clean: boolean): Promise<EntryScan> {
    await this.initialize();
    const entries: StoredEntry[] = [];
    let expiredCount = 0;
    let foreignConfigCount = 0;
    let invalidCount = 0;
    const files = await readdir(this.entriesDirectory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const path = join(this.entriesDirectory, file.name);
      const details = await lstat(path).catch(() => undefined);
      if (details === undefined) continue;
      if (details.size > this.maxEntryBytes) {
        invalidCount += 1;
        if (clean) await this.quarantine(path, 'entry-size');
        continue;
      }
      const value = await readJson(path, this.maxEntryBytes);
      if (!isQueueEntry(value)) {
        invalidCount += 1;
        if (clean) await this.quarantine(path, 'invalid-or-legacy-entry');
        continue;
      }
      if (value.expiresAt <= this.now()) {
        expiredCount += 1;
        if (clean) await unlink(path).catch(() => undefined);
        continue;
      }
      if (!this.matchesCurrentIdentity(value.identity)) foreignConfigCount += 1;
      entries.push({ entry: value, path, bytes: details.size });
    }
    return { entries, expiredCount, foreignConfigCount, invalidCount };
  }

  private async storageUsage(clean: boolean): Promise<StorageUsage> {
    await this.initialize();
    let count = 0;
    let bytes = 0;
    let archiveCount = 0;
    let archiveBytes = 0;
    let quarantineCount = 0;
    let quarantineBytes = 0;
    let rejectedCount = 0;
    let exhaustedCount = 0;
    let unknownDeliveryCount = 0;
    const entryFiles = await readdir(this.entriesDirectory, { withFileTypes: true });
    for (const file of entryFiles) {
      if (!file.isFile()) continue;
      const details = await lstat(join(this.entriesDirectory, file.name)).catch(() => undefined);
      if (details?.isFile()) {
        count += 1;
        bytes += details.size;
      }
    }
    const archiveFiles = await readdir(this.archiveDirectory, { withFileTypes: true });
    for (const file of archiveFiles) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const path = join(this.archiveDirectory, file.name);
      const details = await lstat(path).catch(() => undefined);
      if (details === undefined || !details.isFile()) continue;
      const value = await readJson(path, this.maxEntryBytes);
      if (!isArchive(value)) {
        if (clean) await this.quarantine(path, 'invalid-archive');
        continue;
      }
      if (value.expiresAt <= this.now() && clean) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      count += 1;
      bytes += details.size;
      archiveCount += 1;
      archiveBytes += details.size;
      if (
        value.finalState === 'partially_rejected' ||
        value.finalState === 'permanently_rejected'
      ) {
        rejectedCount += 1;
      }
      if (value.finalState === 'retry_exhausted') exhaustedCount += 1;
      if (value.finalState === 'unknown_delivery') unknownDeliveryCount += 1;
    }
    const quarantined = await readdir(this.quarantineDirectory, { withFileTypes: true });
    for (const file of quarantined) {
      if (!file.isFile()) continue;
      const path = join(this.quarantineDirectory, file.name);
      const details = await lstat(path).catch(() => undefined);
      if (details === undefined || !details.isFile()) continue;
      if (clean && this.now() - details.mtimeMs >= this.retentionMs) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      count += 1;
      bytes += details.size;
      quarantineCount += 1;
      quarantineBytes += details.size;
    }
    const temporary = await readdir(this.temporaryDirectory, { withFileTypes: true });
    for (const file of temporary) {
      if (!file.isFile()) continue;
      const details = await lstat(join(this.temporaryDirectory, file.name)).catch(() => undefined);
      if (details?.isFile()) {
        count += 1;
        bytes += details.size;
      }
    }
    return {
      count,
      bytes,
      archiveCount,
      archiveBytes,
      quarantineCount,
      quarantineBytes,
      rejectedCount,
      exhaustedCount,
      unknownDeliveryCount,
    };
  }

  private async quarantine(path: string, reason: string): Promise<void> {
    const name = `${randomUUID()}-${reason}.json`;
    await rename(path, join(this.quarantineDirectory, name)).catch(() => undefined);
  }

  private async cleanupTemporaryFiles(): Promise<void> {
    const files = await readdir(this.temporaryDirectory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      const path = join(this.temporaryDirectory, file.name);
      const details = await lstat(path).catch(() => undefined);
      if (details !== undefined && this.now() - details.mtimeMs >= this.leaseDurationMs) {
        await unlink(path).catch(() => undefined);
      }
    }
  }
}

export async function openOtlpPersistentQueue(
  options: OtlpPersistentQueueOptions,
): Promise<OtlpPersistentQueue> {
  const queue = new PersistentQueue(options);
  await queue.initialize();
  return queue;
}
