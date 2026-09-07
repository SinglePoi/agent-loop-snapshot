import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { EventEnvelope, SnapshotManifest } from '@agent-loop-snapshot/schema';

import { CheckpointStore } from './checkpoints.js';
import type { RecorderInterceptor } from './index.js';
import type { Checkpoint } from '@agent-loop-snapshot/schema';

export type FlushMode = 'event' | 'batch' | 'manual';

export interface JsonlWriterOptions {
  flushMode?: FlushMode;
  batchSize?: number;
  faultInjector?: JsonlWriterFaultInjector;
}

/** Explicit test hook for exercising storage-failure recovery paths. */
export interface JsonlWriterFaultInjector {
  beforeWrite?(event: Readonly<EventEnvelope<string, unknown>>): void | Promise<void>;
  beforeSync?(): void | Promise<void>;
}

export interface JsonlDiagnostic {
  code: 'FILE_NOT_FOUND' | 'INVALID_JSONL_LINE' | 'PARTIAL_JSONL_TAIL' | 'UNFINISHED_RUN';
  line?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface JsonlScanResult {
  events: unknown[];
  diagnostics: JsonlDiagnostic[];
  endsWithNewline: boolean;
  hasContent: boolean;
  tailCorrupt: boolean;
}

export interface SnapshotInspection {
  directory: string;
  events: JsonlScanResult;
  manifest?: unknown;
  manifestSource?: 'temporary' | 'final';
  unfinished: boolean;
  diagnostics: JsonlDiagnostic[];
}

export class SnapshotWriterError extends Error {
  constructor(
    readonly code:
      | 'EVENT_WRITE_FAILED'
      | 'EVENT_SYNC_FAILED'
      | 'MANIFEST_COMMIT_FAILED'
      | 'MANIFEST_NOT_TERMINAL'
      | 'SEQUENCE_NOT_INCREASING'
      | 'RUN_ID_MISMATCH'
      | 'WRITER_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotWriterError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNewlineTerminated(content: string): boolean {
  return content.endsWith('\n') || content.endsWith('\r');
}

export async function scanJsonlFile(filePath: string): Promise<JsonlScanResult> {
  let content: string;

  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      events: [],
      diagnostics: [
        {
          code: 'FILE_NOT_FOUND',
          message: error instanceof Error ? error.message : `Could not read ${basename(filePath)}.`,
          severity: 'warning',
        },
      ],
      endsWithNewline: false,
      hasContent: false,
      tailCorrupt: false,
    };
  }

  const lines = content.split(/\r?\n/);
  const endsWithNewline = isNewlineTerminated(content);
  const events: unknown[] = [];
  const diagnostics: JsonlDiagnostic[] = [];

  lines.forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }

    try {
      events.push(JSON.parse(line) as unknown);
    } catch (error) {
      const isTail = index === lines.length - 1 && !endsWithNewline;
      diagnostics.push({
        code: isTail ? 'PARTIAL_JSONL_TAIL' : 'INVALID_JSONL_LINE',
        line: index + 1,
        message: error instanceof Error ? error.message : 'Line is not valid JSON.',
        severity: 'error',
      });
    }
  });

  return {
    events,
    diagnostics,
    endsWithNewline,
    hasContent: content.length > 0,
    tailCorrupt: diagnostics.some((diagnostic) => diagnostic.code === 'PARTIAL_JSONL_TAIL'),
  };
}

export class JsonlEventWriter {
  private readonly filePath: string;
  private readonly flushMode: FlushMode;
  private readonly batchSize: number;
  private readonly faultInjector: JsonlWriterFaultInjector | undefined;
  private readonly fileHandle: Awaited<ReturnType<typeof open>>;
  private queue: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private needsSeparator: boolean;
  private closed = false;
  private readonly initialDiagnostics: readonly JsonlDiagnostic[];
  private runId?: string;
  private lastSequence = 0;

