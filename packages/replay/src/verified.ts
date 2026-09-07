import type {
  ArtifactReference,
  Checkpoint,
  ErrorInfo,
  EventEnvelope,
  EventId,
  JsonObject,
  JsonValue,
  RuntimeDescriptor,
  SnapshotManifest,
} from '@agent-loop-snapshot/schema';
import {
  Recorder,
  hashState,
  reconstructState,
  type RunHandle,
} from '@agent-loop-snapshot/recorder';
import type { TraceSnapshot } from '@agent-loop-snapshot/trace';

import {
  ReplayAdapterRegistry,
  type ReplayModelAdapter,
  type ReplayOutcome,
  type ReplayToolAdapter,
} from './adapters.js';
import {
  RecorderReplayPolicyAuditSink,
  ReplayPolicyEngine,
  type ReplayPolicyApproval,
  type ReplayPolicyOptions,
  createReplayPolicyAction,
} from './policy.js';

type VerifiedCallKind = 'model' | 'tool';

export interface VerifiedReplayModelCall {
  readonly kind: 'model';
  readonly sourceEventId: EventId;
  readonly sourceSequence: number;
  readonly model: string;
  readonly correlationKey: string;
  readonly attempt: number;
  readonly input: JsonValue | ArtifactReference;
  readonly security: EventEnvelope<string, unknown>['security'];
}

export interface VerifiedReplayToolCall {
  readonly kind: 'tool';
  readonly sourceEventId: EventId;
  readonly sourceSequence: number;
  readonly tool: string;
  readonly correlationKey: string;
  readonly attempt: number;
  readonly arguments: JsonObject | ArtifactReference;
  readonly security: EventEnvelope<string, unknown>['security'];
}

export type VerifiedReplayCall = VerifiedReplayModelCall | VerifiedReplayToolCall;

interface ExpectedResponse {
  readonly sourceEventId: EventId;
  readonly sourceSequence: number;
  readonly outcome: ReplayOutcome<JsonValue | ArtifactReference>;
}

export type VerificationRule =
  | { readonly kind: 'ignore'; readonly path: string }
  | { readonly kind: 'text'; readonly path: string; readonly normalizeWhitespace?: boolean }
  | { readonly kind: 'file_hash'; readonly path: string };

export interface VerifiedReplayAssertion {
  readonly name: string;
  verify(context: {
    readonly call: VerifiedReplayCall;
    readonly expected: ReplayOutcome<JsonValue | ArtifactReference>;
    readonly actual: ReplayOutcome<JsonValue | ArtifactReference>;
  }):
    | boolean
    | { readonly passed: boolean; readonly message?: string }
    | Promise<
        | boolean
        | {
            readonly passed: boolean;
            readonly message?: string;
          }
      >;
}

export type VerifiedReplayDifferenceKind =
  'status' | 'type' | 'value' | 'text' | 'file_hash' | 'assertion';

export interface VerifiedReplayDifference {
  readonly kind: VerifiedReplayDifferenceKind;
  readonly path: string;
  readonly message: string;
  readonly call?: VerifiedReplayCall;
  readonly assertion?: string;
}

export type VerifiedReplayDiagnosticCode =
  | 'SOURCE_TRACE_INVALID'
  | 'INVALID_SOURCE_CALL'
  | 'INVALID_SOURCE_RESPONSE'
  | 'MISSING_SOURCE_RESPONSE'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_INVALID'
  | 'CHECKPOINT_CUTS_ACTIVE_CALL'
  | 'MISSING_LIVE_ADAPTER'
  | 'POLICY_BLOCKED'
  | 'STATE_EVENT_UNSUPPORTED';

export interface VerifiedReplayDiagnostic {
  readonly severity: 'error';
  readonly code: VerifiedReplayDiagnosticCode;
  readonly message: string;
  readonly sourceEventId?: EventId;
}

export interface ReplayResumePoint {
  readonly sourceSequence: number;
  readonly state: JsonObject;
  readonly stateHash: string;
  readonly checkpoint?: Checkpoint;
}

