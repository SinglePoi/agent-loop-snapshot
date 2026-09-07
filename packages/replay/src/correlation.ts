export type ReplayCorrelationKind = 'model' | 'tool';

export interface ReplayCorrelationIdentity {
  readonly kind: ReplayCorrelationKind;
  readonly target: string;
  /**
   * A zero-based logical call position. Retries use the same position and
   * increment `attempt` on the invocation instead.
   */
  readonly ordinal: number;
}

export class ReplayCorrelationError extends Error {
  constructor(
    readonly code: 'INVALID_CORRELATION_TARGET' | 'INVALID_CORRELATION_ORDINAL',
    message: string,
  ) {
    super(message);
    this.name = 'ReplayCorrelationError';
  }
}

/**
 * Creates a deterministic, framework-neutral key for one logical model or
 * tool call. Callers must choose an ordinal from stable workflow structure,
 * rather than from wall-clock timing or a random UUID.
 */
export function createReplayCorrelationKey(identity: ReplayCorrelationIdentity): string {
  if (identity.target.trim() === '') {
    throw new ReplayCorrelationError(
      'INVALID_CORRELATION_TARGET',
      'A replay correlation target must not be empty.',
    );
  }
  if (!Number.isSafeInteger(identity.ordinal) || identity.ordinal < 0) {
    throw new ReplayCorrelationError(
      'INVALID_CORRELATION_ORDINAL',
      'A replay correlation ordinal must be a non-negative safe integer.',
    );
  }

  return `replay/v1/${identity.kind}/${encodeURIComponent(identity.target)}/${String(identity.ordinal)}`;
}
