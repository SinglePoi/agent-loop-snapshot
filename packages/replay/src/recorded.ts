import type {
  ArtifactReference,
  ErrorInfo,
  EventEnvelope,
  JsonValue,
} from '@agent-loop-snapshot/schema';
import type { TraceSnapshot } from '@agent-loop-snapshot/trace';

import type {
  ReplayAdapterDiagnostic,
  ReplayAdapterSet,
  ReplayModelAdapter,
  ReplayModelRequest,
  ReplayOutcome,
  ReplayToolAdapter,
  ReplayToolRequest,
} from './adapters.js';

type RecordedCallKind = 'model' | 'tool';

interface RecordedRequest {
  readonly kind: RecordedCallKind;
  readonly target: string;
  readonly correlationKey: string;
  readonly attempt: number;
  readonly eventId: string;
}

interface RecordedOutcome {
  readonly kind: RecordedCallKind;
  readonly correlationKey: string;
  readonly outcome: ReplayOutcome<JsonValue | ArtifactReference>;
}

export type RecordedReplayDiagnosticCode =
  | 'INVALID_RECORDED_REQUEST'
  | 'INVALID_RECORDED_OUTCOME'
  | 'MISSING_RECORDED_REQUEST'
  | 'CORRELATION_KEY_MISMATCH'
  | 'MISSING_RECORDED_OUTCOME';

export type RecordedReplayDiagnostic = Omit<ReplayAdapterDiagnostic, 'code'> & {
  readonly code: RecordedReplayDiagnosticCode;
  readonly eventId?: string;
};

export interface RecordedReplayAdapterSet {
  readonly adapters: ReplayAdapterSet;
  readonly diagnostics: readonly RecordedReplayDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
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

function diagnostic(
  code: RecordedReplayDiagnosticCode,
  message: string,
  eventId?: string,
  adapterKind: RecordedCallKind = 'tool',
): RecordedReplayDiagnostic {
  return {
    severity: 'error',
    code,
    adapterKind,
    mode: 'recorded',
    ...(eventId === undefined ? {} : { eventId }),
    message,
  };
}

function requestFromEvent(event: EventEnvelope<string, unknown>): RecordedRequest | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }
  if (event.type === 'model.requested') {
    const { correlation_key: correlationKey, model } = event.payload;
    if (typeof correlationKey !== 'string' || typeof model !== 'string') {
      return undefined;
    }
    return { kind: 'model', target: model, correlationKey, attempt: 0, eventId: event.event_id };
  }
  if (event.type === 'tool.requested') {
    const { correlation_key: correlationKey, tool } = event.payload;
    if (typeof correlationKey !== 'string' || typeof tool !== 'string') {
      return undefined;
    }
    return { kind: 'tool', target: tool, correlationKey, attempt: 0, eventId: event.event_id };
  }
  return undefined;
}

function outcomeFromEvent(event: EventEnvelope<string, unknown>): RecordedOutcome | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }
  const correlationKey = event.payload.correlation_key;
  if (typeof correlationKey !== 'string') {
    return undefined;
  }
  if (event.type === 'model.completed' || event.type === 'tool.completed') {
    if (!isJsonValue(event.payload.output)) {
      return undefined;
    }
    return {
      kind: event.type === 'model.completed' ? 'model' : 'tool',
      correlationKey,
      outcome: { status: 'completed', output: event.payload.output },
    };
  }
  if (event.type === 'model.failed' || event.type === 'tool.failed') {
    if (!isErrorInfo(event.payload.error)) {
      return undefined;
    }
    return {
      kind: event.type === 'model.failed' ? 'model' : 'tool',
      correlationKey,
      outcome: { status: 'failed', error: event.payload.error },
    };
  }
  return undefined;
}

function callKey(kind: RecordedCallKind, correlationKey: string, attempt: number): string {
  return `${kind}\u0000${correlationKey}\u0000${String(attempt)}`;
}

function missingRecordedOutcome<T>(
  kind: RecordedCallKind,
  correlationKey: string,
  attempt: number,
): ReplayOutcome<T> {
  return {
    status: 'failed',
    error: {
      code: 'RECORDED_RESULT_NOT_FOUND',
      message: `No recorded ${kind} result exists for correlation key "${correlationKey}" attempt ${String(attempt)}.`,
      retryable: false,
      kind: 'runtime',
    },
  };
}