export interface VerifiedReplayRunOptions {
  /** Omit to start from the source Run's beginning; otherwise select this exact checkpoint. */
  readonly checkpointId?: string;
  readonly rules?: readonly VerificationRule[];
  readonly assertions?: readonly VerifiedReplayAssertion[];
  /** Fresh approvals for current live actions. Source authorization is never consulted. */
  readonly approvals?: readonly ReplayPolicyApproval[];
}

export interface VerifiedReplayRunnerOptions {
  readonly source: TraceSnapshot;
  readonly recorder: Recorder;
  readonly adapters: ReplayAdapterRegistry;
  readonly policy?: Omit<ReplayPolicyOptions, 'auditSink'>;
  readonly runtime?: RuntimeDescriptor;
}

export interface VerifiedReplayResult {
  readonly run: RunHandle;
  readonly manifest: SnapshotManifest;
  readonly diagnostics: readonly VerifiedReplayDiagnostic[];
  readonly differences: readonly VerifiedReplayDifference[];
  readonly resumePoint: ReplayResumePoint;
  readonly sourceRunId?: string;
  /** State copied from the recorded control-flow baseline, not live adapter output. */
  readonly recordedState?: JsonObject;
  readonly recordedStateHash?: string;
}

const defaultRuntime: RuntimeDescriptor = {
  name: 'verified-replay',
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

/** Materialize source state so the new replay snapshot has no dangling digest. */
async function materializeStatePayload(
  source: TraceSnapshot,
  payload: unknown,
): Promise<JsonObject | undefined> {
  const value = isArtifactReference(payload)
    ? await resolveSourceArtifact(source, payload)
    : payload;
  return isJsonObject(value) ? value : undefined;
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  );
}

function isReplayValue(value: unknown): value is JsonValue | ArtifactReference {
  return isArtifactReference(value) || isJsonValue(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceRunId(source: TraceSnapshot): string | undefined {
  return source.manifest?.run_id ?? source.events.at(0)?.run_id;
}

function responseFromEvent(
  event: EventEnvelope<string, unknown>,
): ReplayOutcome<JsonValue | ArtifactReference> | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }
  if (event.type === 'model.completed' || event.type === 'tool.completed') {
    return isReplayValue(event.payload.output)
      ? { status: 'completed', output: event.payload.output }
      : undefined;
  }
  if (event.type === 'model.failed' || event.type === 'tool.failed') {
    const error = event.payload.error;
    if (!isErrorInfo(error)) {
      return undefined;
    }
    return { status: 'failed', error };
  }
  return undefined;
}

