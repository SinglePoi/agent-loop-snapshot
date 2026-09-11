import {
  assessSnapshotExecution,
  readSnapshotObservationMetadata,
  type SnapshotExecutionAssessment,
} from '@agent-loop-snapshot/schema';
import type { TraceSnapshot } from '@agent-loop-snapshot/trace';

/**
 * Evidence gate shared by every source-trace execution entry point. It is
 * intentionally separate from adapter and policy authorization.
 */
export function assessTraceExecution(trace: TraceSnapshot): SnapshotExecutionAssessment {
  return assessSnapshotExecution(readSnapshotObservationMetadata(trace.manifest));
}
