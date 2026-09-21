import type {
  ExportDeliveryReport,
  OtelExportConfig,
  OtlpExportTraceServiceRequest,
  OtlpHttpClient,
  OtlpHttpRuntime,
  OtlpHttpSendOptions,
} from './index.js';
import { createOtelExportConfigFingerprint } from './delivery-identity.js';

const defaultTimeoutMs = 10_000;
const defaultRetryMaxAttempts = 3;
const defaultRetryBudgetMs = 30_000;
const maxResponseBytes = 4 * 1024 * 1024;
const maxTimerMs = 2_147_483_647;
const maxRetryAttempts = 100;

interface ResolvedTarget {
  readonly endpoint: URL;
  readonly headers: Headers;
}

interface PartialSuccess {
  readonly rejectedSpans: number;
  readonly hasWarning: boolean;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum = maxTimerMs,
): number | undefined {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved >= 1 && resolved <= maximum
    ? resolved
    : undefined;
}

function isLocalHttpHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function partialSuccess(value: unknown): PartialSuccess | undefined | 'invalid' {
  if (!isRecord(value)) return 'invalid';
  const hasCamelCase = Object.hasOwn(value, 'partialSuccess');
  const hasSnakeCase = Object.hasOwn(value, 'partial_success');
  if (!hasCamelCase && !hasSnakeCase) return undefined;
  const partial = value.partialSuccess ?? value.partial_success;
  if (!isRecord(partial)) return 'invalid';
  const rejected = partial.rejectedSpans ?? partial.rejected_spans ?? 0;
  const rejectedSpans = nonNegativeInteger(rejected);
  if (rejectedSpans === undefined) return 'invalid';
  const warning = partial.errorMessage ?? partial.error_message;
  if (warning !== undefined && typeof warning !== 'string') return 'invalid';
  return { rejectedSpans, hasWarning: typeof warning === 'string' && warning.length > 0 };
}

function retryAfterMs(value: string | null, now: () => number): number | undefined {
  if (value === null) return undefined;
  if (/^[0-9]+(?:\.[0-9]+)?$/u.test(value.trim())) {
    const milliseconds = Number(value) * 1000;
    return Number.isFinite(milliseconds) && milliseconds >= 0
      ? Math.min(maxTimerMs, Math.ceil(milliseconds))
      : undefined;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  const milliseconds = Math.max(0, date - now());
  return Number.isFinite(milliseconds) ? Math.min(maxTimerMs, Math.ceil(milliseconds)) : undefined;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('Export was cancelled.'));
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error('Export was cancelled.'));
      },
      { once: true },
    );
  });
}

async function responseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Response exceeded the OTLP response size limit.');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxResponseBytes) {
        await reader.cancel();
        throw new Error('Response exceeded the OTLP response size limit.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function parseSuccessResponse(text: string): PartialSuccess | undefined | 'invalid' {
  if (text.trim() === '') return undefined;
  try {
    return partialSuccess(JSON.parse(text) as unknown);
  } catch {
    return 'invalid';
  }
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function report(
  state: ExportDeliveryReport['state'],
  targetAlias: string,
  spanCount: number,
  attempts: number,
  options: {
    readonly accepted?: number;
    readonly rejected?: number;
    readonly retryAfterMs?: number;
    readonly attempted?: boolean;
    readonly reliableState?: ExportDeliveryReport['reliableState'];
    readonly message?: string;
  } = {},
): ExportDeliveryReport {
  return {
    state,
    targetAlias,
    ...(options.reliableState === undefined ? {} : { reliableState: options.reliableState }),
    attempted: options.attempted ?? attempts > 0,
    acceptedSpanCount: options.accepted ?? 0,
    rejectedSpanCount: options.rejected ?? (state === 'rejected' ? spanCount : 0),
    attempts,
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.message === undefined ? {} : { message: options.message }),
  };
}

/**
 * Creates the bounded OTLP/HTTP JSON sender used by later queue and SDK work.
 * It only sends the supplied payload; it never records, maps, or retries an
 * agent/model/tool call.
 */
