import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { snapshotSchemaVersion } from '@agent-loop-snapshot/schema/protocol';
import type {
  ArtifactReference,
  Checkpoint,
  CheckpointId,
  ErrorInfo,
  EventEnvelope,
  EventId,
  EventSecurity,
  EventType,
  JsonObject,
  JsonValue,
  RunId,
  RunStartedPayload,
  RuntimeDescriptor,
  SnapshotManifest,
} from '@agent-loop-snapshot/schema';

export const recorderPackageName = '@agent-loop-snapshot/recorder' as const;

export type RecorderRunStatus = 'running' | 'completed' | 'failed';

export interface RecorderClock {
  now(): Date;
  monotonicNow(): number;
}

export interface RecorderIdGenerator {
  createRunId(): RunId;
  createEventId(): EventId;
  createCheckpointId(): CheckpointId;
}

export interface RecorderInterceptor {
  /**
   * Runs before an event becomes visible through the Recorder. Durable sinks
   * should reject here so a failed write cannot advance in-memory run state.
   */
  beforeAppend?(
    event: Readonly<EventEnvelope<string, unknown>>,
  ):
    | Readonly<EventEnvelope<string, unknown>>
    | void
    | Promise<Readonly<EventEnvelope<string, unknown>> | void>;
  afterAppend?(event: Readonly<EventEnvelope<string, unknown>>): void | Promise<void>;
  /**
   * Runs before a checkpoint and its checkpoint.created event are committed.
   * Interceptors may transform the state and state hash, but not checkpoint identity.
   */
  beforeCheckpoint?(
    checkpoint: Readonly<Checkpoint>,
  ): Readonly<Checkpoint> | void | Promise<Readonly<Checkpoint> | void>;
  afterCheckpoint?(checkpoint: Readonly<Checkpoint>): void | Promise<void>;
}

export interface RecorderOptions {
  clock?: RecorderClock;
  idGenerator?: RecorderIdGenerator;
  interceptors?: readonly RecorderInterceptor[];
  defaultActor?: string;
}

export interface StartRunOptions {
  runtime: RuntimeDescriptor;
  input?: JsonValue | ArtifactReference;
  actor?: string;
  security?: EventSecurity;
}

export interface EventContext {
  readonly runId: RunId;
  readonly parentIds: readonly EventId[];
  readonly actor: string;
}

export interface RunHandle {
  readonly runId: RunId;
  readonly startedEvent: EventEnvelope<'run.started', RunStartedPayload>;
  readonly actor: string;
  readonly lastEventId: EventId;
  readonly status: RecorderRunStatus;
  context(parentIds?: readonly EventId[], actor?: string): EventContext;
}

export interface AppendEventInput<
  TType extends string = string,
  TPayload = JsonObject | ArtifactReference,
> {
  type: TType;
  payload: TPayload;
  actor?: string;
  security?: EventSecurity;
}

export interface LifecycleEventOptions {
  actor?: string;
  security?: EventSecurity;
  context?: EventContext;
}

export interface CheckpointInput {
  state: JsonObject | ArtifactReference;
  stateHash: string;
  actor?: string;
  security?: EventSecurity;
  context?: EventContext;
}

export class RecorderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

export class InvalidLifecycleTransitionError extends RecorderError {
  constructor(message: string) {
    super('INVALID_LIFECYCLE_TRANSITION', message);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

interface RunRecord {
  readonly runId: RunId;
  readonly actor: string;
  readonly runtime: RuntimeDescriptor;
  readonly createdAt: Date;
  readonly startedMonotonic: number;
  readonly startedEvent: EventEnvelope<'run.started', RunStartedPayload>;
  readonly events: EventEnvelope<string, unknown>[];
  readonly checkpoints: Checkpoint[];
  queue: Promise<void>;
  nextSequence: number;
  status: RecorderRunStatus;
}

const defaultClock: RecorderClock = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

const defaultIdGenerator: RecorderIdGenerator = {
  createRunId: () => `run_${randomUUID()}` as RunId,
  createEventId: () => `evt_${randomUUID()}` as EventId,
  createCheckpointId: () => `cp_${randomUUID()}` as CheckpointId,
};

const defaultSecurity: EventSecurity = {
  side_effect: 'read_only',
  redactions: [],
};

const reservedEventTypes = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'checkpoint.created',
]);

