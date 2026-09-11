import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  Recorder,
  SnapshotWriter,
  createDefaultRedactionPipeline,
  hashState,
  type RedactionPipeline,
  type RedactionPipelineOptions,
} from '@agent-loop-snapshot/recorder';
import type {
  Checkpoint,
  ErrorInfo,
  EventEnvelope,
  JsonObject,
  JsonValue,
  RuntimeDescriptor,
  SideEffectLevel,
  SnapshotManifest,
} from '@agent-loop-snapshot/schema';

import {
  currentInstrumentationScope,
  drainInstrumentationOperations,
  runWithInstrumentationScope,
  runWithInstrumentationSuppression,
  trackInstrumentationOperation,
  type InstrumentationRun,
  type InstrumentationScope,
} from './context.js';
import { InstrumentationError, type InstrumentationDiagnostic } from './index.js';

// `any` is restricted to this constraint: it lets TypeScript infer the actual
// argument tuple and promise result from a user-supplied async function.
// Public APIs below expose Parameters<T> and Awaited<ReturnType<T>>, never this
// catch-all constraint.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncFunction = (...args: any[]) => Promise<any>;

type AsyncReturn<TFunction extends AsyncFunction> = Awaited<ReturnType<TFunction>>;

export interface ModelDefinition<TCall extends AsyncFunction> {
  readonly name: string;
  readonly call: TCall;
  readonly serializeInput?: (...args: Parameters<TCall>) => unknown;
  readonly serializeOutput?: (output: AsyncReturn<TCall>) => unknown;
}

export interface ToolDefinition<TCall extends AsyncFunction> {
  readonly sideEffect: SideEffectLevel;
  readonly call: TCall;
  readonly serializeInput?: (...args: Parameters<TCall>) => unknown;
  readonly serializeOutput?: (output: AsyncReturn<TCall>) => unknown;
}

export type ToolDefinitions = Readonly<Record<string, ToolDefinition<AsyncFunction>>>;

type WrappedCall<TFunction extends AsyncFunction> = (
  ...args: Parameters<TFunction>
) => ReturnType<TFunction>;

export type WrappedTools<TTools extends ToolDefinitions> = {
  readonly [TName in keyof TTools]: WrappedCall<TTools[TName]['call']>;
};

export interface InstrumentRunContext<
  TModel extends ModelDefinition<AsyncFunction>,
  TTools extends ToolDefinitions,
> {
  readonly model: { readonly call: WrappedCall<TModel['call']> };
  readonly tools: WrappedTools<TTools>;
  checkpoint(state: JsonObject): Promise<void>;
}

export interface InstrumentSnapshot {
  readonly directory: string;
  readonly manifest: SnapshotManifest;
}

export interface InstrumentOptions<
  TModel extends ModelDefinition<AsyncFunction>,
  TTools extends ToolDefinitions,
> {
  /** Parent directory. Every run receives an exclusive random child directory. */
  readonly snapshotDir: string;
  readonly runtime: RuntimeDescriptor;
  readonly model: TModel;
  readonly tools: TTools;
  readonly recordingFailure?: 'strict';
  readonly redaction?: RedactionPipelineOptions;
  readonly maxRecordBytes?: number;
  readonly drainTimeoutMs?: number;
  readonly onSnapshot?: (snapshot: InstrumentSnapshot) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: InstrumentationDiagnostic) => void;
}

export interface InstrumentedAgent<
  TModel extends ModelDefinition<AsyncFunction>,
  TTools extends ToolDefinitions,
> {
  run<TInput extends JsonValue, TResult>(
    options: { readonly input: TInput },
    operation: (context: InstrumentRunContext<TModel, TTools>) => TResult | Promise<TResult>,
  ): Promise<TResult>;
}

interface GenericRun extends InstrumentationRun {
  readonly directory: string;
  readonly pending: Set<Promise<unknown>>;
  /** Joined runs redact their own generic events before the SDK Recorder sees them. */
  readonly joinedRedaction: RedactionPipeline | undefined;
  checkpointSequence: number | undefined;
  acceptingCalls: boolean;
}

class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies only JSON primitives, arrays, and plain own data properties. SDK
 * integrations use this to avoid evaluating application getters or arbitrary
 * `toJSON` methods while taking a recording-only copy.
 */
