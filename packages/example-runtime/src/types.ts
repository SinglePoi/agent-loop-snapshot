import type {
  ArtifactReference,
  JsonObject,
  JsonValue,
  RuntimeDescriptor,
  SnapshotManifest,
} from '@agent-loop-snapshot/schema';
import type { Recorder, RecorderRunStatus, RunHandle } from '@agent-loop-snapshot/recorder';

export interface ModelRequest {
  correlationKey: string;
  prompt: string;
  attempt: number;
}

export interface ModelResponse {
  output: string;
}

export interface ModelAdapter {
  readonly name: string;
  readonly version: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ToolRequest {
  correlationKey: string;
  arguments: JsonObject;
  attempt: number;
  runId: string;
}

export interface ToolAdapter {
  readonly name: string;
  readonly version: string;
  readonly sideEffect: 'read_only';
  call(request: ToolRequest): Promise<JsonValue | ArtifactReference>;
}

export interface ExampleAgentInput {
  goal: string;
}

export interface ExampleAgentOptions {
  recorder: Recorder;
  model: ModelAdapter;
  tools: readonly ToolAdapter[];
  maxToolAttempts?: number;
  runtime?: RuntimeDescriptor;
}

export interface ExampleAgentRunResult {
  run: RunHandle;
  status: RecorderRunStatus;
  finalState: JsonObject;
  finalStateHash: string;
  manifest: SnapshotManifest;
}