function cloneSecurity(security: EventSecurity | undefined): EventSecurity {
  return {
    side_effect: security?.side_effect ?? defaultSecurity.side_effect,
    redactions: security?.redactions.map((redaction) => ({ ...redaction })) ?? [],
  };
}

function createContext(runId: RunId, parentIds: readonly EventId[], actor: string): EventContext {
  return Object.freeze({
    runId,
    parentIds: Object.freeze([...parentIds]),
    actor,
  });
}

function sameParentIds(left: readonly EventId[], right: readonly EventId[]): boolean {
  return left.length === right.length && left.every((parentId, index) => parentId === right[index]);
}

class RunHandleImpl implements RunHandle {
  constructor(private readonly record: RunRecord) {}

  get runId(): RunId {
    return this.record.runId;
  }

  get startedEvent(): EventEnvelope<'run.started', RunStartedPayload> {
    return this.record.startedEvent;
  }

  get actor(): string {
    return this.record.actor;
  }

  get lastEventId(): EventId {
    return this.record.events[this.record.events.length - 1]!.event_id;
  }

  get status(): RecorderRunStatus {
    return this.record.status;
  }

  context(
    parentIds: readonly EventId[] = [this.lastEventId],
    actor = this.record.actor,
  ): EventContext {
    return createContext(this.record.runId, parentIds, actor);
  }
}

export class Recorder {
  private readonly clock: RecorderClock;
  private readonly ids: RecorderIdGenerator;
  private readonly interceptors: readonly RecorderInterceptor[];
  private readonly defaultActor: string;
  private readonly runs = new Map<RunId, RunRecord>();

  constructor(options: RecorderOptions = {}) {
    this.clock = options.clock ?? defaultClock;
    this.ids = options.idGenerator ?? defaultIdGenerator;
    this.interceptors = options.interceptors ?? [];
    this.defaultActor = options.defaultActor ?? 'agent.main';
  }

  async startRun(options: StartRunOptions): Promise<RunHandle> {
    const runId = this.ids.createRunId();
    if (this.runs.has(runId)) {
      throw new RecorderError('DUPLICATE_RUN_ID', `Run ID "${runId}" already exists.`);
    }

    const actor = options.actor ?? this.defaultActor;
    const createdAt = this.clock.now();
    const startedMonotonic = this.clock.monotonicNow();
    const record = {
      runId,
      actor,
      runtime: options.runtime,
      createdAt,
      startedMonotonic,
      startedEvent: undefined as unknown as EventEnvelope<'run.started', RunStartedPayload>,
      events: [],
      checkpoints: [],
      queue: Promise.resolve(),
      nextSequence: 1,
      status: 'running' as const,
    } satisfies RunRecord;

    this.runs.set(runId, record);

    try {
      const startedEvent = this.buildEvent(
        record,
        createContext(runId, [], actor),
        {
          type: 'run.started',
          payload: {
            runtime: options.runtime,
            ...(options.input === undefined ? {} : { input: options.input }),
          },
          actor,
          ...(options.security === undefined ? {} : { security: options.security }),
        },
        true,
      ) as EventEnvelope<'run.started', RunStartedPayload>;
      record.startedEvent = await this.commitEvent(record, startedEvent);
      return new RunHandleImpl(record);
    } catch (error) {
      this.runs.delete(runId);
      throw error;
    }
  }

  context(run: RunHandle | RunId, parentIds?: readonly EventId[], actor?: string): EventContext {
    const record = this.getRun(run);
    const defaultParent = record.events[record.events.length - 1]?.event_id;
    return createContext(
      record.runId,
      parentIds ?? (defaultParent === undefined ? [] : [defaultParent]),
      actor ?? record.actor,
    );
  }