export function createOtlpHttpClient(
  config: OtelExportConfig,
  runtime: OtlpHttpRuntime = {},
): OtlpHttpClient {
  const fetcher = runtime.fetch ?? globalThis.fetch;
  const environment = runtime.environment ?? process.env;
  const wallNow = runtime.now ?? Date.now;
  const monotonicNow = runtime.monotonicNow ?? (() => performance.now());
  const random = runtime.random ?? Math.random;
  const sleep = runtime.sleep ?? defaultSleep;
  const timeoutMs = positiveInteger(config.timeoutMs, defaultTimeoutMs);
  const maxAttempts = positiveInteger(
    config.retryMaxAttempts,
    defaultRetryMaxAttempts,
    maxRetryAttempts,
  );
  const retryBudgetMs = positiveInteger(config.retryBudgetMs, defaultRetryBudgetMs);

  const resolveTarget = (): ResolvedTarget | undefined => {
    const endpointValue = config.endpoint ?? environment[config.endpointEnv ?? ''];
    if (typeof endpointValue !== 'string' || endpointValue.length === 0) return undefined;
    let endpoint: URL;
    try {
      endpoint = new URL(endpointValue);
    } catch {
      return undefined;
    }
    if (
      endpoint.username !== '' ||
      endpoint.password !== '' ||
      (endpoint.protocol !== 'https:' &&
        !(endpoint.protocol === 'http:' && isLocalHttpHost(endpoint.hostname)))
    ) {
      return undefined;
    }
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'agent-loop-snapshot-otel-export/1.0',
    });
    for (const [header, variable] of Object.entries(config.headersEnv ?? {})) {
      if (typeof variable !== 'string') return undefined;
      const value = environment[variable];
      if (typeof value !== 'string' || value.length === 0 || /[\r\n]/u.test(value))
        return undefined;
      try {
        headers.set(header, value);
      } catch {
        return undefined;
      }
    }
    return { endpoint, headers };
  };

  return {
    async send(
      request: OtlpExportTraceServiceRequest,
      spanCount: number,
      options: OtlpHttpSendOptions = {},
    ): Promise<ExportDeliveryReport> {
      if (timeoutMs === undefined || maxAttempts === undefined || retryBudgetMs === undefined) {
        return report('not_queued', config.targetAlias, spanCount, 0, {
          attempted: false,
          reliableState: 'configuration_blocked',
          message: 'OTLP timeout and retry settings must be finite positive integers within range.',
        });
      }
      if (isAborted(options.signal)) {
        return report('not_queued', config.targetAlias, spanCount, 0, {
          attempted: false,
          reliableState: 'not_sent',
          message: 'Export was cancelled before the request started.',
        });
      }
      let body: string;
      try {
        body = JSON.stringify(request);
      } catch {
        return report('rejected', config.targetAlias, spanCount, 0, {
          attempted: false,
          reliableState: 'permanently_rejected',
          message: 'The OTLP request could not be encoded safely.',
        });
      }
      const startedAt = monotonicNow();
      let attempts = 0;
      let lastRetryAfterMs: number | undefined;
      let lastFailureWasUnknown = false;

      while (attempts < maxAttempts) {
        if (isAborted(options.signal)) {
          return report(
            attempts === 0 ? 'not_queued' : 'unknown_delivery',
            config.targetAlias,
            spanCount,
            attempts,
            {
              attempted: attempts > 0,
              reliableState: attempts === 0 ? 'not_sent' : 'unknown_delivery',
              message:
                attempts === 0
                  ? 'Export was cancelled before the request started.'
                  : 'Export was cancelled before a response could be confirmed.',
            },
          );
        }
        const target = resolveTarget();
        if (target === undefined) {
          return report('not_queued', config.targetAlias, spanCount, attempts, {
            attempted: attempts > 0,
            reliableState: 'configuration_blocked',
            message: 'Export target configuration could not be resolved safely.',
          });
        }
        if (
          options.expectedTargetFingerprint !== undefined &&
          createOtelExportConfigFingerprint(config, environment) !==
            options.expectedTargetFingerprint
        ) {
          return report('not_queued', config.targetAlias, spanCount, attempts, {
            attempted: attempts > 0,
            reliableState: 'configuration_blocked',
            message: 'The resolved OTLP destination no longer matches the queued batch.',
          });
        }
        const remainingBudgetMs = retryBudgetMs - (monotonicNow() - startedAt);
        if (remainingBudgetMs <= 0) break;
        attempts += 1;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(
          () => {
            timedOut = true;
            controller.abort(new Error('OTLP export timed out.'));
          },
          Math.max(1, Math.min(timeoutMs, Math.floor(remainingBudgetMs))),
        );
        const abort = () =>
          controller.abort(options.signal?.reason ?? new Error('Export was cancelled.'));
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await fetcher(target.endpoint, {
            method: 'POST',
            headers: target.headers,
            body,
            redirect: 'manual',
            signal: controller.signal,
          });
          if (response.status === 200) {
            let parsed: PartialSuccess | undefined | 'invalid';
            try {
              parsed = parseSuccessResponse(await responseText(response));
            } catch {
              return report('rejected', config.targetAlias, spanCount, attempts, {
                reliableState: 'permanently_rejected',
                message: 'Collector returned an unreadable OTLP response.',
              });
            }
            if (parsed === 'invalid') {
              return report('rejected', config.targetAlias, spanCount, attempts, {
                reliableState: 'permanently_rejected',
                message: 'Collector returned an invalid OTLP JSON response.',
              });
            }
            if (parsed !== undefined) {
              if (parsed.rejectedSpans > spanCount) {
                return report('rejected', config.targetAlias, spanCount, attempts, {
                  reliableState: 'permanently_rejected',
                  message: 'Collector reported an invalid rejected-span count.',
                });
              }
              if (parsed.rejectedSpans === 0) {
                return report('accepted', config.targetAlias, spanCount, attempts, {
                  accepted: spanCount,
                  rejected: 0,
                  reliableState: parsed.hasWarning ? 'accepted_with_warnings' : 'accepted',
                  ...(parsed.hasWarning
                    ? { message: 'Collector accepted the batch with a sanitized warning.' }
                    : {}),
                });
              }
              return report('rejected', config.targetAlias, spanCount, attempts, {
                accepted: Math.max(0, spanCount - parsed.rejectedSpans),
                rejected: parsed.rejectedSpans,
                reliableState: 'partially_rejected',
                message: 'Collector reported OTLP partial success; the batch was not retried.',
              });
            }
            return report('accepted', config.targetAlias, spanCount, attempts, {
              accepted: spanCount,
              rejected: 0,
              reliableState: 'accepted',
            });
          }
          if (!retryableStatus(response.status)) {
            await discardResponse(response);
            return report('rejected', config.targetAlias, spanCount, attempts, {
              reliableState: 'permanently_rejected',
              message: 'Collector rejected the OTLP request without a retryable status.',
            });
          }
          lastFailureWasUnknown = false;
          lastRetryAfterMs = retryAfterMs(response.headers.get('retry-after'), wallNow);
          await discardResponse(response);
        } catch {
          if (isAborted(options.signal)) {
            return report('unknown_delivery', config.targetAlias, spanCount, attempts, {
              reliableState: 'unknown_delivery',
              message: 'Export was cancelled before a response could be confirmed.',
            });
          }
          if (!timedOut) {
            // OTLP permits retrying a disconnected request. Its final outcome is
            // still unknown if the retry budget is exhausted.
            lastRetryAfterMs = undefined;
          }
          lastFailureWasUnknown = true;
        } finally {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', abort);
        }

        if (attempts >= maxAttempts) break;
        const exponential = Math.min(10_000, 100 * 2 ** (attempts - 1));
        const randomValue = random();
        const jitter = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
        const delay = lastRetryAfterMs ?? Math.floor(exponential * (0.5 + jitter));
        if (monotonicNow() - startedAt + delay >= retryBudgetMs) break;
        try {
          await sleep(delay, options.signal);
        } catch {
          return report('unknown_delivery', config.targetAlias, spanCount, attempts, {
            ...(lastRetryAfterMs === undefined ? {} : { retryAfterMs: lastRetryAfterMs }),
            reliableState: 'unknown_delivery',
            message: 'Export was cancelled before a response could be confirmed.',
          });
        }
      }

      return report(
        lastFailureWasUnknown ? 'unknown_delivery' : 'exhausted',
        config.targetAlias,
        spanCount,
        attempts,
        {
          ...(lastRetryAfterMs === undefined ? {} : { retryAfterMs: lastRetryAfterMs }),
          message: lastFailureWasUnknown
            ? 'No OTLP response confirmed whether the final request was delivered.'
            : 'The OTLP retry budget was exhausted.',
          reliableState: lastFailureWasUnknown ? 'unknown_delivery' : 'retry_exhausted',
        },
      );
    },
  };
}
