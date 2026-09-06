import type { SnapshotSchemaVersion } from './protocol.js';

export * from './protocol.js';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type RunId = `run_${string}`;
export type EventId = `evt_${string}`;
export type CheckpointId = `cp_${string}`;

export type SideEffectLevel = 'read_only' | 'workspace_write' | 'external_write' | 'destructive';

export type EventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'model.requested'
  | 'model.completed'
  | 'model.failed'
  | 'tool.requested'
  | 'tool.completed'
  | 'tool.failed'
  | 'decision.recorded'
  | 'state.changed'
  | 'checkpoint.created'
  | 'verification.completed';

export interface ArtifactReference {
  schema_version: SnapshotSchemaVersion;
  digest: string;
  media_type: string;
  byte_length: number;
  preview?: string;
}

export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  kind?: 'model' | 'tool' | 'validation' | 'policy' | 'runtime' | 'unknown';
  details?: JsonObject | ArtifactReference;
}

export interface RedactionEntry {
  category: string;
  path: string;
  strategy: 'mask' | 'reference' | 'remove' | 'custom';
}

export interface EventSecurity {
  side_effect: SideEffectLevel;
  redactions: RedactionEntry[];
}

export interface EventEnvelope<
  TType extends string = EventType,
  TPayload = JsonObject | ArtifactReference,
> {
  schema_version: SnapshotSchemaVersion;
  run_id: RunId;
  event_id: EventId;
  parent_ids: EventId[];
  sequence: number;
  type: TType;
  timestamp: string;
  monotonic_offset_ms: number;
  actor: string;
  payload: TPayload;
  security: EventSecurity;
}

export interface RuntimeDescriptor {
  name: string;
  version: string;
  adapter?: string;
}

export type RunState = 'running' | 'finished' | 'incomplete';
export type TerminalStatus = 'completed' | 'failed' | 'aborted';

export interface SnapshotManifest {
  schema_version: SnapshotSchemaVersion;
  snapshot_type: 'run-snapshot';
  run_id: RunId;
  created_at: string;
  updated_at: string;
  run_state: RunState;
  terminal_status: TerminalStatus | null;
  runtime: RuntimeDescriptor;
  last_sequence: number;
  event_count: number;
  root_event_id?: EventId;
  completed_at?: string;
}

export interface Checkpoint {
  schema_version: SnapshotSchemaVersion;
  checkpoint_id: CheckpointId;
  run_id: RunId;
  created_at: string;
  last_event_id: EventId;
  sequence: number;
  state_hash: string;
  state: JsonObject | ArtifactReference;
}

export interface RunStartedPayload {
  runtime: RuntimeDescriptor;
  input?: JsonValue | ArtifactReference;
}

export interface RunCompletedPayload {
  final_state_hash: string;
  output?: JsonValue | ArtifactReference;
}

export interface RunFailedPayload {
  error: ErrorInfo;
}

export interface ModelRequestedPayload {
  correlation_key: string;
  model: string;
  input: JsonValue | ArtifactReference;
}

export interface ModelCompletedPayload {
  correlation_key: string;
  output: JsonValue | ArtifactReference;
}

export interface ModelFailedPayload {
  correlation_key: string;
  error: ErrorInfo;
  attempt: number;
}

export interface ToolRequestedPayload {
  correlation_key: string;
  tool: string;
  arguments: JsonObject | ArtifactReference;
}

export interface ToolCompletedPayload {
  correlation_key: string;
  output: JsonValue | ArtifactReference;
}

export interface ToolFailedPayload {
  correlation_key: string;
  error: ErrorInfo;
  attempt: number;
}

export interface DecisionRecordedPayload {
  decision: string;
  basis_summary: string;
  success_conditions: string[];
}

export interface StateChangedPayload {
  path: string;
  operation: 'set' | 'merge' | 'delete' | 'append';
  value?: JsonValue | ArtifactReference;
}

export interface CheckpointCreatedPayload {
  checkpoint_id: CheckpointId;
  last_event_id: EventId;
  sequence: number;
  state_hash: string;
}

export interface VerificationCompletedPayload {
  verifier: string;
  result: 'passed' | 'failed';
  diagnostics?: string[];
}

export * from './validator.js';