  appendEvent<TType extends string, TPayload>(
    context: EventContext,
    input: AppendEventInput<TType, TPayload>,
  ): Promise<EventEnvelope<TType, TPayload>> {
    const record = this.getRun(context.runId);
    return this.enqueue(record, async () => {
      this.assertRunning(record);
      this.assertContext(record, context);
      if (reservedEventTypes.has(input.type)) {
        throw new RecorderError(
          'RESERVED_EVENT_TYPE',
          `Event type "${input.type}" must be emitted through its lifecycle API.`,
        );
      }

      const event = this.buildEvent(record, context, input);
      return this.commitEvent(record, event) as Promise<EventEnvelope<TType, TPayload>>;
    });
  }

  completeRun(
    run: RunHandle | RunId,
    payload: { final_state_hash: string; output?: JsonValue | ArtifactReference },
    options: LifecycleEventOptions = {},
  ): Promise<EventEnvelope<'run.completed', typeof payload>> {
    const record = this.getRun(run);
    return this.enqueue(record, async () => {
      this.assertRunning(record);
      const context = options.context ?? this.context(record.runId);
      this.assertContext(record, context);
      const event = this.buildEvent(
        record,
        context,
        {
          type: 'run.completed',
          payload,
          ...(options.actor === undefined ? {} : { actor: options.actor }),
          ...(options.security === undefined ? {} : { security: options.security }),
        },
        true,
      ) as EventEnvelope<'run.completed', typeof payload>;

      return this.commitEvent(record, event, () => {
        record.status = 'completed';
      }) as Promise<EventEnvelope<'run.completed', typeof payload>>;
    });
  }

  failRun(
    run: RunHandle | RunId,
    error: ErrorInfo,
    options: LifecycleEventOptions = {},
  ): Promise<EventEnvelope<'run.failed', { error: ErrorInfo }>> {
    const record = this.getRun(run);
    return this.enqueue(record, async () => {
      this.assertRunning(record);
      const context = options.context ?? this.context(record.runId);
      this.assertContext(record, context);
      const event = this.buildEvent(
        record,
        context,
        {
          type: 'run.failed',
          payload: { error },
          ...(options.actor === undefined ? {} : { actor: options.actor }),
          ...(options.security === undefined ? {} : { security: options.security }),
        },
        true,
      ) as EventEnvelope<'run.failed', { error: ErrorInfo }>;

      return this.commitEvent(record, event, () => {
        record.status = 'failed';
      }) as Promise<EventEnvelope<'run.failed', { error: ErrorInfo }>>;
    });
  }

  checkpoint(run: RunHandle | RunId, input: CheckpointInput): Promise<Checkpoint> {
    const record = this.getRun(run);
    return this.enqueue(record, async () => {
      this.assertRunning(record);
      const context = input.context ?? this.context(record.runId);
      this.assertContext(record, context);
      const lastEvent = record.events[record.events.length - 1];
      if (lastEvent === undefined) {
        throw new RecorderError('CHECKPOINT_WITHOUT_EVENT', 'A checkpoint requires a prior event.');
      }

      const checkpointId = this.ids.createCheckpointId();
      let checkpointEvent = this.buildEvent(
        record,
        context,
        {
          type: 'checkpoint.created',
          payload: {
            checkpoint_id: checkpointId,
            last_event_id: lastEvent.event_id,
            sequence: lastEvent.sequence,
            state_hash: input.stateHash,
          },
          ...(input.actor === undefined ? {} : { actor: input.actor }),
          ...(input.security === undefined ? {} : { security: input.security }),
        },
        true,
      );
      const checkpoint: Checkpoint = {
        schema_version: snapshotSchemaVersion,
        checkpoint_id: checkpointId,
        run_id: record.runId,
        created_at: checkpointEvent.timestamp,
        last_event_id: lastEvent.event_id,
        sequence: lastEvent.sequence,
        state_hash: input.stateHash,
        state: input.state,
      };

      let transformedCheckpoint = checkpoint;
      for (const interceptor of this.interceptors) {
        const intercepted = await interceptor.beforeCheckpoint?.(transformedCheckpoint);
        if (intercepted !== undefined) {
          this.assertCheckpointIdentityPreserved(transformedCheckpoint, intercepted);
          transformedCheckpoint = intercepted as Checkpoint;
        }
      }
      checkpointEvent = {
        ...checkpointEvent,
        payload: {
          ...checkpointEvent.payload,
          state_hash: transformedCheckpoint.state_hash,
        },
      };

      await this.commitEvent(record, checkpointEvent, () => {
        record.checkpoints.push(transformedCheckpoint);
      });

      for (const interceptor of this.interceptors) {
        try {
          await interceptor.afterCheckpoint?.(transformedCheckpoint);
        } catch (error) {
          throw new RecorderError(
            'INTERCEPTOR_FAILED_AFTER_CHECKPOINT',
            error instanceof Error
              ? error.message
              : 'An afterCheckpoint interceptor failed after commit.',
          );
        }
      }
      return transformedCheckpoint;
    });
  }

