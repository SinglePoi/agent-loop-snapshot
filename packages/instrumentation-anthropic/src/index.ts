import { randomUUID } from 'node:crypto';

import {
  patchMethod,
  safeJsonCopy,
  observeSdkStream,
  type InstrumentationIntegration,
  type InstrumentationIntegrationApi,
  type MethodInvocation,
} from '@agent-loop-snapshot/instrumentation';
import { Messages } from '@anthropic-ai/sdk/resources/messages/messages';

export const anthropicIntegrationName = '@agent-loop-snapshot/instrumentation-anthropic' as const;

export type AnthropicRecordingMode = 'content' | 'metadata-only';

export interface AnthropicIntegrationOptions {
  readonly recording?: AnthropicRecordingMode;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'The Anthropic SDK call failed.';
}

function copy(value: unknown, fallback: Record<string, unknown>): unknown {
  try {
    return safeJsonCopy(value);
  } catch {
    return fallback;
  }
}

function recordAnthropicInvocation(
  api: InstrumentationIntegrationApi,
  recording: AnthropicRecordingMode,
  invocation: MethodInvocation,
): unknown {
  const active = api.currentRun();
  const result = invocation.original.apply(invocation.thisArg, [...invocation.args]);
  if (active === undefined) {
    return result;
  }
  const input = copy(invocation.args[0], { unavailable: true });
  const inputRecord = isRecord(input) ? input : {};
  const model = typeof inputRecord.model === 'string' ? inputRecord.model : 'unknown';
  const correlationKey = `anthropic:messages.create:${randomUUID()}`;
  const stream = inputRecord.stream === true;
  let resolveRequested: ((value: { readonly event_id: string }) => void) | undefined;
  const requestedReady = stream
    ? new Promise<{ readonly event_id: string }>((resolve) => {
        resolveRequested = resolve;
      })
    : undefined;
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
                  endpoint: 'messages.create',
                  stream: true,
                  event_count: eventCount,
                  ...(recording === 'content' ? { final_event: copy(lastEvent, {}) } : {}),
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
                  code: 'ANTHROPIC_STREAM_FAILED',
                  message: message(error),
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
              message: 'The Anthropic stream consumer ended before the stream completed.',
            });
            await active.recorder.appendEvent(active.run.context([requested.event_id as never]), {
              type: 'model.completed',
              payload: {
                correlation_key: correlationKey,
                output: { endpoint: 'messages.create', stream: true, ended_early: true },
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
                ? { endpoint: 'messages.create', request: input }
                : { endpoint: 'messages.create', stream: inputRecord.stream === true },
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
      const outputCopy = copy(output, { received: true });
      const outputRecord = isRecord(outputCopy) ? outputCopy : { received: true };
      await active.recorder.appendEvent(active.run.context([requested.event_id]), {
        type: 'model.completed',
        payload: {
          correlation_key: correlationKey,
          output:
            recording === 'content'
              ? { endpoint: 'messages.create', stream: false, response: outputCopy }
              : {
                  endpoint: 'messages.create',
                  stream: false,
                  response: {
                    id: outputRecord.id,
                    model: outputRecord.model,
                    stop_reason: outputRecord.stop_reason,
                    usage: outputRecord.usage,
                  },
                },
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
                code: 'ANTHROPIC_SDK_CALL_FAILED',
                message: message(error),
                retryable: false,
                kind: 'model',
              },
              attempt: 1,
            },
          });
        } catch (recordingError) {
          api.reportDiagnostic({
            code: 'RECORDING_FINALIZATION_FAILED',
            integration: anthropicIntegrationName,
            message: `Could not record an Anthropic SDK failure: ${message(recordingError)}`,
          });
        }
      } else {
        api.reportDiagnostic({
          code: 'RECORDING_FINALIZATION_FAILED',
          integration: anthropicIntegrationName,
          message: `Could not start recording an Anthropic SDK call: ${message(error)}`,
        });
      }
    }
  })();
  void api.track(observer);
  return result;
}

/** Instruments the 0.125.0 Messages resource prototype. */
export function anthropicIntegration(
  options: AnthropicIntegrationOptions = {},
): InstrumentationIntegration {
  const recording = options.recording ?? 'content';
  return {
    name: anthropicIntegrationName,
    install(api) {
      const restore = patchMethod(Messages.prototype, 'create', (invocation) =>
        recordAnthropicInvocation(api, recording, invocation),
      );
      return () => {
        restore();
      };
    },
  };
}
