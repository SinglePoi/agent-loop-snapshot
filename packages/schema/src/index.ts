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

/** A JSON Schema fragment used to describe a workflow input or output. */
export type JsonSchema = JsonObject | boolean;

export type WorkflowId = `wf_${string}`;
export type WorkflowNodeId = `node_${string}`;
export type WorkflowVerifierId = `verifier_${string}`;

export type WorkflowNodeKind = 'agent_task' | 'tool_call' | 'verification' | 'human_approval';
export type WorkflowDependencyOutcome = 'success' | 'failure' | 'always';
export type WorkflowFailureBehavior = 'stop' | 'continue';
export type WorkflowConditionOperator = 'exists' | 'equals' | 'not_equals' | 'truthy' | 'falsy';

export interface WorkflowValueReference {
  kind: 'input' | 'node_output';
  name: string;
  path?: string;
}

/** A condition gates a node and makes branch selection explicit in the IR. */
export interface WorkflowCondition {
  from: WorkflowValueReference;
  operator: WorkflowConditionOperator;
  value?: JsonValue;
}

export interface WorkflowDependency {
  node_id: WorkflowNodeId;
  on: WorkflowDependencyOutcome;
}

export interface WorkflowRetryPolicy {
  max_attempts: number;
  backoff_ms?: number;
  retry_on?: string[];
}

export interface WorkflowPermissionRequirement {
  side_effect: SideEffectLevel;
  capabilities?: string[];
  targets?: string[];
  requires_approval?: boolean;
}

export type WorkflowSuccessCondition =
  | { kind: 'condition'; condition: WorkflowCondition }
  | { kind: 'output_schema'; schema: JsonSchema }
  | { kind: 'verifier'; verifier_id: WorkflowVerifierId };

export interface WorkflowInputDefinition {
  schema: JsonSchema;
  description?: string;
  required?: boolean;
  default?: JsonValue;
}

export interface WorkflowOutputDefinition {
  from: {
    node_id: WorkflowNodeId;
    path?: string;
  };
  schema: JsonSchema;
  description?: string;
}

export type WorkflowVerifier =
  | { verifier_id: WorkflowVerifierId; kind: 'json_schema'; schema: JsonSchema }
  | { verifier_id: WorkflowVerifierId; kind: 'assertion'; assertion: string }
  | { verifier_id: WorkflowVerifierId; kind: 'human'; prompt: string };

export interface WorkflowNodeBase {
  node_id: WorkflowNodeId;
  kind: WorkflowNodeKind;
  depends_on: WorkflowDependency[];
  condition?: WorkflowCondition;
  retry?: WorkflowRetryPolicy;
  on_failure: WorkflowFailureBehavior;
  permissions: WorkflowPermissionRequirement;
  success_conditions: WorkflowSuccessCondition[];
}

export interface AgentTaskWorkflowNode extends WorkflowNodeBase {
  kind: 'agent_task';
  goal: string;
  instructions?: string;
}

export interface ToolCallWorkflowNode extends WorkflowNodeBase {
  kind: 'tool_call';
  tool: string;
  arguments?: JsonObject;
}

export interface VerificationWorkflowNode extends WorkflowNodeBase {
  kind: 'verification';
  verifier_id: WorkflowVerifierId;
}

export interface HumanApprovalWorkflowNode extends WorkflowNodeBase {
  kind: 'human_approval';
  approval_id: string;
  prompt: string;
}

export type WorkflowNode =
  | AgentTaskWorkflowNode
  | ToolCallWorkflowNode
  | VerificationWorkflowNode
  | HumanApprovalWorkflowNode;

/**
 * A portable, declarative workflow. JSON and YAML representations are parsed
 * into this same document before validation or execution.
 */
export interface WorkflowDocument {
  schema_version: SnapshotSchemaVersion;
  workflow_type: 'agent-workflow';
  workflow_id: WorkflowId;
  name: string;
  inputs: Record<string, WorkflowInputDefinition>;
  nodes: WorkflowNode[];
  outputs: Record<string, WorkflowOutputDefinition>;
  verifiers?: WorkflowVerifier[];
}

export * from './validator.js';
export * from './migration.js';