  getEvents(run: RunHandle | RunId): readonly EventEnvelope<string, unknown>[] {
    return [...this.getRun(run).events];
  }

  getCheckpoints(run: RunHandle | RunId): readonly Checkpoint[] {
    return [...this.getRun(run).checkpoints];
  }

  getManifest(run: RunHandle | RunId): SnapshotManifest {
    const record = this.getRun(run);
    const lastEvent = record.events[record.events.length - 1];
    const terminalStatus = record.status === 'running' ? null : record.status;
    const updatedAt = lastEvent?.timestamp ?? record.createdAt.toISOString();
    return {
      schema_version: snapshotSchemaVersion,
      snapshot_type: 'run-snapshot',
      run_id: record.runId,
      created_at: record.createdAt.toISOString(),
      updated_at: updatedAt,
      run_state: record.status === 'running' ? 'running' : 'finished',
      terminal_status: terminalStatus,
      runtime: record.runtime,
      source: 'native',
      completeness: record.status === 'running' ? 'partial' : 'complete',
      limitations:
        record.status === 'running'
          ? [{ code: 'recording_failed', message: 'Run has not reached a terminal state.' }]
          : [],
      last_sequence: lastEvent?.sequence ?? 0,
      event_count: record.events.length,
      root_event_id: record.startedEvent.event_id,
      ...(record.status === 'running' ? {} : { completed_at: updatedAt }),
    };
  }

  private getRun(run: RunHandle | RunId): RunRecord {
    const runId = typeof run === 'string' ? run : run.runId;
    const record = this.runs.get(runId);
    if (record === undefined) {
      throw new RecorderError('RUN_NOT_FOUND', `Run "${runId}" does not exist.`);
    }
    return record;
  }