  private constructor(
    filePath: string,
    fileHandle: Awaited<ReturnType<typeof open>>,
    scan: JsonlScanResult,
    options: JsonlWriterOptions,
  ) {
    this.filePath = filePath;
    this.fileHandle = fileHandle;
    this.flushMode = options.flushMode ?? 'event';
    this.batchSize = Math.max(1, options.batchSize ?? 10);
    this.faultInjector = options.faultInjector;
    this.needsSeparator = !scan.endsWithNewline && scan.hasContent;
    this.initialDiagnostics = scan.diagnostics;

    const lastEvent = scan.events.at(-1);
    if (isRecord(lastEvent)) {
      if (typeof lastEvent.run_id === 'string') {
        this.runId = lastEvent.run_id;
      }
      if (typeof lastEvent.sequence === 'number') {
        this.lastSequence = lastEvent.sequence;
      }
    }
  }

  static async open(filePath: string, options: JsonlWriterOptions = {}): Promise<JsonlEventWriter> {
    await mkdir(dirname(filePath), { recursive: true });
    const scan = await scanJsonlFile(filePath);
    const fileHandle = await open(filePath, 'a+');
    return new JsonlEventWriter(filePath, fileHandle, scan, options);
  }

  get diagnostics(): readonly JsonlDiagnostic[] {
    return this.initialDiagnostics;
  }

  get path(): string {
    return this.filePath;
  }

  append(event: EventEnvelope<string, unknown>): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) {
        throw new SnapshotWriterError('WRITER_CLOSED', 'Cannot append to a closed JSONL writer.');
      }

      if (this.runId !== undefined && event.run_id !== this.runId) {
        throw new SnapshotWriterError(
          'RUN_ID_MISMATCH',
          `Event run_id "${event.run_id}" does not match writer run_id "${this.runId}".`,
        );
      }

      if (this.runId === undefined) {
        this.runId = event.run_id;
      }

      if (event.sequence <= this.lastSequence) {
        throw new SnapshotWriterError(
          'SEQUENCE_NOT_INCREASING',
          `Event sequence ${event.sequence} must be greater than ${this.lastSequence}.`,
        );
      }

      const serialized = `${JSON.stringify(event)}\n`;
      try {
        await this.faultInjector?.beforeWrite?.(event);
        if (this.needsSeparator) {
          await this.fileHandle.write('\n');
          this.needsSeparator = false;
        }
        await this.fileHandle.write(serialized);
      } catch (error) {
        throw new SnapshotWriterError(
          'EVENT_WRITE_FAILED',
          error instanceof Error ? error.message : 'Could not write JSONL event.',
        );
      }
      this.lastSequence = event.sequence;
      this.pendingWrites += 1;

      if (
        this.flushMode === 'event' ||
        (this.flushMode === 'batch' && this.pendingWrites >= this.batchSize)
      ) {
        await this.syncInternal();
      }
    });
  }

  flush(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      await this.syncInternal();
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) {
        return;
      }
      await this.syncInternal();
      this.closed = true;
      await this.fileHandle.close();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async syncInternal(): Promise<void> {
    try {
      await this.faultInjector?.beforeSync?.();
      await this.fileHandle.sync();
      this.pendingWrites = 0;
    } catch (error) {
      throw new SnapshotWriterError(
        'EVENT_SYNC_FAILED',
        error instanceof Error ? error.message : 'Could not sync JSONL events.',
      );
    }
  }
}

export type SnapshotWriterOptions = JsonlWriterOptions;

export class SnapshotWriter {
  private readonly directory: string;
  private readonly events: JsonlEventWriter;
  private readonly checkpoints: CheckpointStore;
  private manifestQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(directory: string, events: JsonlEventWriter, checkpoints: CheckpointStore) {
    this.directory = directory;
    this.events = events;
    this.checkpoints = checkpoints;
  }

  static async open(
    directory: string,
    options: SnapshotWriterOptions = {},
  ): Promise<SnapshotWriter> {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    const events = await JsonlEventWriter.open(join(root, 'events.jsonl'), options);
    const checkpoints = await CheckpointStore.open(join(root, 'checkpoints'));
    return new SnapshotWriter(root, events, checkpoints);
  }

