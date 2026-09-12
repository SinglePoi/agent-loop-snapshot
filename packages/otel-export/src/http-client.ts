import type {
  ExportDeliveryReport,
  OtelExportConfig,
  OtlpExportTraceServiceRequest,
  OtlpHttpClient,
  OtlpHttpRuntime,
  OtlpHttpSendOptions,
} from './index.js';

const defaultTimeoutMs = 10_000;
const defaultRetryMaxAttempts = 3;
const defaultRetryBudgetMs = 30_000;
const maxResponseBytes = 4 * 1024 * 1024;

interface ResolvedTarget {
  readonly endpoint: URL;
  readonly headers: Headers;
}

interface PartialSuccess {
  readonly rejectedSpans: number;
}

function positive(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
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

function nonNegativeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value)) return Number(value);
  return 0;
}

function partialSuccess(value: unknown): PartialSuccess | undefined {
  if (!isRecord(value)) return undefined;
  const partial = value.partialSuccess ?? value.partial_success;
  if (!isRecord(partial)) return undefined;
  return { rejectedSpans: nonNegativeInteger(partial.rejectedSpans ?? partial.rejected_spans) };
}

function retryAfterMs(value: string | null, now: () => number): number | undefined {
  if (value === null) return undefined;
  if (/^[0-9]+(?:\.[0-9]+)?$/u.test(value.trim()))
    return Math.max(0, Math.ceil(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
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
    throw new Error('Response exceeded the OTLP response size limit.');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
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
    readonly message?: string;
  } = {},
): ExportDeliveryReport {
  return {
    state,
    targetAlias,
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
  const now = runtime.now ?? Date.now;
  const random = runtime.random ?? Math.random;
  const sleep = runtime.sleep ?? defaultSleep;
  const timeoutMs = positive(config.timeoutMs, defaultTimeoutMs);
  const maxAttempts = Math.max(1, positive(config.retryMaxAttempts, defaultRetryMaxAttempts));
  const retryBudgetMs = positive(config.retryBudgetMs, defaultRetryBudgetMs);

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
      const startedAt = now();
      const body = JSON.stringify(request);
      let attempts = 0;
      let lastRetryAfterMs: number | undefined;
      let lastFailureWasUnknown = false;

      while (attempts < maxAttempts) {
        if (isAborted(options.signal)) {
          return report('unknown_delivery', config.targetAlias, spanCount, attempts, {
            message: 'Export was cancelled before a response could be confirmed.',
          });
        }
        const target = resolveTarget();
        if (target === undefined) {
          return report('rejected', config.targetAlias, spanCount, attempts, {
            attempted: false,
            message: 'Export target configuration could not be resolved safely.',
          });
        }
        attempts += 1;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('OTLP export timed out.'));
        }, timeoutMs);
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
            const parsed = parseSuccessResponse(await responseText(response));
            if (parsed === 'invalid') {
              return report('rejected', config.targetAlias, spanCount, attempts, {
                message: 'Collector returned an invalid OTLP JSON response.',
              });
            }
            if (parsed !== undefined) {
              if (parsed.rejectedSpans === 0) {
                return report('accepted', config.targetAlias, spanCount, attempts, {
                  accepted: spanCount,
                  rejected: 0,
                });
              }
              return report('rejected', config.targetAlias, spanCount, attempts, {
                accepted: Math.max(0, spanCount - parsed.rejectedSpans),
                rejected: parsed.rejectedSpans,
                message: 'Collector reported OTLP partial success; the batch was not retried.',
              });
            }
            return report('accepted', config.targetAlias, spanCount, attempts, {
              accepted: spanCount,
              rejected: 0,
            });
          }
          if (!retryableStatus(response.status)) {
            return report('rejected', config.targetAlias, spanCount, attempts, {
              message: 'Collector rejected the OTLP request without a retryable status.',
            });
          }
          lastFailureWasUnknown = false;
          lastRetryAfterMs = retryAfterMs(response.headers.get('retry-after'), now);
        } catch {
          if (isAborted(options.signal)) {
            return report('unknown_delivery', config.targetAlias, spanCount, attempts, {
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
        const delay = lastRetryAfterMs ?? Math.floor(exponential * (0.5 + random()));
        if (now() - startedAt + delay > retryBudgetMs) break;
        try {
          await sleep(delay, options.signal);
        } catch {
          return report('unknown_delivery', config.targetAlias, spanCount, attempts, {
            ...(lastRetryAfterMs === undefined ? {} : { retryAfterMs: lastRetryAfterMs }),
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
        },
      );
    },
  };
}