  private enqueue<T>(record: RunRecord, operation: () => Promise<T>): Promise<T> {
    const result = record.queue.then(operation);
    record.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertRunning(record: RunRecord): void {
    if (record.status !== 'running') {
      throw new InvalidLifecycleTransitionError(
        `Run "${record.runId}" is already ${record.status}; no more events can be appended.`,
      );
    }
  }

  private assertContext(record: RunRecord, context: EventContext): void {
    if (context.runId !== record.runId) {
      throw new RecorderError('CONTEXT_RUN_MISMATCH', 'Event context belongs to a different run.');
    }

    const eventIds = new Set(record.events.map((event) => event.event_id));
    if (context.parentIds.length === 0) {
      throw new RecorderError(
        'MISSING_PARENT_CONTEXT',
        'Events after run.started require at least one parent.',
      );
    }

    for (const parentId of context.parentIds) {
      if (!eventIds.has(parentId)) {
        throw new RecorderError(
          'MISSING_PARENT_EVENT',
          `Parent event "${parentId}" is not present in this run.`,
        );
      }
    }
  }

  private buildEvent<TType extends string, TPayload>(
    record: RunRecord,
    context: EventContext,
    input: AppendEventInput<TType, TPayload>,
    allowLifecycle = false,
  ): EventEnvelope<TType, TPayload> {
    if (!allowLifecycle && reservedEventTypes.has(input.type)) {
      throw new RecorderError(
        'RESERVED_EVENT_TYPE',
        `Event type "${input.type}" must be emitted through its lifecycle API.`,
      );
    }

    if (record.events.length > 0) {
      this.assertContext(record, context);
    }

    const now = this.clock.now();
    return {
      schema_version: snapshotSchemaVersion,
      run_id: record.runId,
      event_id: this.ids.createEventId(),
      parent_ids: [...context.parentIds],
      sequence: record.nextSequence,
      type: input.type,
      timestamp: now.toISOString(),
      monotonic_offset_ms: Math.max(0, this.clock.monotonicNow() - record.startedMonotonic),
      actor: input.actor ?? context.actor,
      payload: input.payload,
      security: cloneSecurity(input.security),
    } as EventEnvelope<TType, TPayload>;
  }

  private async commitEvent<TType extends string, TPayload>(
    record: RunRecord,
    initialEvent: EventEnvelope<TType, TPayload>,
    onCommitted?: () => void,
  ): Promise<EventEnvelope<TType, TPayload>> {
    let event: EventEnvelope<string, unknown> = initialEvent as EventEnvelope<string, unknown>;

    if (record.events.some((existingEvent) => existingEvent.event_id === event.event_id)) {
      throw new RecorderError('DUPLICATE_EVENT_ID', `Event ID "${event.event_id}" already exists.`);
    }

    for (const interceptor of this.interceptors) {
      const intercepted = await interceptor.beforeAppend?.(event);
      if (intercepted !== undefined) {
        this.assertIdentityPreserved(event, intercepted);
        event = intercepted as EventEnvelope<string, unknown>;
      }
    }

    for (const interceptor of this.interceptors) {
      try {
        await interceptor.afterAppend?.(event);
      } catch (error) {
        throw new RecorderError(
          'INTERCEPTOR_FAILED_BEFORE_COMMIT',
          error instanceof Error
            ? `Event was not committed because an afterAppend interceptor failed: ${error.message}`
            : 'Event was not committed because an afterAppend interceptor failed.',
        );
      }
    }

    record.events.push(event);
    record.nextSequence += 1;
    onCommitted?.();

    return event as EventEnvelope<TType, TPayload>;
  }

  private assertIdentityPreserved(
    original: EventEnvelope<string, unknown>,
    intercepted: Readonly<EventEnvelope<string, unknown>>,
  ): void {
    if (
      intercepted.schema_version !== original.schema_version ||
      intercepted.run_id !== original.run_id ||
      intercepted.event_id !== original.event_id ||
      intercepted.sequence !== original.sequence ||
      intercepted.type !== original.type ||
      intercepted.timestamp !== original.timestamp ||
      intercepted.monotonic_offset_ms !== original.monotonic_offset_ms ||
      intercepted.actor !== original.actor ||
      !sameParentIds(intercepted.parent_ids, original.parent_ids)
    ) {
      throw new RecorderError(
        'INTERCEPTOR_IDENTITY_MUTATION',
        'An interceptor may transform payload or security fields but not event identity or ordering fields.',
      );
    }
  }

  private assertCheckpointIdentityPreserved(
    original: Readonly<Checkpoint>,
    intercepted: Readonly<Checkpoint>,
  ): void {
    if (
      intercepted.schema_version !== original.schema_version ||
      intercepted.checkpoint_id !== original.checkpoint_id ||
      intercepted.run_id !== original.run_id ||
      intercepted.created_at !== original.created_at ||
      intercepted.last_event_id !== original.last_event_id ||
      intercepted.sequence !== original.sequence
    ) {
      throw new RecorderError(
        'INTERCEPTOR_IDENTITY_MUTATION',
        'A checkpoint interceptor may transform state or state_hash but not checkpoint identity.',
      );
    }
  }
}

export type RecorderEventType = EventType | (string & {});

export * from './checkpoints.js';

export * from './artifacts.js';
export * from './redaction.js';
export * from './writer.js';