  get snapshotDirectory(): string {
    return this.directory;
  }

  get eventWriter(): JsonlEventWriter {
    return this.events;
  }

  get checkpointStore(): CheckpointStore {
    return this.checkpoints;
  }

  append(event: EventEnvelope<string, unknown>): Promise<void> {
    return this.events.append(event);
  }

  asInterceptor(): RecorderInterceptor {
    return {
      afterAppend: (event) => this.append(event),
      afterCheckpoint: (checkpoint) => this.checkpoints.save(checkpoint),
    };
  }

  writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    return this.checkpoints.save(checkpoint);
  }

  writeManifest(manifest: SnapshotManifest): Promise<void> {
    return this.enqueueManifest(async () => {
      await this.writeManifestTemporary(manifest);
    });
  }

  commit(manifest: SnapshotManifest): Promise<void> {
    return this.enqueueManifest(async () => {
      if (manifest.run_state !== 'finished' || manifest.terminal_status === null) {
        throw new SnapshotWriterError(
          'MANIFEST_NOT_TERMINAL',
          'Only a finished manifest with a terminal_status can be atomically committed.',
        );
      }

      await this.writeManifestTemporary(manifest);
      try {
        await rename(
          join(this.directory, 'manifest.json.tmp'),
          join(this.directory, 'manifest.json'),
        );
      } catch (error) {
        throw new SnapshotWriterError(
          'MANIFEST_COMMIT_FAILED',
          error instanceof Error ? error.message : 'Could not atomically commit manifest.json.',
        );
      }
    });
  }

  async flush(): Promise<void> {
    await this.events.flush();
    await this.manifestQueue;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    await this.flush();
    this.closed = true;
    await this.events.close();
    await this.checkpoints.close();
  }

  private enqueueManifest(operation: () => Promise<void>): Promise<void> {
    const result = this.manifestQueue.then(operation);
    this.manifestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async writeManifestTemporary(manifest: SnapshotManifest): Promise<void> {
    const temporaryPath = join(this.directory, 'manifest.json.tmp');
    const handle = await open(temporaryPath, 'w');
    try {
      await handle.write(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function inspectSnapshotDirectory(directory: string): Promise<SnapshotInspection> {
  const root = resolve(directory);
  const events = await scanJsonlFile(join(root, 'events.jsonl'));
  const diagnostics = [...events.diagnostics];
  const temporaryPath = join(root, 'manifest.json.tmp');
  const finalPath = join(root, 'manifest.json');
  let manifest: unknown;
  let manifestSource: SnapshotInspection['manifestSource'];
  let temporaryPresent = false;

  const manifestCandidates: Array<[string, 'temporary' | 'final']> = [
    [temporaryPath, 'temporary'],
    [finalPath, 'final'],
  ];

  for (const [path, source] of manifestCandidates) {
    try {
      const rawManifest = await readFile(path, 'utf8');
      temporaryPresent ||= source === 'temporary';
      manifest = JSON.parse(rawManifest) as unknown;
      manifestSource = source;
      if (source === 'temporary') {
        break;
      }
    } catch {
      // A missing manifest is handled by the unfinished calculation below.
    }
  }

  const unfinished =
    temporaryPresent ||
    (isRecord(manifest) && manifest.run_state !== 'finished') ||
    (manifestSource !== 'final' && events.events.length > 0);

  if (unfinished && (manifestSource === 'temporary' || events.events.length > 0)) {
    diagnostics.push({
      code: 'UNFINISHED_RUN',
      message: 'Snapshot contains an unfinished or uncommitted run.',
      severity: 'warning',
    });
  }

  return {
    directory: root,
    events,
    ...(manifest === undefined ? {} : { manifest }),
    ...(manifestSource === undefined ? {} : { manifestSource }),
    unfinished,
    diagnostics,
  };
}