function callsAndResponses(source: TraceSnapshot): {
  calls: readonly VerifiedReplayCall[];
  responses: ReadonlyMap<EventId, ExpectedResponse>;
  diagnostics: readonly VerifiedReplayDiagnostic[];
} {
  const calls: VerifiedReplayCall[] = [];
  const callsByEventId = new Map<EventId, VerifiedReplayCall>();
  const responses = new Map<EventId, ExpectedResponse>();
  const diagnostics: VerifiedReplayDiagnostic[] = [];
  const attempts = new Map<string, number>();

  for (const event of [...source.events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === 'model.requested' || event.type === 'tool.requested') {
      if (!isRecord(event.payload) || typeof event.payload.correlation_key !== 'string') {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_SOURCE_CALL',
          message: 'A source call does not contain a string correlation key.',
          sourceEventId: event.event_id,
        });
        continue;
      }
      const kind: VerifiedCallKind = event.type === 'model.requested' ? 'model' : 'tool';
      const attemptKey = `${kind}\u0000${event.payload.correlation_key}`;
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);
      let call: VerifiedReplayCall | undefined;
      if (
        kind === 'model' &&
        typeof event.payload.model === 'string' &&
        isReplayValue(event.payload.input)
      ) {
        call = {
          kind,
          sourceEventId: event.event_id,
          sourceSequence: event.sequence,
          model: event.payload.model,
          correlationKey: event.payload.correlation_key,
          attempt,
          input: event.payload.input,
          security: event.security,
        };
      }
      if (
        kind === 'tool' &&
        typeof event.payload.tool === 'string' &&
        (isArtifactReference(event.payload.arguments) || isJsonObject(event.payload.arguments))
      ) {
        call = {
          kind,
          sourceEventId: event.event_id,
          sourceSequence: event.sequence,
          tool: event.payload.tool,
          correlationKey: event.payload.correlation_key,
          attempt,
          arguments: event.payload.arguments,
          security: event.security,
        };
      }
      if (call === undefined) {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_SOURCE_CALL',
          message: 'A source call payload is not supported by verified replay.',
          sourceEventId: event.event_id,
        });
        continue;
      }
      calls.push(call);
      callsByEventId.set(event.event_id, call);
      continue;
    }

    if (
      event.type !== 'model.completed' &&
      event.type !== 'model.failed' &&
      event.type !== 'tool.completed' &&
      event.type !== 'tool.failed'
    ) {
      continue;
    }
    const sourceRequestId = event.parent_ids.find((parentId) => callsByEventId.has(parentId));
    const call = sourceRequestId === undefined ? undefined : callsByEventId.get(sourceRequestId);
    const outcome = responseFromEvent(event);
    const responseCorrelationKey = isRecord(event.payload)
      ? event.payload.correlation_key
      : undefined;
    if (
      call === undefined ||
      outcome === undefined ||
      typeof responseCorrelationKey !== 'string' ||
      responseCorrelationKey !== call.correlationKey
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_SOURCE_RESPONSE',
        message: 'A source response is missing its request or has an invalid payload.',
        sourceEventId: event.event_id,
      });
      continue;
    }
    if (
      (call.kind === 'model' && !event.type.startsWith('model.')) ||
      (call.kind === 'tool' && !event.type.startsWith('tool.'))
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_SOURCE_RESPONSE',
        message: 'A source response type does not match its source request.',
        sourceEventId: event.event_id,
      });
      continue;
    }
    responses.set(call.sourceEventId, {
      sourceEventId: event.event_id,
      sourceSequence: event.sequence,
      outcome,
    });
  }

  for (const call of calls) {
    if (!responses.has(call.sourceEventId)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_SOURCE_RESPONSE',
        message: 'A source call has no terminal response event.',
        sourceEventId: call.sourceEventId,
      });
    }
  }
  return { calls, responses, diagnostics };
}

