import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  ArtifactReference,
  Checkpoint,
  CheckpointId,
  EventEnvelope,
  EventId,
  JsonObject,
  JsonValue,
  RunId,
  StateChangedPayload,
} from '@agent-loop-snapshot/schema';

import { snapshotSchemaVersion } from '@agent-loop-snapshot/schema/protocol';

export type RecoverableState = JsonObject;

export type CheckpointDiagnosticCode =
  | 'CHECKPOINT_FILE_INVALID_JSON'
  | 'CHECKPOINT_INVALID'
  | 'CHECKPOINT_RUN_ID_MISMATCH'
  | 'CHECKPOINT_EVENT_MISMATCH'
  | 'CHECKPOINT_STATE_UNAVAILABLE'
  | 'CHECKPOINT_STATE_HASH_MISMATCH';

export interface CheckpointDiagnostic {
  code: CheckpointDiagnosticCode;
  checkpointId?: CheckpointId;
  file?: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface CheckpointLoadResult {
  checkpoints: readonly Checkpoint[];
  diagnostics: readonly CheckpointDiagnostic[];
}

export class CheckpointStoreError extends Error {
  constructor(
    readonly code:
      'CHECKPOINT_INVALID' | 'CHECKPOINT_SEQUENCE_COLLISION' | 'CHECKPOINT_STORE_CLOSED',
    message: string,
  ) {
    super(message);
    this.name = 'CheckpointStoreError';
  }
}

export type StateArtifactResolver = (reference: ArtifactReference) => Promise<JsonValue>;

export interface StateReconstructionOptions {
  checkpoints?: readonly Checkpoint[];
  checkpointStore?: CheckpointStore;
  resolveArtifact?: StateArtifactResolver;
}

export interface StateReconstructionResult {
  state: RecoverableState;
  stateHash: string;
  lastEventId?: EventId;
  sequence: number;
  checkpointId?: CheckpointId;
  usedCheckpoint: boolean;
  diagnostics: readonly CheckpointDiagnostic[];
}

export class StateReconstructionError extends Error {
  constructor(
    readonly code:
      | 'EVENT_RUN_ID_MISMATCH'
      | 'EVENT_SEQUENCE_INVALID'
      | 'STATE_EVENT_INVALID'
      | 'STATE_VALUE_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'StateReconstructionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    value.schema_version === snapshotSchemaVersion &&
    typeof value.digest === 'string' &&
    typeof value.media_type === 'string' &&
    typeof value.byte_length === 'number'
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(',')}}`;
}

export function hashState(state: RecoverableState): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

function pointerSegments(path: string): string[] {
  if (path === '') {
    return [];
  }
  if (!path.startsWith('/')) {
    throw new StateReconstructionError(
      'STATE_EVENT_INVALID',
      `State path "${path}" must be an RFC 6901 JSON Pointer.`,
    );
  }
  return path
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

type MutableJsonContainer = JsonObject | JsonValue[];

function isArrayIndex(segment: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(segment);
}

function getContainerValue(
  container: MutableJsonContainer,
  segment: string,
): JsonValue | undefined {
  if (Array.isArray(container)) {
    if (!isArrayIndex(segment)) {
      return undefined;
    }
    return container[Number(segment)];
  }
  return container[segment];
}

function setContainerValue(
  container: MutableJsonContainer,
  segment: string,
  value: JsonValue,
): void {
  if (Array.isArray(container)) {
    if (segment === '-') {
      container.push(value);
      return;
    }
    if (!isArrayIndex(segment)) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `Array state path segment "${segment}" is not a valid index.`,
      );
    }
    const index = Number(segment);
    if (index > container.length) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `Array state path index ${segment} is outside the current state.`,
      );
    }
    container[index] = value;
    return;
  }
  container[segment] = value;
}

function deleteContainerValue(container: MutableJsonContainer, segment: string): void {
  if (Array.isArray(container)) {
    if (!isArrayIndex(segment) || Number(segment) >= container.length) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `Array state path index "${segment}" does not exist.`,
      );
    }
    container.splice(Number(segment), 1);
    return;
  }
  if (!(segment in container)) {
    throw new StateReconstructionError(
      'STATE_EVENT_INVALID',
      `State path segment "${segment}" does not exist.`,
    );
  }
  delete container[segment];
}

function containerAtPath(
  state: RecoverableState,
  segments: readonly string[],
): MutableJsonContainer {
  let current: JsonValue = state;
  for (const segment of segments) {
    if (!isRecord(current) && !Array.isArray(current)) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `State path cannot descend through primitive value at "${segment}".`,
      );
    }
    const next = getContainerValue(current, segment);
    if (next === undefined) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `State path segment "${segment}" does not exist.`,
      );
    }
    current = next;
  }

  if (!isRecord(current) && !Array.isArray(current)) {
    throw new StateReconstructionError(
      'STATE_EVENT_INVALID',
      'State operation target must be an object or array.',
    );
  }
  return current;
}

function parentAtPath(state: RecoverableState, segments: readonly string[]): MutableJsonContainer {
  if (segments.length === 0) {
    throw new StateReconstructionError(
      'STATE_EVENT_INVALID',
      'Root state replacement is not supported; checkpoints must remain JSON objects.',
    );
  }

  let current: MutableJsonContainer = state;
  for (const segment of segments.slice(0, -1)) {
    const next = getContainerValue(current, segment);
    if (next === undefined || (!isRecord(next) && !Array.isArray(next))) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `State path segment "${segment}" is not an object or array.`,
      );
    }
    current = next;
  }
  return current;
}

function requireValue(payload: StateChangedPayload): JsonValue {
  if (!('value' in payload)) {
    throw new StateReconstructionError(
      'STATE_VALUE_INVALID',
      `State operation "${payload.operation}" requires a value.`,
    );
  }
  return payload.value as JsonValue;
}

function applyStateChanged(state: RecoverableState, payload: StateChangedPayload): void {
  const segments = pointerSegments(payload.path);
  if (segments.length === 0) {
    throw new StateReconstructionError(
      'STATE_EVENT_INVALID',
      'State changes must target a property or nested container, not the root.',
    );
  }

  const parent = parentAtPath(state, segments);
  const leaf = segments.at(-1)!;

  switch (payload.operation) {
    case 'set':
      setContainerValue(parent, leaf, cloneJson(requireValue(payload)));
      return;
    case 'merge': {
      const value = requireValue(payload);
      if (!isJsonObject(value)) {
        throw new StateReconstructionError(
          'STATE_VALUE_INVALID',
          'The value of a merge operation must be a JSON object.',
        );
      }
      const existing = getContainerValue(parent, leaf);
      if (existing !== undefined && !isJsonObject(existing)) {
        throw new StateReconstructionError(
          'STATE_VALUE_INVALID',
          'The merge target must be a JSON object when it already exists.',
        );
      }
      setContainerValue(parent, leaf, {
        ...(isJsonObject(existing) ? existing : {}),
        ...cloneJson(value),
      });
      return;
    }
    case 'delete':
      deleteContainerValue(parent, leaf);
      return;
    case 'append': {
      const value = requireValue(payload);
      const target = containerAtPath(state, segments);
      if (!Array.isArray(target)) {
        throw new StateReconstructionError(
          'STATE_VALUE_INVALID',
          'The append target must be a JSON array.',
        );
      }
      target.push(cloneJson(value));
      return;
    }
  }
}

function checkpointFileName(sequence: number): string {
  return `${String(sequence).padStart(6, '0')}.json`;
}

function checkpointPath(directory: string, sequence: number): string {
  return join(directory, checkpointFileName(sequence));
}

function validCheckpointShape(value: unknown): value is Checkpoint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === snapshotSchemaVersion &&
    typeof value.checkpoint_id === 'string' &&
    typeof value.run_id === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.last_event_id === 'string' &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1 &&
    typeof value.state_hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.state_hash) &&
    (isJsonObject(value.state) || isArtifactReference(value.state))
  );
}

function checkpointInvalidMessage(checkpoint: unknown): string {
  return `Checkpoint is not a valid ${snapshotSchemaVersion} checkpoint: ${JSON.stringify(checkpoint)}`;
}

export class CheckpointStore {
  private readonly directory: string;
  private closed = false;

  private constructor(directory: string) {
    this.directory = resolve(directory);
  }

  static async open(directory: string): Promise<CheckpointStore> {
    const store = new CheckpointStore(directory);
    await mkdir(store.directory, { recursive: true });
    return store;
  }

  get checkpointDirectory(): string {
    return this.directory;
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.assertOpen();
    if (!validCheckpointShape(checkpoint)) {
      throw new CheckpointStoreError('CHECKPOINT_INVALID', checkpointInvalidMessage(checkpoint));
    }

    const targetPath = checkpointPath(this.directory, checkpoint.sequence);
    try {
      const existing = JSON.parse(await readFile(targetPath, 'utf8')) as unknown;
      if (JSON.stringify(existing) === JSON.stringify(checkpoint)) {
        return;
      }
      throw new CheckpointStoreError(
        'CHECKPOINT_SEQUENCE_COLLISION',
        `Checkpoint sequence ${checkpoint.sequence} is already stored with different content.`,
      );
    } catch (error) {
      if (error instanceof CheckpointStoreError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CheckpointStoreError(
          'CHECKPOINT_INVALID',
          error instanceof Error ? error.message : 'Could not inspect existing checkpoint.',
        );
      }
    }

    const temporaryPath = join(
      this.directory,
      `.${checkpointFileName(checkpoint.sequence)}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx');
      await handle.write(`${JSON.stringify(checkpoint, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async load(): Promise<CheckpointLoadResult> {
    this.assertOpen();
    const diagnostics: CheckpointDiagnostic[] = [];
    const checkpoints: Checkpoint[] = [];
    const fileNames = (await readdir(this.directory)).filter((fileName) =>
      fileName.endsWith('.json'),
    );

    for (const fileName of fileNames.sort()) {
      const filePath = join(this.directory, fileName);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      } catch (error) {
        diagnostics.push({
          code: 'CHECKPOINT_FILE_INVALID_JSON',
          file: fileName,
          message: error instanceof Error ? error.message : `Could not parse ${fileName}.`,
          severity: 'warning',
        });
        continue;
      }

      if (!validCheckpointShape(value)) {
        diagnostics.push({
          code: 'CHECKPOINT_INVALID',
          file: fileName,
          message: checkpointInvalidMessage(value),
          severity: 'warning',
        });
        continue;
      }
      checkpoints.push(value);
    }

    return { checkpoints, diagnostics };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CheckpointStoreError('CHECKPOINT_STORE_CLOSED', 'Checkpoint store is closed.');
    }
  }
}

function checkpointState(
  checkpoint: Checkpoint,
  resolveArtifact: StateArtifactResolver | undefined,
): Promise<RecoverableState> {
  if (isArtifactReference(checkpoint.state)) {
    if (resolveArtifact === undefined) {
      throw new StateReconstructionError(
        'STATE_VALUE_INVALID',
        `Checkpoint "${checkpoint.checkpoint_id}" stores state in an artifact but no resolver was provided.`,
      );
    }
    return resolveArtifact(checkpoint.state).then((value) => {
      if (!isJsonObject(value)) {
        throw new StateReconstructionError(
          'STATE_VALUE_INVALID',
          `Checkpoint "${checkpoint.checkpoint_id}" artifact state must resolve to a JSON object.`,
        );
      }
      return cloneJson(value);
    });
  }
  return Promise.resolve(cloneJson(checkpoint.state));
}

function eventAtSequence(
  events: readonly EventEnvelope<string, unknown>[],
  sequence: number,
): EventEnvelope<string, unknown> | undefined {
  return events.find((event) => event.sequence === sequence);
}

function validateEventStream(events: readonly EventEnvelope<string, unknown>[]): RunId | undefined {
  let runId: RunId | undefined;
  let previousSequence = 0;
  for (const event of events) {
    if (runId === undefined) {
      runId = event.run_id;
    } else if (event.run_id !== runId) {
      throw new StateReconstructionError(
        'EVENT_RUN_ID_MISMATCH',
        `Event "${event.event_id}" belongs to run "${event.run_id}", expected "${runId}".`,
      );
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence !== previousSequence + 1) {
      throw new StateReconstructionError(
        'EVENT_SEQUENCE_INVALID',
        `Event sequence ${event.sequence} is not the next sequence after ${previousSequence}.`,
      );
    }
    previousSequence = event.sequence;
  }
  return runId;
}

async function validCheckpointBase(
  checkpoint: Checkpoint,
  runId: RunId,
  events: readonly EventEnvelope<string, unknown>[],
  resolveArtifact: StateArtifactResolver | undefined,
): Promise<{ state: RecoverableState; diagnostic?: CheckpointDiagnostic }> {
  if (checkpoint.run_id !== runId) {
    return {
      state: {},
      diagnostic: {
        code: 'CHECKPOINT_RUN_ID_MISMATCH',
        checkpointId: checkpoint.checkpoint_id,
        message: `Checkpoint belongs to run "${checkpoint.run_id}", expected "${runId}".`,
        severity: 'warning',
      },
    };
  }

  const event = eventAtSequence(events, checkpoint.sequence);
  if (event?.event_id !== checkpoint.last_event_id) {
    return {
      state: {},
      diagnostic: {
        code: 'CHECKPOINT_EVENT_MISMATCH',
        checkpointId: checkpoint.checkpoint_id,
        message: `Checkpoint does not reference the event at sequence ${checkpoint.sequence}.`,
        severity: 'warning',
      },
    };
  }

  try {
    const state = await checkpointState(checkpoint, resolveArtifact);
    const actualHash = hashState(state);
    if (actualHash !== checkpoint.state_hash) {
      return {
        state: {},
        diagnostic: {
          code: 'CHECKPOINT_STATE_HASH_MISMATCH',
          checkpointId: checkpoint.checkpoint_id,
          message: `Checkpoint state hash ${actualHash} does not match declared hash ${checkpoint.state_hash}.`,
          severity: 'warning',
        },
      };
    }
    return { state };
  } catch (error) {
    return {
      state: {},
      diagnostic: {
        code: 'CHECKPOINT_STATE_UNAVAILABLE',
        checkpointId: checkpoint.checkpoint_id,
        message: error instanceof Error ? error.message : 'Checkpoint state is unavailable.',
        severity: 'warning',
      },
    };
  }
}

export async function reconstructState(
  events: readonly EventEnvelope<string, unknown>[],
  options: StateReconstructionOptions = {},
): Promise<StateReconstructionResult> {
  const runId = validateEventStream(events);
  const diagnostics: CheckpointDiagnostic[] = [];
  let checkpoints = options.checkpoints ?? [];

  if (options.checkpointStore !== undefined) {
    const loaded = await options.checkpointStore.load();
    checkpoints = loaded.checkpoints;
    diagnostics.push(...loaded.diagnostics);
  }

  let state: RecoverableState = {};
  let baseSequence = 0;
  let checkpointId: CheckpointId | undefined;

  if (runId !== undefined) {
    const candidates = [...checkpoints].sort((left, right) => right.sequence - left.sequence);
    for (const candidate of candidates) {
      const base = await validCheckpointBase(candidate, runId, events, options.resolveArtifact);
      if (base.diagnostic !== undefined) {
        diagnostics.push(base.diagnostic);
        continue;
      }
      state = base.state;
      baseSequence = candidate.sequence;
      checkpointId = candidate.checkpoint_id;
      break;
    }
  }

  for (const event of events) {
    if (event.sequence <= baseSequence || event.type !== 'state.changed') {
      continue;
    }

    let payload: unknown = event.payload;
    if (isArtifactReference(payload)) {
      if (options.resolveArtifact === undefined) {
        throw new StateReconstructionError(
          'STATE_VALUE_INVALID',
          `State event "${event.event_id}" stores its payload in an artifact but no resolver was provided.`,
        );
      }
      payload = await options.resolveArtifact(payload);
    }

    if (
      !isRecord(payload) ||
      typeof payload.path !== 'string' ||
      typeof payload.operation !== 'string'
    ) {
      throw new StateReconstructionError(
        'STATE_EVENT_INVALID',
        `State event "${event.event_id}" does not contain a valid state.changed payload.`,
      );
    }
    applyStateChanged(state, payload as unknown as StateChangedPayload);
  }

  const lastEvent = events.at(-1);
  return {
    state,
    stateHash: hashState(state),
    sequence: lastEvent?.sequence ?? 0,
    ...(lastEvent === undefined ? {} : { lastEventId: lastEvent.event_id }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
    usedCheckpoint: checkpointId !== undefined,
    diagnostics,
  };
}
