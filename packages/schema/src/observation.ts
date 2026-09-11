/**
 * The system that produced a snapshot. This is provenance metadata, not an
 * assertion that the source's payloads are complete or trustworthy.
 */
export type SnapshotSource = 'native' | 'sdk' | 'otel-import';

/**
 * Completeness describes recording evidence, independently from structural
 * schema validity and the source application's business outcome.
 */
export type SnapshotCompleteness = 'unknown' | 'partial' | 'complete';

/**
 * A stable, machine-readable explanation of known recording limits.
 *
 * The persisted representation and its schema are introduced by CAP-02. The
 * names live here first so recorder, importer, viewer, and execution packages
 * share one vocabulary rather than inventing incompatible strings.
 */
export type SnapshotLimitationCode =
  | 'recording_failed'
  | 'drain_timed_out'
  | 'unpaired_call'
  | 'payload_omitted'
  | 'payload_truncated'
  | 'stream_not_consumed'
  | 'stream_ended_early'
  | 'missing_root'
  | 'missing_parent'
  | 'sampled_or_dropped'
  | 'unsupported_semantics'
  | 'invalid_source_data'
  | 'unknown_side_effect'
  | 'final_state_unavailable';

/**
 * A limitation may carry source-specific, already-redacted details. It must
 * never be treated as a replacement for the source event or as an authority
 * grant.
 */
export interface SnapshotLimitation {
  readonly code: SnapshotLimitationCode;
  readonly message: string;
}

/**
 * This is deliberately an eligibility result, not a permission. Callers must
 * still apply schema compatibility, replay validation, adapter checks, and
 * current policy before executing anything.
 */
export type SnapshotExecutionEligibility = 'eligible_for_validation' | 'observation_only';

export interface SnapshotExecutionAssessment {
  readonly eligibility: SnapshotExecutionEligibility;
  readonly reason: string;
}

export interface SnapshotObservationMetadata {
  readonly source: SnapshotSource;
  readonly completeness: SnapshotCompleteness;
  readonly limitations: readonly SnapshotLimitation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLimitation(value: unknown): value is SnapshotLimitation {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    executionBlockingLimitations.has(value.code as SnapshotLimitationCode) &&
    typeof value.message === 'string'
  );
}

/**
 * Reads persisted observation metadata without granting authority to malformed
 * or future manifests. A pre-observation v0.1.0 snapshot retains the native,
 * complete interpretation it had before CAP-02.
 */
export function readSnapshotObservationMetadata(manifest: unknown): SnapshotObservationMetadata {
  if (!isRecord(manifest)) {
    return {
      source: 'otel-import',
      completeness: 'unknown',
      limitations: [
        { code: 'invalid_source_data', message: 'Snapshot manifest is not an object.' },
      ],
    };
  }
  if (manifest.schema_version === '0.1.0') {
    return { source: 'native', completeness: 'complete', limitations: [] };
  }
  const source = manifest.source;
  const completeness = manifest.completeness;
  const limitations = Array.isArray(manifest.limitations)
    ? manifest.limitations.filter(isLimitation)
    : [];
  if (
    (source !== 'native' && source !== 'sdk' && source !== 'otel-import') ||
    (completeness !== 'unknown' && completeness !== 'partial' && completeness !== 'complete')
  ) {
    return {
      source: 'otel-import',
      completeness: 'unknown',
      limitations: [
        ...limitations,
        { code: 'invalid_source_data', message: 'Snapshot observation metadata is invalid.' },
      ],
    };
  }
  return { source, completeness, limitations };
}

const executionBlockingLimitations = new Set<SnapshotLimitationCode>([
  'recording_failed',
  'drain_timed_out',
  'unpaired_call',
  'payload_omitted',
  'payload_truncated',
  'stream_not_consumed',
  'stream_ended_early',
  'missing_root',
  'missing_parent',
  'sampled_or_dropped',
  'unsupported_semantics',
  'invalid_source_data',
  'unknown_side_effect',
  'final_state_unavailable',
]);

/**
 * Returns the strongest claim the recording evidence can make. In particular,
 * an OTLP import stays observation-only even if an exporter labels it complete.
 */
export function assessSnapshotExecution(
  metadata: SnapshotObservationMetadata,
): SnapshotExecutionAssessment {
  if (metadata.source === 'otel-import') {
    return {
      eligibility: 'observation_only',
      reason: 'OTel-imported snapshots are observation-only.',
    };
  }
  if (metadata.completeness !== 'complete') {
    return {
      eligibility: 'observation_only',
      reason: `Snapshot completeness is ${metadata.completeness}, not complete.`,
    };
  }
  const blocking = metadata.limitations.find((limitation) =>
    executionBlockingLimitations.has(limitation.code),
  );
  if (blocking !== undefined) {
    return {
      eligibility: 'observation_only',
      reason: `Snapshot has execution-blocking limitation: ${blocking.code}.`,
    };
  }
  return {
    eligibility: 'eligible_for_validation',
    reason: 'Snapshot has complete native or SDK recording evidence.',
  };
}