function pointerTokens(path: string): readonly string[] {
  if (path === '') {
    return [];
  }
  return path
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function matchesPath(rulePath: string, path: string): boolean {
  const ruleTokens = pointerTokens(rulePath);
  const pathTokens = pointerTokens(path);
  return (
    ruleTokens.length === pathTokens.length &&
    ruleTokens.every((token, index) => token === '*' || token === pathTokens[index])
  );
}

function escapedPath(path: string, key: string): string {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function ruleAt(
  rules: readonly VerificationRule[],
  path: string,
  kind: VerificationRule['kind'],
): VerificationRule | undefined {
  return rules.find((rule) => rule.kind === kind && matchesPath(rule.path, path));
}

function addDifference(
  differences: VerifiedReplayDifference[],
  kind: VerifiedReplayDifferenceKind,
  path: string,
  message: string,
): void {
  differences.push({ kind, path, message });
}

/** Declaratively compares JSON-compatible outputs. `*` matches one JSON Pointer segment. */
export function compareVerifiedReplayValues(
  expected: unknown,
  actual: unknown,
  rules: readonly VerificationRule[] = [],
): readonly VerifiedReplayDifference[] {
  const differences: VerifiedReplayDifference[] = [];
  const compare = (expectedValue: unknown, actualValue: unknown, path: string): void => {
    if (ruleAt(rules, path, 'ignore') !== undefined) {
      return;
    }
    const textRule = ruleAt(rules, path, 'text');
    const hashRule = ruleAt(rules, path, 'file_hash');
    if (
      textRule?.kind === 'text' &&
      typeof expectedValue === 'string' &&
      typeof actualValue === 'string'
    ) {
      const normalizedExpected = textRule.normalizeWhitespace
        ? expectedValue.trim().replaceAll(/\s+/gu, ' ')
        : expectedValue;
      const normalizedActual = textRule.normalizeWhitespace
        ? actualValue.trim().replaceAll(/\s+/gu, ' ')
        : actualValue;
      if (normalizedExpected !== normalizedActual) {
        addDifference(
          differences,
          'text',
          path,
          'Text output differs after configured normalization.',
        );
      }
      return;
    }
    if (hashRule !== undefined) {
      if (
        typeof expectedValue !== 'string' ||
        typeof actualValue !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(expectedValue) ||
        !/^[a-f0-9]{64}$/u.test(actualValue) ||
        expectedValue !== actualValue
      ) {
        addDifference(differences, 'file_hash', path, 'Declared file hash differs.');
      }
      return;
    }
    if (expectedValue === null || actualValue === null) {
      if (expectedValue !== actualValue) {
        addDifference(differences, 'value', path, 'One value is null and the other is not.');
      }
      return;
    }
    if (Array.isArray(expectedValue) || Array.isArray(actualValue)) {
      if (!Array.isArray(expectedValue) || !Array.isArray(actualValue)) {
        addDifference(differences, 'type', path, 'Output value types differ.');
        return;
      }
      if (expectedValue.length !== actualValue.length) {
        addDifference(differences, 'value', path, 'Output array lengths differ.');
      }
      const length = Math.min(expectedValue.length, actualValue.length);
      for (let index = 0; index < length; index += 1) {
        compare(expectedValue[index], actualValue[index], `${path}/${String(index)}`);
      }
      return;
    }
    if (isRecord(expectedValue) || isRecord(actualValue)) {
      if (!isRecord(expectedValue) || !isRecord(actualValue)) {
        addDifference(differences, 'type', path, 'Output value types differ.');
        return;
      }
      const keys = new Set([...Object.keys(expectedValue), ...Object.keys(actualValue)]);
      for (const key of [...keys].sort()) {
        if (!(key in expectedValue) || !(key in actualValue)) {
          addDifference(differences, 'value', escapedPath(path, key), 'Output object keys differ.');
          continue;
        }
        compare(expectedValue[key], actualValue[key], escapedPath(path, key));
      }
      return;
    }
    if (typeof expectedValue !== typeof actualValue) {
      addDifference(differences, 'type', path, 'Output value types differ.');
      return;
    }
    if (expectedValue !== actualValue) {
      addDifference(differences, 'value', path, 'Output values differ.');
    }
  };
  compare(expected, actual, '');
  return differences;
}

function errorFromThrownAdapter(error: unknown): ErrorInfo {
  return {
    code: 'LIVE_ADAPTER_THROWN',
    message:
      error instanceof Error ? error.message : 'A live replay adapter threw an unknown error.',
    retryable: false,
    kind: 'runtime',
  };
}

function blockedError(): ErrorInfo {
  return {
    code: 'REPLAY_POLICY_BLOCKED',
    message: 'The replay policy did not allow this live adapter call.',
    retryable: false,
    kind: 'policy',
  };
}

function failureForDiagnostics(diagnostics: readonly VerifiedReplayDiagnostic[]): ErrorInfo {
  return {
    code: 'VERIFIED_REPLAY_BLOCKED',
    message: `Verified replay stopped with ${String(diagnostics.length)} diagnostic(s).`,
    retryable: false,
    kind: 'validation',
    details: { diagnostic_count: diagnostics.length },
  };
}

async function checkpointState(source: TraceSnapshot, checkpoint: Checkpoint): Promise<JsonObject> {
  if (isJsonObject(checkpoint.state)) {
    return cloneJson(checkpoint.state);
  }
  const bytes = await source.readArtifact(checkpoint.state.digest);
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!isJsonObject(value)) {
    throw new Error(`Checkpoint "${checkpoint.checkpoint_id}" does not resolve to a JSON object.`);
  }
  return value;
}

/** Selects and validates a source checkpoint without inheriting any source authorization. */
export async function selectReplayResumePoint(
  source: TraceSnapshot,
  checkpointId?: string,
): Promise<ReplayResumePoint> {
  if (checkpointId === undefined) {
    return { sourceSequence: 0, state: {}, stateHash: hashState({}) };
  }
  const checkpoint = source.checkpoints.find(
    (candidate) => candidate.checkpoint_id === checkpointId,
  );
  if (checkpoint === undefined) {
    throw new Error(`Replay checkpoint "${checkpointId}" was not found in the source snapshot.`);
  }
  const event = source.events.find((candidate) => candidate.sequence === checkpoint.sequence);
  if (event?.event_id !== checkpoint.last_event_id) {
    throw new Error(`Replay checkpoint "${checkpointId}" does not match its source event.`);
  }
  const state = await checkpointState(source, checkpoint);
  const stateHash = hashState(state);
  if (stateHash !== checkpoint.state_hash) {
    throw new Error(`Replay checkpoint "${checkpointId}" has an invalid state hash.`);
  }
  return { sourceSequence: checkpoint.sequence, state, stateHash, checkpoint };
}

/**
 * Re-executes the recorded call schedule with currently configured live
 * adapters. It mirrors recorded state transitions solely as a control-flow
 * baseline; live adapter output is judged through structured differences.
 */
export class VerifiedReplayRunner {
  private readonly source: TraceSnapshot;
  private readonly recorder: Recorder;
  private readonly adapters: ReplayAdapterRegistry;
  private readonly policyOptions: Omit<ReplayPolicyOptions, 'auditSink'>;
  private readonly runtime: RuntimeDescriptor;

  constructor(options: VerifiedReplayRunnerOptions) {
    this.source = options.source;
    this.recorder = options.recorder;
    this.adapters = options.adapters;
    this.policyOptions = options.policy ?? {};
    this.runtime = options.runtime ?? defaultRuntime;
  }

  async run(options: VerifiedReplayRunOptions = {}): Promise<VerifiedReplayResult> {
    const sourceId = sourceRunId(this.source);
    let resumePoint: ReplayResumePoint;
    try {
      resumePoint = await selectReplayResumePoint(this.source, options.checkpointId);
    } catch (error) {
      const run = await this.recorder.startRun({
        runtime: this.runtime,
        input: { mode: 'verified', ...(sourceId === undefined ? {} : { source_run_id: sourceId }) },
        actor: 'replay.runner',
      });
      const diagnostics: VerifiedReplayDiagnostic[] = [
        {
          severity: 'error',
          code: options.checkpointId === undefined ? 'CHECKPOINT_INVALID' : 'CHECKPOINT_NOT_FOUND',
          message: error instanceof Error ? error.message : 'Could not select a replay checkpoint.',
        },
      ];
      return this.fail(
        run,
        diagnostics,
        [],
        { sourceSequence: 0, state: {}, stateHash: hashState({}) },
        sourceId,
      );
    }

    const run = await this.recorder.startRun({
      runtime: this.runtime,
      input: {
        mode: 'verified',
        ...(sourceId === undefined ? {} : { source_run_id: sourceId }),
        ...(resumePoint.checkpoint === undefined
          ? {}
          : { source_checkpoint_id: resumePoint.checkpoint.checkpoint_id }),
      },
      actor: 'replay.runner',
    });
    const diagnostics: VerifiedReplayDiagnostic[] = [];
    const differences: VerifiedReplayDifference[] = [];
    if (!this.source.valid) {
      diagnostics.push({
        severity: 'error',
        code: 'SOURCE_TRACE_INVALID',
        message: 'Verified replay requires a valid source TraceSnapshot.',
      });
    }
    const sourceSchedule = callsAndResponses(this.source);
    diagnostics.push(...sourceSchedule.diagnostics);
    if (diagnostics.length > 0) {
      return this.fail(run, diagnostics, differences, resumePoint, sourceId);
    }

    if (resumePoint.checkpoint !== undefined) {
      await this.recorder.checkpoint(run, {
        state: resumePoint.state,
        stateHash: resumePoint.stateHash,
        actor: 'replay.runner',
      });
    }

    const contexts = new Map<string, ReturnType<RunHandle['context']>>();
    const policy = new ReplayPolicyEngine({
      ...this.policyOptions,
      auditSink: new RecorderReplayPolicyAuditSink(this.recorder, run, {
        context: (decision) =>
          contexts.get(decision.action.id) ?? run.context(undefined, 'replay.policy'),
      }),
    });
    const callsByEventId = new Map(sourceSchedule.calls.map((call) => [call.sourceEventId, call]));
    const replayRequests = new Map<EventId, EventId>();

    for (const sourceEvent of [...this.source.events].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (sourceEvent.sequence <= resumePoint.sourceSequence) {
        continue;
      }
      if (sourceEvent.type === 'state.changed') {
        const payload = await materializeStatePayload(this.source, sourceEvent.payload);
        if (payload === undefined) {
          diagnostics.push({
            severity: 'error',
            code: 'STATE_EVENT_UNSUPPORTED',
            message: 'Verified replay could not materialize a source state event as a JSON object.',
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
      const call = callsByEventId.get(sourceEvent.event_id);
      if (call !== undefined) {
        const request = await this.appendRequest(run, call);
        replayRequests.set(call.sourceEventId, request.event_id);
        continue;
      }
      if (
        sourceEvent.type !== 'model.completed' &&
        sourceEvent.type !== 'model.failed' &&
        sourceEvent.type !== 'tool.completed' &&
        sourceEvent.type !== 'tool.failed'
      ) {
        continue;
      }
      const sourceRequestId = sourceEvent.parent_ids.find((parentId) =>
        callsByEventId.has(parentId),
      );
      const expectedCall =
        sourceRequestId === undefined ? undefined : callsByEventId.get(sourceRequestId);
      const replayRequestId =
        sourceRequestId === undefined ? undefined : replayRequests.get(sourceRequestId);
      const expectedResponse =
        sourceRequestId === undefined ? undefined : sourceSchedule.responses.get(sourceRequestId);
      if (
        expectedCall === undefined ||
        replayRequestId === undefined ||
        expectedResponse === undefined
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'CHECKPOINT_CUTS_ACTIVE_CALL',
          message: 'The selected checkpoint leaves a source response without a replay request.',
          sourceEventId: sourceEvent.event_id,
        });
        break;
      }
      const actual = await this.invokeLive(
        run,
        policy,
        contexts,
        expectedCall,
        replayRequestId,
        options.approvals ?? [],
        diagnostics,
      );
      if (actual === undefined) {
        break;
      }
      await this.appendResponse(run, expectedCall, replayRequestId, actual);
      await this.compareOutcomes(
        expectedCall,
        expectedResponse.outcome,
        actual,
        options,
        differences,
      );
    }

    if (diagnostics.length > 0) {
      return this.fail(run, diagnostics, differences, resumePoint, sourceId);
    }
    const state = await reconstructState(this.recorder.getEvents(run), {
      checkpoints: this.recorder.getCheckpoints(run),
    });
    await this.recorder.completeRun(
      run,
      {
        final_state_hash: state.stateHash,
        output: {
          mode: 'verified',
          difference_count: differences.length,
          ...(sourceId === undefined ? {} : { source_run_id: sourceId }),
        },
      },
      { context: run.context(undefined, 'replay.runner'), actor: 'replay.runner' },
    );
    return {
      run,
      manifest: this.recorder.getManifest(run),
      diagnostics,
      differences,
      resumePoint,
      ...(sourceId === undefined ? {} : { sourceRunId: sourceId }),
      recordedState: state.state,
      recordedStateHash: state.stateHash,
    };
  }

  private async appendRequest(
    run: RunHandle,
    call: VerifiedReplayCall,
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
        security: call.security,
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
      security: call.security,
    });
  }

  private async invokeLive(
    run: RunHandle,
    policy: ReplayPolicyEngine,
    contexts: Map<string, ReturnType<RunHandle['context']>>,
    call: VerifiedReplayCall,
    replayRequestId: EventId,
    approvals: readonly ReplayPolicyApproval[],
    diagnostics: VerifiedReplayDiagnostic[],
  ): Promise<ReplayOutcome<JsonValue | ArtifactReference> | undefined> {
    const resolution =
      call.kind === 'model'
        ? this.adapters.resolveModel('live')
        : this.adapters.resolveTool('live', call.tool);
    if (resolution.adapter === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_LIVE_ADAPTER',
        message: resolution.diagnostics.map((diagnostic) => diagnostic.message).join(' '),
        sourceEventId: call.sourceEventId,
      });
      return undefined;
    }
    const action = createReplayPolicyAction({
      mode: 'live',
      adapterKind: call.kind,
      target: call.kind === 'model' ? call.model : call.tool,
      sideEffect: resolution.adapter.descriptor.sideEffect,
      correlationKey: call.correlationKey,
      attempt: call.attempt,
    });
    contexts.set(action.id, run.context([replayRequestId], 'replay.policy'));
    const approval = approvals.find((candidate) => candidate.actionId === action.id);
    const policyOptions = approval === undefined ? {} : { approval };
    let execution;
    try {
      execution = await policy.execute(
        action,
        async () => {
          try {
            return call.kind === 'model'
              ? await (resolution.adapter as ReplayModelAdapter).complete({
                  correlationKey: call.correlationKey,
                  attempt: call.attempt,
                  model: call.model,
                  input: call.input,
                })
              : await (resolution.adapter as ReplayToolAdapter).call({
                  correlationKey: call.correlationKey,
                  attempt: call.attempt,
                  tool: call.tool,
                  arguments: call.arguments,
                });
          } catch (error) {
            return { status: 'failed' as const, error: errorFromThrownAdapter(error) };
          }
        },
        policyOptions,
      );
    } finally {
      contexts.delete(action.id);
    }
    if (!execution.executed || execution.value === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'POLICY_BLOCKED',
        message: execution.decision.reason,
        sourceEventId: call.sourceEventId,
      });
      return { status: 'failed', error: blockedError() };
    }
    return execution.value;
  }

  private async appendResponse(
    run: RunHandle,
    call: VerifiedReplayCall,
    replayRequestId: EventId,
    outcome: ReplayOutcome<JsonValue | ArtifactReference>,
  ): Promise<void> {
    if (outcome.status === 'completed') {
      await this.recorder.appendEvent(run.context([replayRequestId], 'replay.runner'), {
        type: call.kind === 'model' ? 'model.completed' : 'tool.completed',
        payload: { correlation_key: call.correlationKey, output: outcome.output },
        actor: 'replay.runner',
        security: call.security,
      });
      return;
    }
    await this.recorder.appendEvent(run.context([replayRequestId], 'replay.runner'), {
      type: call.kind === 'model' ? 'model.failed' : 'tool.failed',
      payload: {
        correlation_key: call.correlationKey,
        error: outcome.error,
        attempt: call.attempt,
      },
      actor: 'replay.runner',
      security: call.security,
    });
  }

  private async compareOutcomes(
    call: VerifiedReplayCall,
    expected: ReplayOutcome<JsonValue | ArtifactReference>,
    actual: ReplayOutcome<JsonValue | ArtifactReference>,
    options: VerifiedReplayRunOptions,
    differences: VerifiedReplayDifference[],
  ): Promise<void> {
    if (expected.status !== actual.status) {
      differences.push({
        kind: 'status',
        path: '',
        message: 'Live adapter outcome status differs from the recorded result.',
        call,
      });
      return;
    }
    const values =
      expected.status === 'completed' && actual.status === 'completed'
        ? compareVerifiedReplayValues(expected.output, actual.output, options.rules)
        : expected.status === 'failed' && actual.status === 'failed'
          ? compareVerifiedReplayValues(expected.error, actual.error, options.rules)
          : [];
    differences.push(...values.map((difference) => ({ ...difference, call })));
    for (const assertion of options.assertions ?? []) {
      try {
        const result = await assertion.verify({ call, expected, actual });
        const passed = typeof result === 'boolean' ? result : result.passed;
        if (!passed) {
          differences.push({
            kind: 'assertion',
            path: '',
            assertion: assertion.name,
            call,
            message:
              typeof result === 'boolean'
                ? `Assertion "${assertion.name}" failed.`
                : (result.message ?? `Assertion "${assertion.name}" failed.`),
          });
        }
      } catch (error) {
        differences.push({
          kind: 'assertion',
          path: '',
          assertion: assertion.name,
          call,
          message: error instanceof Error ? error.message : `Assertion "${assertion.name}" threw.`,
        });
      }
    }
  }

  private async fail(
    run: RunHandle,
    diagnostics: readonly VerifiedReplayDiagnostic[],
    differences: readonly VerifiedReplayDifference[],
    resumePoint: ReplayResumePoint,
    sourceId: string | undefined,
  ): Promise<VerifiedReplayResult> {
    await this.recorder.failRun(run, failureForDiagnostics(diagnostics), {
      context: run.context(undefined, 'replay.runner'),
      actor: 'replay.runner',
    });
    return {
      run,
      manifest: this.recorder.getManifest(run),
      diagnostics,
      differences,
      resumePoint,
      ...(sourceId === undefined ? {} : { sourceRunId: sourceId }),
    };
  }
}
