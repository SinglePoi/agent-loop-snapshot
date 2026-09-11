import { randomUUID } from 'node:crypto';

import {
  patchMethod,
  safeJsonCopy,
  observeSdkStream,
  type InstrumentationIntegration,
  type InstrumentationIntegrationApi,
  type MethodInvocation,
} from '@agent-loop-snapshot/instrumentation';
import { Completions } from 'openai/resources/chat/completions/completions';
import { Responses } from 'openai/resources/responses/responses';

export const openaiIntegrationName = '@agent-loop-snapshot/instrumentation-openai' as const;

export type OpenAIRecordingMode = 'content' | 'metadata-only';

export interface OpenAIIntegrationOptions {
  /** Content is redacted by the recorder before disk persistence. */
  readonly recording?: OpenAIRecordingMode;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'The OpenAI SDK call failed.';
}

function safeCopy(value: unknown, fallback: Record<string, unknown>): unknown {
  try {
    return safeJsonCopy(value);
  } catch {
    return fallback;
  }
}

function requestModel(input: unknown): string {
  const copied = safeCopy(input, {});
  return isRecord(copied) && typeof copied.model === 'string' ? copied.model : 'unknown';
}

function responseMetadata(value: unknown): Record<string, unknown> {
  const copied = safeCopy(value, { received: true });
  if (!isRecord(copied)) {
    return { received: true };
  }
  const selected: Record<string, unknown> = {};
  for (const key of ['id', 'model', 'object', 'status', 'usage', 'finish_reason']) {
    if (key in copied) {
      selected[key] = copied[key];
    }
  }
  return selected;
}

function recordOpenAIInvocation(
  api: InstrumentationIntegrationApi,
  endpoint: string,
  recording: OpenAIRecordingMode,
  invocation: MethodInvocation,
): unknown {
  const active = api.currentRun();
  const result = invocation.original.apply(invocation.thisArg, [...invocation.args]);
  if (active === undefined) {
    return result;
  }

  const input = safeCopy(invocation.args[0], { unavailable: true });
  const model = requestModel(input);
  const correlationKey = `openai:${endpoint}:${randomUUID()}`;
  const stream = isRecord(input) && input.stream === true;
  let resolveRequested: ((value: { readonly event_id: string }) => void) | undefined;
  const requestedReady = stream
    ? new Promise<{ readonly event_id: string }>((resolve) => {
        resolveRequested = resolve;
      })
    : undefined;
  // This subscription is registered before the SDK promise is returned to
  // application code. It therefore patches the delivered stream before an
  // immediately-following `for await` can ask it for an iterator.
  const streamObserver = stream
    ? Promise.resolve(result).then((output) =>
        observeSdkStream(
          output,
          async (eventCount, lastEvent) => {
            const requested = await requestedReady!;
            await active.recorder.appendEvent(active.run.context([requested.event_id as never]), {
              type: 'model.completed',
              payload: {
                correlation_key: correlationKey,
                output: {
                  endpoint,
                  stream: true,
                  event_count: eventCount,
                  ...(recording === 'content' ? { final_event: safeCopy(lastEvent, {}) } : {}),
                },
              },
            });
          },
          async (error) => {
            const requested = await requestedReady!;
            await active.recorder.appendEvent(active.run.context([requested.event_id as never]), {
              type: 'model.failed',
              payload: {
                correlation_key: correlationKey,
                error: {
                  code: 'OPENAI_STREAM_FAILED',
                  message: failureMessage(error),
                  retryable: false,
                  kind: 'model',
                },
                attempt: 1,
              },
            });
          },
          async () => {
            const requested = await requestedReady!;
            active.recorder.markIncomplete(active.run, {
              code: 'stream_ended_early',
              message: 'The OpenAI stream consumer ended before the stream completed.',
            });
            await active.recorder.appendEvent(active.run.context([requested.event_id as never]), {
              type: 'model.completed',
              payload: {
                correlation_key: correlationKey,
                output: { endpoint, stream: true, ended_early: true },
              },
            });
          },
        ),
      )
    : undefined;
  const observer = (async (): Promise<void> => {
    let requestedId: string | undefined;
    try {
      const requested = await active.recorder.appendEvent(
        active.run.context(api.currentParentIds() ?? [active.run.startedEvent.event_id]),
        {
          type: 'model.requested',
          payload: {
            correlation_key: correlationKey,
            model,
            input:
              recording === 'content'
                ? { endpoint, request: input }
                : { endpoint, stream: isRecord(input) && input.stream === true },
          },
        },
      );
      requestedId = requested.event_id;
      resolveRequested?.({ event_id: requested.event_id });
      const output = await Promise.resolve(result);
      if (stream) {
        await streamObserver;
        return;
      }
      await active.recorder.appendEvent(active.run.context([requested.event_id]), {
        type: 'model.completed',
        payload: {
          correlation_key: correlationKey,
          output:
            recording === 'content'
              ? { endpoint, stream, response: safeCopy(output, { unavailable: true }) }
              : { endpoint, stream, response: responseMetadata(output) },
        },
      });
    } catch (error) {
      if (requestedId !== undefined) {
        try {
          await active.recorder.appendEvent(active.run.context([requestedId as never]), {
            type: 'model.failed',
            payload: {
              correlation_key: correlationKey,
              error: {
                code: 'OPENAI_SDK_CALL_FAILED',
                message: failureMessage(error),
                retryable: false,
                kind: 'model',
              },
              attempt: 1,
            },
          });
        } catch (recordingError) {
          api.reportDiagnostic({
            code: 'RECORDING_FINALIZATION_FAILED',
            integration: openaiIntegrationName,
            message: `Could not record an OpenAI SDK failure: ${failureMessage(recordingError)}`,
          });
        }
      } else {
        api.reportDiagnostic({
          code: 'RECORDING_FINALIZATION_FAILED',
          integration: openaiIntegrationName,
          message: `Could not start recording an OpenAI SDK call: ${failureMessage(error)}`,
        });
      }
    }
  })();
  void api.track(observer);
  return result;
}

/**
 * Instruments OpenAI 7.15.0 resource prototypes. Initialize it before loading
 * application modules so all subsequently created OpenAI clients share the
 * narrow create-method wrappers.
 */
export function openAIIntegration(
  options: OpenAIIntegrationOptions = {},
): InstrumentationIntegration {
  const recording = options.recording ?? 'content';
  return {
    name: openaiIntegrationName,
    install(api) {
      const restoreChat = patchMethod(Completions.prototype, 'create', (invocation) =>
        recordOpenAIInvocation(api, 'chat.completions.create', recording, invocation),
      );
      const restoreResponses = patchMethod(Responses.prototype, 'create', (invocation) =>
        recordOpenAIInvocation(api, 'responses.create', recording, invocation),
      );
      return () => {
        restoreResponses();
        restoreChat();
      };
    },
  };
}
