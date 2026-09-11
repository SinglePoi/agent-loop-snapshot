import type {
  ArtifactReference,
  ErrorInfo,
  EventEnvelope,
  EventId,
  JsonObject,
  JsonValue,
  RuntimeDescriptor,
  SideEffectLevel,
  SnapshotManifest,
} from '@agent-loop-snapshot/schema';
import { Recorder, reconstructState, type RunHandle } from '@agent-loop-snapshot/recorder';
import { ArtifactReadError, type TraceSnapshot } from '@agent-loop-snapshot/trace';

import { ReplayAdapterRegistry, type ReplayOutcome } from './adapters.js';
import {
  RecorderReplayPolicyAuditSink,
  ReplayPolicyEngine,
  type ReplayPolicyOptions,
  createReplayPolicyAction,
} from './policy.js';
import { createRecordedReplayAdapterSet } from './recorded.js';
import { assessTraceExecution } from './execution-gate.js';

type MockReplayCallKind = 'model' | 'tool';

export interface MockReplayModelCall {
  readonly kind: 'model';
  readonly model: string;
  readonly correlationKey: string;
  readonly attempt: number;
  readonly input: JsonValue | ArtifactReference;
}

export interface MockReplayToolCall {
  readonly kind: 'tool';
  readonly tool: string;
  readonly correlationKey: string;
  readonly attempt: number;
  readonly arguments: JsonObject | ArtifactReference;
}

export type MockReplayCall = MockReplayModelCall | MockReplayToolCall;

type SourceReplayCall = MockReplayCall & {
  readonly sourceEventId: EventId;
};

export type MockReplayDiagnosticCode =
  | 'SOURCE_TRACE_INVALID'
  | 'SOURCE_TRACE_OBSERVATION_ONLY'
  | 'SOURCE_ARTIFACT_INVALID'
  | 'SOURCE_STATE_UNAVAILABLE'
  | 'RECORDED_ADAPTER_INVALID'
  | 'INVALID_SOURCE_CALL'
  | 'CALL_COUNT_MISMATCH'
  | 'CALL_KIND_MISMATCH'
  | 'CALL_TARGET_MISMATCH'
  | 'CALL_CORRELATION_KEY_MISMATCH'
  | 'CALL_ATTEMPT_MISMATCH'
  | 'CALL_INPUT_MISMATCH'
  | 'MISSING_SOURCE_REQUEST'
  | 'SOURCE_RESPONSE_MISMATCH'
  | 'MISSING_REPLAY_ADAPTER'
  | 'POLICY_BLOCKED'
  | 'RECORDED_OUTCOME_MISMATCH'
  | 'FINAL_STATE_MISMATCH';

export interface MockReplayDiagnostic {
  readonly severity: 'error';
  readonly code: MockReplayDiagnosticCode;
  readonly message: string;
  readonly callIndex?: number;
  readonly sourceEventId?: EventId;
}

export interface MockReplayOptions {
  /** An explicit replay plan. Omit to execute the source snapshot's call plan. */
  readonly calls?: readonly MockReplayCall[];
}

export interface MockReplayRunnerOptions {
  readonly source: TraceSnapshot;
  readonly recorder: Recorder;
  /** Policy rules are applied to every recorded adapter call and always audited. */
  readonly policy?: Omit<ReplayPolicyOptions, 'auditSink'>;
  readonly runtime?: RuntimeDescriptor;
}

export interface MockReplayResult {
  readonly run: RunHandle;
  readonly manifest: SnapshotManifest;
  readonly diagnostics: readonly MockReplayDiagnostic[];
  readonly sourceRunId?: string;
  readonly finalState?: JsonObject;
  readonly finalStateHash?: string;
}