export function safeJsonCopy(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SerializationError('Non-finite numbers require an explicit serializer.');
    }
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    throw new SerializationError('BigInt requires an explicit serializer.');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SerializationError(`${typeof value} values require an explicit serializer.`);
  }
  if (typeof value !== 'object') {
    throw new SerializationError('Value requires an explicit serializer.');
  }
  if (seen.has(value)) {
    throw new SerializationError('Cyclic values require an explicit serializer.');
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new SerializationError(
      `${value.constructor?.name ?? 'Class'} instances require an explicit serializer.`,
    );
  }

  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: JsonValue[] | JsonObject = Array.isArray(value) ? [] : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'length' && Array.isArray(value)) {
      continue;
    }
    if (!descriptor.enumerable) {
      continue;
    }
    if (!('value' in descriptor)) {
      throw new SerializationError(`Getter "${key}" requires an explicit serializer.`);
    }
    if (Array.isArray(result)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(key)) {
        throw new SerializationError(`Array property "${key}" requires an explicit serializer.`);
      }
      result[Number(key)] = safeJsonCopy(descriptor.value, seen);
    } else {
      result[key] = safeJsonCopy(descriptor.value, seen);
    }
  }
  seen.delete(value);
  return result;
}

function errorInfo(error: unknown, code: string, kind: ErrorInfo['kind']): ErrorInfo {
  return {
    code,
    message:
      error instanceof Error && error.message !== '' ? error.message : 'The wrapped call failed.',
    retryable: false,
    ...(kind === undefined ? {} : { kind }),
  };
}

class Agent<
  TModel extends ModelDefinition<AsyncFunction>,
  TTools extends ToolDefinitions,