function descriptor(name: string, capability: 'model.complete' | 'tool.call') {
  return {
    name,
    version: 'snapshot-v0.1',
    capabilities: [capability] as const,
    // Returning an existing result never repeats the historical side effect.
    sideEffect: 'read_only' as const,
  };
}

/**
 * Builds recorded-result adapters from a trace. This layer only looks up
 * recorded outcomes; it deliberately does not create a Replay Trace or invoke
 * a real tool. Those responsibilities begin with the Mock Replay runner.
 */
export function createRecordedReplayAdapterSet(
  trace: Pick<TraceSnapshot, 'events'>,
): RecordedReplayAdapterSet {
  const diagnostics: RecordedReplayDiagnostic[] = [];
  const requestsByEventId = new Map<string, RecordedRequest>();
  const attemptsByLogicalCall = new Map<string, number>();
  const outcomes = new Map<string, ReplayOutcome<JsonValue | ArtifactReference>>();
  const toolNames = new Set<string>();

  const events = [...trace.events].sort((left, right) => left.sequence - right.sequence);
  for (const event of events) {
    if (event.type === 'model.requested' || event.type === 'tool.requested') {
      const request = requestFromEvent(event);
      if (request === undefined) {
        diagnostics.push(
          diagnostic(
            'INVALID_RECORDED_REQUEST',
            'Recorded request payload is invalid.',
            event.event_id,
            event.type === 'model.requested' ? 'model' : 'tool',
          ),
        );
        continue;
      }
      const logicalKey = `${request.kind}\u0000${request.correlationKey}`;
      const attempt = (attemptsByLogicalCall.get(logicalKey) ?? 0) + 1;
      const numberedRequest = { ...request, attempt };
      requestsByEventId.set(event.event_id, numberedRequest);
      attemptsByLogicalCall.set(logicalKey, attempt);
      if (request.kind === 'tool') {
        toolNames.add(request.target);
      }
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

    const outcome = outcomeFromEvent(event);
    if (outcome === undefined) {
      diagnostics.push(
        diagnostic(
          'INVALID_RECORDED_OUTCOME',
          'Recorded result payload is invalid.',
          event.event_id,
          event.type.startsWith('model.') ? 'model' : 'tool',
        ),
      );
      continue;
    }
    const request = event.parent_ids
      .map((parentId) => requestsByEventId.get(parentId))
      .find((candidate) => candidate !== undefined);
    if (request === undefined) {
      diagnostics.push(
        diagnostic(
          'MISSING_RECORDED_REQUEST',
          'Recorded result does not directly reference its request event.',
          event.event_id,
          outcome.kind,
        ),
      );
      continue;
    }
    if (request.kind !== outcome.kind || request.correlationKey !== outcome.correlationKey) {
      diagnostics.push(
        diagnostic(
          'CORRELATION_KEY_MISMATCH',
          'Recorded result kind or correlation key does not match its request event.',
          event.event_id,
          outcome.kind,
        ),
      );
      continue;
    }
    outcomes.set(callKey(request.kind, request.correlationKey, request.attempt), outcome.outcome);
  }

  for (const request of requestsByEventId.values()) {
    if (!outcomes.has(callKey(request.kind, request.correlationKey, request.attempt))) {
      diagnostics.push(
        diagnostic(
          'MISSING_RECORDED_OUTCOME',
          `Recorded ${request.kind} request has no terminal result.`,
          request.eventId,
          request.kind,
        ),
      );
    }
  }

  const lookup = (
    kind: RecordedCallKind,
    correlationKey: string,
    attempt: number,
  ): ReplayOutcome<JsonValue | ArtifactReference> =>
    outcomes.get(callKey(kind, correlationKey, attempt)) ??
    missingRecordedOutcome(kind, correlationKey, attempt);

  const model: ReplayModelAdapter = {
    descriptor: descriptor('recorded-model-results', 'model.complete'),
    async complete(request: ReplayModelRequest) {
      return lookup('model', request.correlationKey, request.attempt);
    },
  };
  const tools: ReplayToolAdapter[] = [...toolNames].sort().map((tool) => ({
    descriptor: descriptor(tool, 'tool.call'),
    async call(request: ReplayToolRequest) {
      return lookup('tool', request.correlationKey, request.attempt);
    },
  }));

  return { adapters: { model, tools }, diagnostics };
}
