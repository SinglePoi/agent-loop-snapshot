import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ExportBatchIdentity,
  OtlpExportTraceServiceRequest,
  ReliableDeliveryState,
} from './index.js';

const deliveryRecordSchemaVersion = 'otlp-delivery-record-1' as const;

export interface DeliveryRecordBatch {
  readonly batchId: string;
  readonly request: OtlpExportTraceServiceRequest;
  readonly spanCount: number;
  readonly state: ReliableDeliveryState;
  readonly attempts: number;
  readonly updatedAt: number;
  readonly message?: string;
}

export interface DeliveryRecord {
  readonly schemaVersion: typeof deliveryRecordSchemaVersion;
  readonly deliveryId: string;
  readonly sourceRunId: string;
  readonly identity: ExportBatchIdentity;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly batches: readonly DeliveryRecordBatch[];
}

export interface CreateDeliveryRecord {
  readonly sourceRunId: string;
  readonly identity: Omit<ExportBatchIdentity, 'batchId'>;
  readonly batches: readonly {
    readonly batchId: string;
    readonly request: OtlpExportTraceServiceRequest;
    readonly spanCount: number;
  }[];
}

function deliveryId(input: CreateDeliveryRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sourceRunId: input.sourceRunId,
        identity: input.identity,
        batchIds: input.batches.map((batch) => batch.batchId),
      }),
      'utf8',
    )
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n]/u.test(value)
  );
}

function isDeliveryState(value: unknown): value is ReliableDeliveryState {
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

function isRecordBatch(value: unknown): value is DeliveryRecordBatch {
  return (
    isRecord(value) &&
    isSafeId(value.batchId) &&
    isRecord(value.request) &&
    Array.isArray(value.request.resourceSpans) &&
    typeof value.spanCount === 'number' &&
    Number.isSafeInteger(value.spanCount) &&
    value.spanCount >= 0 &&
    isDeliveryState(value.state) &&
    typeof value.attempts === 'number' &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    (value.message === undefined || typeof value.message === 'string')
  );
}

function isRecordIdentity(value: unknown): value is ExportBatchIdentity {
  return (
    isRecord(value) &&
    value.reliableDeliveryContractVersion === 'otel-export-2.0' &&
    value.mappingVersion === 'otlp-json-mapping-2' &&
    value.queueVersion === 'otlp-persistent-queue-2' &&
    (value.contentPolicy === 'metadata-only' || value.contentPolicy === 'redacted-content') &&
    value.encoding === 'otlp-http-json' &&
    isSafeId(value.targetAlias) &&
    isSafeId(value.destinationIdentity) &&
    isSafeId(value.destinationGeneration) &&
    isSafeId(value.targetFingerprint) &&
    isSafeId(value.batchId)
  );
}

function isDeliveryRecord(value: unknown): value is DeliveryRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === deliveryRecordSchemaVersion &&
    isSafeId(value.deliveryId) &&
    isSafeId(value.sourceRunId) &&
    isRecordIdentity(value.identity) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    Array.isArray(value.batches) &&
    value.batches.every(isRecordBatch)
  );
}

async function atomicWrite(
  path: string,
  temporaryDirectory: string,
  value: unknown,
  replace = false,
) {
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

async function readDeliveryRecord(path: string): Promise<DeliveryRecord | undefined> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.size > 16 * 1024 * 1024) return undefined;
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isDeliveryRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A separate, durable journal for snapshot export intent. It is deliberately
 * kept next to, rather than inside, queue entries: an interruption between a
 * locally committed snapshot and queue insertion remains observable and can
 * be resumed only from the explicitly configured queue directory.
 */
export class DeliveryRecordStore {
  private readonly directory: string;
  private readonly temporaryDirectory: string;

  constructor(
    queueDirectory: string,
    private readonly now: () => number = Date.now,
  ) {
    this.directory = join(queueDirectory, 'delivery-records');
    this.temporaryDirectory = join(this.directory, 'temporary');
  }

  async register(input: CreateDeliveryRecord): Promise<DeliveryRecord> {
    await Promise.all([
      mkdir(this.directory, { recursive: true }),
      mkdir(this.temporaryDirectory, { recursive: true }),
    ]);
    const id = deliveryId(input);
    const path = this.pathFor(id);
    const existing = await readDeliveryRecord(path);
    if (existing !== undefined) return existing;
    const createdAt = this.now();
    const record: DeliveryRecord = {
      schemaVersion: deliveryRecordSchemaVersion,
      deliveryId: id,
      sourceRunId: input.sourceRunId,
      identity: { ...input.identity, batchId: id },
      createdAt,
      updatedAt: createdAt,
      batches: input.batches.map((batch) => ({
        ...batch,
        state: 'not_sent',
        attempts: 0,
        updatedAt: createdAt,
      })),
    };
    try {
      await atomicWrite(path, this.temporaryDirectory, record);
      return record;
    } catch {
      const raced = await readDeliveryRecord(path);
      if (raced !== undefined) return raced;
      throw new Error('The export delivery intent could not be persisted.');
    }
  }

  async list(): Promise<readonly DeliveryRecord[]> {
    await Promise.all([
      mkdir(this.directory, { recursive: true }),
      mkdir(this.temporaryDirectory, { recursive: true }),
    ]);
    const files = await readdir(this.directory, { withFileTypes: true });
    const records = await Promise.all(
      files
        .filter((file) => file.isFile() && file.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => readDeliveryRecord(join(this.directory, file.name))),
    );
    return records.filter((record): record is DeliveryRecord => record !== undefined);
  }

  async update(
    record: DeliveryRecord,
    batches: readonly DeliveryRecordBatch[],
  ): Promise<DeliveryRecord> {
    const updated: DeliveryRecord = { ...record, updatedAt: this.now(), batches };
    await atomicWrite(this.pathFor(record.deliveryId), this.temporaryDirectory, updated, true);
    return updated;
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}.json`);
  }
}
