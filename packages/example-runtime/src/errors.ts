import type { ErrorInfo } from '@agent-loop-snapshot/schema';

export class RuntimeAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly kind: ErrorInfo['kind'] = 'runtime',
  ) {
    super(message);
    this.name = 'RuntimeAdapterError';
  }
}

export class RuntimeConfigurationError extends RuntimeAdapterError {
  constructor(code: string, message: string) {
    super(code, message, false, 'validation');
    this.name = 'RuntimeConfigurationError';
  }
}

export function errorInfoFrom(
  error: unknown,
  fallbackCode: string,
  kind: ErrorInfo['kind'] = 'runtime',
): ErrorInfo {
  if (error instanceof RuntimeAdapterError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.kind === undefined ? {} : { kind: error.kind }),
    };
  }

  return {
    code: fallbackCode,
    message: `The ${kind ?? 'runtime'} adapter failed.`,
    retryable: false,
    kind,
  };
}