> implements InstrumentedAgent<TModel, TTools> {
  private readonly snapshotDir: string;
  private readonly maxRecordBytes: number;
  private readonly drainTimeoutMs: number;
  private readonly redaction: RedactionPipelineOptions;
  private readonly onSnapshot: ((snapshot: InstrumentSnapshot) => void | Promise<void>) | undefined;
  private readonly onDiagnostic: ((diagnostic: InstrumentationDiagnostic) => void) | undefined;

  constructor(private readonly options: InstrumentOptions<TModel, TTools>) {
    this.snapshotDir = resolve(options.snapshotDir);
    this.maxRecordBytes = Math.max(1, Math.floor(options.maxRecordBytes ?? 256 * 1024));
    this.drainTimeoutMs = Math.max(0, Math.floor(options.drainTimeoutMs ?? 5_000));
    this.redaction = options.redaction ?? {};
    this.onSnapshot = options.onSnapshot;
    this.onDiagnostic = options.onDiagnostic;
  }

  async run<TInput extends JsonValue, TResult>(
    options: { readonly input: TInput },
    operation: (context: InstrumentRunContext<TModel, TTools>) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const existingScope = currentInstrumentationScope();
    if (existingScope?.generic === true) {
      throw new InstrumentationError(
        'NESTED_RUN_NOT_SUPPORTED',
        'Nested instrument().run() calls are not supported. Reuse the current run context instead.',
      );
    }
    if (existingScope !== undefined) {
      return trackInstrumentationOperation(
        existingScope.activeRun,
        this.runJoined(existingScope, operation),
      );
    }
    return this.runRoot(options, operation);
  }

  private async runRoot<TInput extends JsonValue, TResult>(
    options: { readonly input: TInput },
    operation: (context: InstrumentRunContext<TModel, TTools>) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const active = await this.startRun(this.serialize(options.input));
    const context = this.createContext(active);
    let result: TResult | undefined;
    let businessError: unknown;
    try {
      result = await runWithInstrumentationScope(
        {
          activeRun: active,
          parentIds: [active.run.startedEvent.event_id],
          allowedIntegrations: undefined,
          generic: true,
          suppressed: false,
        },
        () => operation(context),
      );
    } catch (error) {
      businessError = error;
    }

    const drained = await this.drain(active, true);
    active.acceptingCalls = false;
    if (!drained) {
      active.recorder.markIncomplete(active.run, {
        code: 'drain_timed_out',
        message: `Wrapped calls did not settle within ${this.drainTimeoutMs}ms.`,
      });
    }

    try {
      if (businessError !== undefined) {
        active.recorder.markIncomplete(active.run, {
          code: 'final_state_unavailable',
          message: 'The run failed before a final successful state could be established.',
        });
        await active.recorder.failRun(
          active.run,
          errorInfo(businessError, 'INSTRUMENTED_RUN_FAILED', 'runtime'),
        );
      } else if (drained && this.canComplete(active)) {
        const checkpoint = active.recorder.getCheckpoints(active.run).at(-1)!;
        await active.recorder.completeRun(active.run, { final_state_hash: checkpoint.state_hash });
      } else {
        if (active.checkpointSequence === undefined) {
          active.recorder.addLimitation(active.run, {
            code: 'final_state_unavailable',
            message: 'No final explicit checkpoint was recorded.',
          });
        } else if (drained) {
          active.recorder.addLimitation(active.run, {
            code: 'final_state_unavailable',
            message: 'Recorded calls occurred after the last explicit checkpoint.',
          });
        }
        await active.recorder.observeRun(active.run, {
          outcome: businessError === undefined ? 'completed' : 'failed',
        });
      }
      await active.writer.commit(active.recorder.getManifest(active.run));
    } catch (recordingError) {
      this.report({
        code: 'RECORDING_FINALIZATION_FAILED',
        message: `Could not finalize instrumented run: ${message(recordingError)}`,
      });
      if (businessError === undefined) {
        throw recordingError;
      }
    } finally {
      await active.writer.close().catch((error: unknown) => {
        this.report({
          code: 'RECORDING_FINALIZATION_FAILED',
          message: `Could not close instrumented run: ${message(error)}`,
        });
      });
    }

    const snapshot = {
      directory: active.directory,
      manifest: active.recorder.getManifest(active.run),
    };
    try {
      await this.onSnapshot?.(snapshot);
    } catch (error) {
      this.report({
        code: 'DIAGNOSTIC_CALLBACK_FAILED',
        message: `onSnapshot callback failed: ${message(error)}`,
      });
    }

    if (businessError !== undefined) {
      throw businessError;
    }
    return result as TResult;
  }

  private async runJoined<TResult>(
    scope: InstrumentationScope,
    operation: (context: InstrumentRunContext<TModel, TTools>) => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const active: GenericRun = {
      ...scope.activeRun,
      directory: scope.activeRun.snapshotDirectory,
      pending: new Set(),
      joinedRedaction: createDefaultRedactionPipeline(this.redaction),
      checkpointSequence: undefined,
      acceptingCalls: true,
    };
    const context = this.createContext(active);
    let result: TResult | undefined;
    let businessError: unknown;
    try {
      result = await runWithInstrumentationScope(
        {
          activeRun: active,
          parentIds: scope.parentIds,
          allowedIntegrations: scope.allowedIntegrations,
          generic: true,
          suppressed: scope.suppressed,
        },
        () => operation(context),
      );
    } catch (error) {
      businessError = error;
    }

    const drained = await this.drain(active);
    active.acceptingCalls = false;
    if (!drained) {
      active.recorder.markIncomplete(active.run, {
        code: 'drain_timed_out',
        message: `Joined wrapped calls did not settle within ${this.drainTimeoutMs}ms.`,
      });
    }
    if (businessError !== undefined) {
      active.recorder.markIncomplete(active.run, {
        code: 'final_state_unavailable',
        message:
          'A joined wrapped operation failed before a final successful state was established.',
      });
      throw businessError;
    }
    return result as TResult;
  }

  private async startRun(input: JsonValue): Promise<GenericRun> {
    const directory = await this.createRunDirectory();
    const writer = await SnapshotWriter.open(directory);
    const recorder = new Recorder({
      interceptors: [
        createDefaultRedactionPipeline(this.redaction).asInterceptor(),
        writer.asInterceptor(),
      ],
    });
    try {
      const run = await recorder.startRun({ runtime: this.options.runtime, input });
      await writer.writeManifest(recorder.getManifest(run));
      return {
        recorder,
        writer,
        run,
        directory,
        snapshotDirectory: directory,
        pending: new Set(),
        joinedRedaction: undefined,
        checkpointSequence: undefined,
        acceptingCalls: true,
      };
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  }

  private createContext(active: GenericRun): InstrumentRunContext<TModel, TTools> {
    const tools = Object.fromEntries(
      Object.entries(this.options.tools).map(([name, definition]) => [
        name,
        this.wrapCall(active, 'tool', name, definition),
      ]),
    ) as WrappedTools<TTools>;
    return {
      model: { call: this.wrapCall(active, 'model', this.options.model.name, this.options.model) },
      tools,
      checkpoint: async (state) => {
        const copied = this.serialize(state);
        if (!isJsonObject(copied)) {
          throw new SerializationError('Checkpoint state must serialize to a JSON object.');
        }
        const checkpointInput = await this.redactCheckpoint(active, copied);
        const checkpoint = await active.recorder.checkpoint(active.run, checkpointInput);
        active.checkpointSequence = active.recorder.getEvents(active.run).at(-1)?.sequence;
        if (checkpoint.state_hash !== hashState(copied)) {
          this.report({
            code: 'RECORDING_FINALIZATION_FAILED',
            message: 'Checkpoint redaction changed the stored state hash.',
          });
        }
      },
    };
  }

  private wrapCall<TCall extends AsyncFunction>(
    active: GenericRun,
    kind: 'model' | 'tool',
    name: string,
    definition: ModelDefinition<TCall> | ToolDefinition<TCall>,
  ): WrappedCall<TCall> {
    return ((...args: Parameters<TCall>) => {
      if (!active.acceptingCalls) {
        return Promise.reject(
          new InstrumentationError(
            'INSTRUMENTATION_SHUTDOWN',
            'The instrumented run is closed and cannot start another wrapped call.',
          ),
        ) as ReturnType<TCall>;
      }
      const pending = this.recordCall(active, kind, name, definition, args);
      active.pending.add(pending);
      void pending.then(
        () => active.pending.delete(pending),
        () => active.pending.delete(pending),
      );
      return pending as ReturnType<TCall>;
    }) as WrappedCall<TCall>;
  }

  private async recordCall<TCall extends AsyncFunction>(
    active: GenericRun,
    kind: 'model' | 'tool',
    name: string,
    definition: ModelDefinition<TCall> | ToolDefinition<TCall>,
    args: Parameters<TCall>,
  ): Promise<AsyncReturn<TCall>> {
    const scope = currentInstrumentationScope();
    const parentIds =
      scope?.activeRun === active ? scope.parentIds : [active.run.startedEvent.event_id];
    const serializedInput = this.serialize(
      definition.serializeInput === undefined ? { args } : definition.serializeInput(...args),
    );
    const correlationKey = `${kind}:${randomUUID()}`;
    const requested = await this.appendGenericEvent(active, active.run.context(parentIds), {
      type: `${kind}.requested`,
      payload:
        kind === 'model'
          ? { correlation_key: correlationKey, model: name, input: serializedInput }
          : {
              correlation_key: correlationKey,
              tool: name,
              arguments: asJsonObject(serializedInput),
            },
      ...(kind === 'tool'
        ? {
            security: {
              side_effect: (definition as ToolDefinition<TCall>).sideEffect,
              redactions: [],
            },
          }
        : {}),
    });

    try {
      const output = (await runWithInstrumentationScope(
        {
          activeRun: active,
          parentIds: [requested.event_id],
          allowedIntegrations: scope?.allowedIntegrations,
          generic: true,
          suppressed: false,
        },
        () =>
          kind === 'model'
            ? runWithInstrumentationSuppression(() => definition.call(...args))
            : definition.call(...args),
      )) as AsyncReturn<TCall>;
      const serializedOutput = this.serialize(
        definition.serializeOutput === undefined ? output : definition.serializeOutput(output),
      );
      await this.appendGenericEvent(active, active.run.context([requested.event_id]), {
        type: `${kind}.completed`,
        payload: { correlation_key: correlationKey, output: serializedOutput },
        ...(kind === 'tool'
          ? {
              security: {
                side_effect: (definition as ToolDefinition<TCall>).sideEffect,
                redactions: [],
              },
            }
          : {}),
      });
      return output;
    } catch (businessError) {
      try {
        await this.appendGenericEvent(active, active.run.context([requested.event_id]), {
          type: `${kind}.failed`,
          payload: {
            correlation_key: correlationKey,
            error: errorInfo(businessError, `${kind.toUpperCase()}_CALL_FAILED`, kind),
            attempt: 1,
          },
          ...(kind === 'tool'
            ? {
                security: {
                  side_effect: (definition as ToolDefinition<TCall>).sideEffect,
                  redactions: [],
                },
              }
            : {}),
        });
      } catch (recordingError) {
        this.report({
          code: 'RECORDING_FINALIZATION_FAILED',
          message: `Could not record ${kind} failure: ${message(recordingError)}`,
        });
      }
      throw businessError;
    }
  }

  private serialize(value: unknown): JsonValue {
    const copy = safeJsonCopy(value);
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes > this.maxRecordBytes) {
      throw new SerializationError(
        `Record copy is ${bytes} bytes, exceeding the ${this.maxRecordBytes}-byte limit. Use an explicit artifact instead.`,
      );
    }
    return copy;
  }

  private async appendGenericEvent(
    active: GenericRun,
    context: ReturnType<GenericRun['run']['context']>,
    input: Parameters<Recorder['appendEvent']>[1],
  ): Promise<EventEnvelope<string, unknown>> {
    if (active.joinedRedaction === undefined) {
      return active.recorder.appendEvent(context, input);
    }
    // RedactionPipeline only reads these three envelope fields. The Recorder
    // supplies identity, ordering, and timestamps after this transformation.
    const redacted = await active.joinedRedaction.redactEvent({
      type: input.type,
      payload: input.payload,
      security: input.security,
    } as EventEnvelope<string, unknown>);
    return active.recorder.appendEvent(context, {
      ...input,
      payload: redacted.payload,
      security: redacted.security,
    });
  }

  private async redactCheckpoint(
    active: GenericRun,
    state: JsonObject,
  ): Promise<{ state: JsonObject; stateHash: string }> {
    const stateHash = hashState(state);
    if (active.joinedRedaction === undefined) {
      return { state, stateHash };
    }
    // RedactionPipeline only reads state and state_hash here; Recorder creates
    // the checkpoint identity and durable checkpoint.created event.
    const redacted = await active.joinedRedaction.redactCheckpoint({
      state,
      state_hash: stateHash,
    } as Checkpoint);
    return { state: redacted.state as JsonObject, stateHash: redacted.state_hash };
  }

  private canComplete(active: GenericRun): boolean {
    const lastSequence = active.recorder.getEvents(active.run).at(-1)?.sequence;
    return active.checkpointSequence !== undefined && active.checkpointSequence === lastSequence;
  }

  private async drain(active: GenericRun, includeTrackedIntegrationWork = false): Promise<boolean> {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (true) {
      while (active.pending.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return false;
        }
        const settled = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), remaining);
          void Promise.allSettled([...active.pending]).then(() => {
            clearTimeout(timeout);
            resolve(true);
          });
        });
        if (!settled) {
          return false;
        }
      }

      const remaining = deadline - Date.now();

      if (includeTrackedIntegrationWork) {
        // SDK integrations register work independently of the generic wrapper.
        // A tool can start such work and return before its nested SDK call does,
        // so the root run must drain both registries before closing its Writer.
        if (!(await drainInstrumentationOperations(active, remaining))) {
          return false;
        }
      }

      if (active.pending.size === 0) {
        return true;
      }
    }
  }

  private async createRunDirectory(): Promise<string> {
    await mkdir(this.snapshotDir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const directory = join(this.snapshotDir, `run-${randomUUID()}`);
      try {
        await mkdir(directory);
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
    throw new Error('Could not allocate a unique snapshot directory.');
  }

  private report(diagnostic: InstrumentationDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostic callbacks cannot alter the wrapped business call.
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'unknown error';
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJsonObject(value: JsonValue): JsonObject {
  return isJsonObject(value) ? value : { args: [value] };
}

export function instrument<
  TModel extends ModelDefinition<AsyncFunction>,
  TTools extends ToolDefinitions,
>(options: InstrumentOptions<TModel, TTools>): InstrumentedAgent<TModel, TTools> {
  return new Agent(options);
}