const defaultRuntime: RuntimeDescriptor = {
  name: 'mock-replay',
  version: '0.1.0',
  adapter: '@agent-loop-snapshot/replay',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    typeof value.digest === 'string' &&
    typeof value.media_type === 'string' &&
    typeof value.byte_length === 'number'
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

async function resolveSourceArtifact(
  source: TraceSnapshot,
  reference: ArtifactReference,
): Promise<JsonValue> {
  const value = JSON.parse(
    new TextDecoder().decode(await source.readArtifact(reference.digest)),
  ) as unknown;
  if (!isJsonValue(value)) {
    throw new Error(`Artifact "${reference.digest}" does not contain a JSON value.`);
  }
  return value;
}

/**
 * A replay snapshot must remain independently readable. State artifacts are
 * therefore materialized into the replay event rather than copied by digest.
 */
async function materializeStatePayload(
  source: TraceSnapshot,
  payload: unknown,
): Promise<JsonObject | undefined> {
  const value = isArtifactReference(payload)
    ? await resolveSourceArtifact(source, payload)
    : payload;
  return isJsonObject(value) ? value : undefined;
}

function isReplayValue(value: unknown): value is JsonValue | ArtifactReference {
  return isArtifactReference(value) || isJsonValue(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

function sideEffectFor(event: EventEnvelope<string, unknown>): SideEffectLevel {
  return event.security.side_effect;
}

function sourceCallFromEvent(
  event: EventEnvelope<string, unknown>,
  attempt: number,
): SourceReplayCall | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }
  const correlationKey = event.payload.correlation_key;
  if (typeof correlationKey !== 'string') {
    return undefined;
  }
  if (event.type === 'model.requested') {
    if (typeof event.payload.model !== 'string' || !isReplayValue(event.payload.input)) {
      return undefined;
    }
    return {
      kind: 'model',
      model: event.payload.model,
      correlationKey,
      attempt,
      input: event.payload.input,
      sourceEventId: event.event_id,
    };
  }
  if (event.type === 'tool.requested') {
    if (
      typeof event.payload.tool !== 'string' ||
      (!isArtifactReference(event.payload.arguments) && !isJsonObject(event.payload.arguments))
    ) {
      return undefined;
    }
    return {
      kind: 'tool',
      tool: event.payload.tool,
      correlationKey,
      attempt,
      arguments: event.payload.arguments,
      sourceEventId: event.event_id,
    };
  }
  return undefined;
}

function sourceCalls(events: readonly EventEnvelope<string, unknown>[]): {
  calls: readonly SourceReplayCall[];
  diagnostics: readonly MockReplayDiagnostic[];
} {
  const calls: SourceReplayCall[] = [];
  const diagnostics: MockReplayDiagnostic[] = [];
  const attempts = new Map<string, number>();

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== 'model.requested' && event.type !== 'tool.requested') {
      continue;
    }
    if (!isRecord(event.payload) || typeof event.payload.correlation_key !== 'string') {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_SOURCE_CALL',
        message: 'A source call does not contain a string correlation key.',
        sourceEventId: event.event_id,
      });
      continue;
    }
    const kind: MockReplayCallKind = event.type === 'model.requested' ? 'model' : 'tool';
    const key = `${kind}\u0000${event.payload.correlation_key}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const call = sourceCallFromEvent(event, attempt);
    if (call === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_SOURCE_CALL',
        message: 'A source call payload is not replayable.',
        sourceEventId: event.event_id,
      });
      continue;
    }
    calls.push(call);
  }
  return { calls, diagnostics };
}

function callTarget(call: MockReplayCall): string {
  return call.kind === 'model' ? call.model : call.tool;
}

function callValue(call: MockReplayCall): JsonValue | ArtifactReference {
  return call.kind === 'model' ? call.input : call.arguments;
}

function toPublicCall(call: SourceReplayCall): MockReplayCall {
  if (call.kind === 'model') {
    return {
      kind: call.kind,
      model: call.model,
      correlationKey: call.correlationKey,
      attempt: call.attempt,
      input: call.input,
    };
  }
  return {
    kind: call.kind,
    tool: call.tool,
    correlationKey: call.correlationKey,
    attempt: call.attempt,
    arguments: call.arguments,
  };
}

function compareCallPlans(
  expected: readonly SourceReplayCall[],
  actual: readonly MockReplayCall[],
): MockReplayDiagnostic[] {
  const diagnostics: MockReplayDiagnostic[] = [];
  if (expected.length !== actual.length) {
    diagnostics.push({
      severity: 'error',
      code: 'CALL_COUNT_MISMATCH',
      message: `Source has ${String(expected.length)} replayable calls but the replay plan has ${String(actual.length)}.`,
    });
  }
  const count = Math.min(expected.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    const sourceCall = expected[index]!;
    const actualCall = actual[index]!;
    if (sourceCall.kind !== actualCall.kind) {
      diagnostics.push({
        severity: 'error',
        code: 'CALL_KIND_MISMATCH',
        message: `Replay call ${String(index)} has kind "${actualCall.kind}", expected "${sourceCall.kind}".`,
        callIndex: index,
        sourceEventId: sourceCall.sourceEventId,
      });
      continue;
    }
    if (callTarget(sourceCall) !== callTarget(actualCall)) {
      diagnostics.push({
        severity: 'error',
        code: 'CALL_TARGET_MISMATCH',
        message: `Replay call ${String(index)} targets "${callTarget(actualCall)}", expected "${callTarget(sourceCall)}".`,
        callIndex: index,
        sourceEventId: sourceCall.sourceEventId,
      });
    }
    if (sourceCall.correlationKey !== actualCall.correlationKey) {
      diagnostics.push({
        severity: 'error',
        code: 'CALL_CORRELATION_KEY_MISMATCH',
        message: `Replay call ${String(index)} does not use the source correlation key.`,
        callIndex: index,
        sourceEventId: sourceCall.sourceEventId,
      });
    }
    if (sourceCall.attempt !== actualCall.attempt) {
      diagnostics.push({
        severity: 'error',
        code: 'CALL_ATTEMPT_MISMATCH',
        message: `Replay call ${String(index)} uses attempt ${String(actualCall.attempt)}, expected ${String(sourceCall.attempt)}.`,
        callIndex: index,
        sourceEventId: sourceCall.sourceEventId,
      });
    }
    if (canonicalJson(callValue(sourceCall)) !== canonicalJson(callValue(actualCall))) {
      diagnostics.push({
        severity: 'error',
        code: 'CALL_INPUT_MISMATCH',
        message: `Replay call ${String(index)} has different input or arguments from the source call.`,
        callIndex: index,
        sourceEventId: sourceCall.sourceEventId,
      });
    }
  }
  return diagnostics;
}

function sourceRunId(source: TraceSnapshot): string | undefined {
  return source.manifest?.run_id ?? source.events.at(0)?.run_id;
}

function policyBlockedError(): ErrorInfo {
  return {
    code: 'REPLAY_POLICY_BLOCKED',
    message: 'The replay policy did not allow this recorded adapter call.',
    retryable: false,
    kind: 'policy',
  };
}

function replayBlockedError(diagnostics: readonly MockReplayDiagnostic[]): ErrorInfo {
  return {
    code: 'MOCK_REPLAY_BLOCKED',
    message: `Mock replay stopped with ${String(diagnostics.length)} diagnostic(s).`,
    retryable: false,
    kind: 'validation',
    details: { diagnostic_count: diagnostics.length },
  };
}

function sourceResponseKind(event: EventEnvelope<string, unknown>): MockReplayCallKind | undefined {
  if (event.type === 'model.completed' || event.type === 'model.failed') {
    return 'model';
  }
  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    return 'tool';
  }
  return undefined;
}

function expectedResponseStatus(
  event: EventEnvelope<string, unknown>,
): ReplayOutcome<never>['status'] {
  return event.type.endsWith('.completed') ? 'completed' : 'failed';
}

/**
 * Replays a validated snapshot against recorded-result adapters only. The
 * runner never resolves a live adapter, and every recorded lookup is guarded
 * by the Policy Engine before it is called.
 */
export class MockReplayRunner {
  private readonly source: TraceSnapshot;
  private readonly recorder: Recorder;
  private readonly policyOptions: Omit<ReplayPolicyOptions, 'auditSink'>;
  private readonly runtime: RuntimeDescriptor;

  constructor(options: MockReplayRunnerOptions) {
    this.source = options.source;
    this.recorder = options.recorder;
    this.policyOptions = options.policy ?? {};
    this.runtime = options.runtime ?? defaultRuntime;
  }

  async run(options: MockReplayOptions = {}): Promise<MockReplayResult> {
    const sourceId = sourceRunId(this.source);
    const run = await this.recorder.startRun({
      runtime: this.runtime,
      input: { mode: 'mock', ...(sourceId === undefined ? {} : { source_run_id: sourceId }) },
      actor: 'replay.runner',
    });
    const diagnostics: MockReplayDiagnostic[] = [];
    const callPlan = sourceCalls(this.source.events);
    diagnostics.push(...callPlan.diagnostics);
    if (!this.source.valid) {
      diagnostics.push({
        severity: 'error',
        code: 'SOURCE_TRACE_INVALID',
        message: 'Mock replay requires a valid source TraceSnapshot.',
      });
    }
    const eligibility = assessTraceExecution(this.source);
    if (eligibility.eligibility === 'observation_only') {
      diagnostics.push({
        severity: 'error',
        code: 'SOURCE_TRACE_OBSERVATION_ONLY',
        message: `Mock replay is blocked: ${eligibility.reason}`,
      });
    }

    if (diagnostics.length > 0) {
      return this.fail(run, diagnostics, sourceId);
    }

    const recorded = createRecordedReplayAdapterSet(this.source);
    if (recorded.diagnostics.length > 0) {
      diagnostics.push(
        ...recorded.diagnostics.map((diagnostic) => ({
          severity: 'error' as const,
          code: 'RECORDED_ADAPTER_INVALID' as const,
          message: diagnostic.message,
        })),
      );
    }
    const plannedCalls = options.calls ?? callPlan.calls.map(toPublicCall);
    diagnostics.push(...compareCallPlans(callPlan.calls, plannedCalls));
    if (diagnostics.length > 0) {
      return this.fail(run, diagnostics, sourceId);
    }

    const registry = new ReplayAdapterRegistry({ recorded: recorded.adapters });
    const policyContexts = new Map<string, ReturnType<RunHandle['context']>>();
    const policy = new ReplayPolicyEngine({
      ...this.policyOptions,
      auditSink: new RecorderReplayPolicyAuditSink(this.recorder, run, {
        context: (decision) =>
          policyContexts.get(decision.action.id) ?? run.context(undefined, 'replay.policy'),
      }),
    });
    const callsBySourceEvent = new Map(callPlan.calls.map((call) => [call.sourceEventId, call]));
    const replayRequests = new Map<EventId, EventId>();

    for (const sourceEvent of [...this.source.events].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (sourceEvent.type === 'state.changed') {
        let payload: JsonObject | undefined;
        try {
          payload = await materializeStatePayload(this.source, sourceEvent.payload);
        } catch (error) {
          diagnostics.push({
            severity: 'error',
            code: 'SOURCE_ARTIFACT_INVALID',
            message:
              error instanceof ArtifactReadError
                ? error.message
                : error instanceof Error
                  ? `Mock replay could not materialize a source state artifact: ${error.message}`
                  : 'Mock replay could not materialize a source state artifact.',
            sourceEventId: sourceEvent.event_id,
          });
          break;
        }
        if (payload === undefined) {
          diagnostics.push({
            severity: 'error',
            code: 'SOURCE_RESPONSE_MISMATCH',
            message: 'Mock replay could not materialize a source state change as a JSON object.',
            sourceEventId: sourceEvent.event_id,
          });
          break;
        }
        await this.recorder.appendEvent(run.context(undefined, 'replay.runner'), {
          type: 'state.changed',
          payload,
          actor: 'replay.runner',
          security: sourceEvent.security,
        });
        continue;
      }

      const requestedCall = callsBySourceEvent.get(sourceEvent.event_id);
      if (requestedCall !== undefined) {
        const replayRequest = await this.appendRequested(run, requestedCall, sourceEvent.security);
        replayRequests.set(sourceEvent.event_id, replayRequest.event_id);
        continue;
      }

      const responseKind = sourceResponseKind(sourceEvent);
      if (responseKind === undefined) {
        continue;
      }
      const sourceRequestId = sourceEvent.parent_ids.find((parentId) =>
        callsBySourceEvent.has(parentId),
      );
      const sourceCall =
        sourceRequestId === undefined ? undefined : callsBySourceEvent.get(sourceRequestId);
      const replayRequestId =
        sourceRequestId === undefined ? undefined : replayRequests.get(sourceRequestId);
      if (sourceCall === undefined || replayRequestId === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'MISSING_SOURCE_REQUEST',
          message: 'A source response does not reference a replayable source request.',
          sourceEventId: sourceEvent.event_id,
        });
        break;
      }
      if (sourceCall.kind !== responseKind) {
        diagnostics.push({
          severity: 'error',
          code: 'SOURCE_RESPONSE_MISMATCH',
          message: 'A source response type does not match its request type.',
          sourceEventId: sourceEvent.event_id,
        });
        break;
      }

      const outcome = await this.executeRecordedCall(
        run,
        registry,
        policy,
        policyContexts,
        sourceCall,
        replayRequestId,
        sideEffectFor(sourceEvent),
        diagnostics,
      );
      if (outcome === undefined) {
        break;
      }
      if (outcome.status !== expectedResponseStatus(sourceEvent)) {
        diagnostics.push({
          severity: 'error',
          code: 'RECORDED_OUTCOME_MISMATCH',
          message: 'The recorded adapter outcome does not match the source response status.',
          sourceEventId: sourceEvent.event_id,
        });
        break;
      }
    }

    if (diagnostics.length > 0) {
      return this.fail(run, diagnostics, sourceId);
    }

    let sourceState;
    try {
      sourceState = await reconstructState(this.source.events, {
        checkpoints: this.source.checkpoints,
        resolveArtifact: (reference) => resolveSourceArtifact(this.source, reference),
      });
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'SOURCE_ARTIFACT_INVALID',
        message:
          error instanceof ArtifactReadError
            ? error.message
            : error instanceof Error
              ? `Mock replay could not reconstruct source state: ${error.message}`
              : 'Mock replay could not reconstruct source state.',
      });
      return this.fail(run, diagnostics, sourceId);
    }
    const unavailableCheckpoint = sourceState.diagnostics.find(
      (diagnostic) => diagnostic.code === 'CHECKPOINT_STATE_UNAVAILABLE',
    );
    if (unavailableCheckpoint !== undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'SOURCE_STATE_UNAVAILABLE',
        message: unavailableCheckpoint.message,
      });
      return this.fail(run, diagnostics, sourceId);
    }
    const replayState = await reconstructState(this.recorder.getEvents(run));
    if (sourceState.stateHash !== replayState.stateHash) {
      diagnostics.push({
        severity: 'error',
        code: 'FINAL_STATE_MISMATCH',
        message: 'Mock replay did not reconstruct the source final state hash.',
      });
      return this.fail(run, diagnostics, sourceId);
    }

    await this.recorder.checkpoint(run, {
      state: replayState.state,
      stateHash: replayState.stateHash,
      actor: 'replay.runner',
    });
    await this.recorder.completeRun(
      run,
      {
        final_state_hash: replayState.stateHash,
        output: {
          mode: 'mock',
          ...(sourceId === undefined ? {} : { source_run_id: sourceId }),
        },
      },
      {
        context: run.context(undefined, 'replay.runner'),
        actor: 'replay.runner',
      },
    );
    return {
      run,
      manifest: this.recorder.getManifest(run),
      diagnostics,
      ...(sourceId === undefined ? {} : { sourceRunId: sourceId }),
      finalState: replayState.state,
      finalStateHash: replayState.stateHash,
    };
  }

  private async appendRequested(
    run: RunHandle,
    call: SourceReplayCall,
    security: EventEnvelope<string, unknown>['security'],
  ): Promise<EventEnvelope<string, unknown>> {
    if (call.kind === 'model') {
      return this.recorder.appendEvent(run.context(undefined, 'replay.runner'), {
        type: 'model.requested',
        payload: {
          correlation_key: call.correlationKey,
          model: call.model,
          input: call.input,
        },
        actor: 'replay.runner',
        security,
      });
    }
    return this.recorder.appendEvent(run.context(undefined, 'replay.runner'), {
      type: 'tool.requested',
      payload: {
        correlation_key: call.correlationKey,
        tool: call.tool,
        arguments: call.arguments,
      },
      actor: 'replay.runner',
      security,
    });
  }

  private async executeRecordedCall(
    run: RunHandle,
    registry: ReplayAdapterRegistry,
    policy: ReplayPolicyEngine,
    policyContexts: Map<string, ReturnType<RunHandle['context']>>,
    call: SourceReplayCall,
    replayRequestId: EventId,
    sourceSideEffect: SideEffectLevel,
    diagnostics: MockReplayDiagnostic[],
  ): Promise<ReplayOutcome<JsonValue | ArtifactReference> | undefined> {
    const resolution =
      call.kind === 'model'
        ? registry.resolveModel('recorded')
        : registry.resolveTool('recorded', call.tool);
    if (resolution.adapter === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_REPLAY_ADAPTER',
        message: resolution.diagnostics.map((diagnostic) => diagnostic.message).join(' '),
        sourceEventId: call.sourceEventId,
      });
      return undefined;
    }

    const action = createReplayPolicyAction({
      mode: 'recorded',
      adapterKind: call.kind,
      target: callTarget(call),
      // A recorded adapter is read-only; keep source level out of the decision.
      sideEffect: resolution.adapter.descriptor.sideEffect,
      correlationKey: call.correlationKey,
      attempt: call.attempt,
    });
    policyContexts.set(action.id, run.context([replayRequestId], 'replay.policy'));
    const execution = await policy.execute(action, () =>
      call.kind === 'model'
        ? (resolution.adapter as import('./adapters.js').ReplayModelAdapter).complete({
            correlationKey: call.correlationKey,
            attempt: call.attempt,
            model: call.model,
            input: call.input,
          })
        : (resolution.adapter as import('./adapters.js').ReplayToolAdapter).call({
            correlationKey: call.correlationKey,
            attempt: call.attempt,
            tool: call.tool,
            arguments: call.arguments,
          }),
    );
    policyContexts.delete(action.id);
    const outcome =
      execution.executed && execution.value !== undefined
        ? execution.value
        : { status: 'failed' as const, error: policyBlockedError() };
    if (!execution.executed) {
      diagnostics.push({
        severity: 'error',
        code: 'POLICY_BLOCKED',
        message: execution.decision.reason,
        sourceEventId: call.sourceEventId,
      });
    }

    if (outcome.status === 'completed') {
      await this.recorder.appendEvent(run.context([replayRequestId], 'replay.runner'), {
        type: call.kind === 'model' ? 'model.completed' : 'tool.completed',
        payload: {
          correlation_key: call.correlationKey,
          output: outcome.output,
        },
        actor: 'replay.runner',
        security: { side_effect: sourceSideEffect, redactions: [] },
      });
    } else {
      await this.recorder.appendEvent(run.context([replayRequestId], 'replay.runner'), {
        type: call.kind === 'model' ? 'model.failed' : 'tool.failed',
        payload: {
          correlation_key: call.correlationKey,
          error: outcome.error,
          attempt: call.attempt,
        },
        actor: 'replay.runner',
        security: { side_effect: sourceSideEffect, redactions: [] },
      });
    }
    return outcome;
  }

  private async fail(
    run: RunHandle,
    diagnostics: readonly MockReplayDiagnostic[],
    sourceId: string | undefined,
  ): Promise<MockReplayResult> {
    await this.recorder.failRun(run, replayBlockedError(diagnostics), {
      context: run.context(undefined, 'replay.runner'),
      actor: 'replay.runner',
    });
    return {
      run,
      manifest: this.recorder.getManifest(run),
      diagnostics,
      ...(sourceId === undefined ? {} : { sourceRunId: sourceId }),
    };
  }
}
