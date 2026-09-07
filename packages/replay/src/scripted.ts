import type { ErrorInfo, JsonValue, WorkflowNode } from '@agent-loop-snapshot/schema';

import type { ReplayOutcome } from './adapters.js';
import type {
  SemanticAgentAdapter,
  SemanticAgentCapability,
  SemanticAgentInvocation,
} from './semantic.js';

export interface ScriptedSemanticRuntimeOptions {
  readonly name?: string;
  readonly supportedNodes?: readonly SemanticAgentCapability[];
  readonly execute: (
    invocation: SemanticAgentInvocation,
  ) => ReplayOutcome<JsonValue> | Promise<ReplayOutcome<JsonValue>>;
}

/**
 * A deterministic second Semantic Agent runtime for portability and
 * compatibility tests. Production runtimes can implement the same structural
 * SemanticAgentAdapter interface without depending on this package.
 */
export class ScriptedSemanticRuntimeAdapter implements SemanticAgentAdapter {
  readonly descriptor;
  private readonly handler: ScriptedSemanticRuntimeOptions['execute'];

  constructor(options: ScriptedSemanticRuntimeOptions) {
    this.descriptor = {
      name: options.name ?? 'scripted-semantic-runtime',
      version: '0.1.0',
      capabilities: ['agent.execute', ...(options.supportedNodes ?? allNodeCapabilities)] as const,
      sideEffect: 'read_only' as const,
    };
    this.handler = options.execute;
  }

  execute(invocation: SemanticAgentInvocation): Promise<ReplayOutcome<JsonValue>> {
    return Promise.resolve(this.handler(invocation));
  }
}

const allNodeCapabilities = [
  'semantic.node.agent_task',
  'semantic.node.tool_call',
  'semantic.node.verification',
  'semantic.node.human_approval',
] as const satisfies readonly SemanticAgentCapability[];

export function unsupportedSemanticNode(node: WorkflowNode): ReplayOutcome<JsonValue> {
  const error: ErrorInfo = {
    code: 'UNSUPPORTED_SEMANTIC_NODE',
    message: `The scripted Semantic Runtime does not implement ${node.kind}.`,
    retryable: false,
    kind: 'runtime',
  };
  return { status: 'failed', error };
}
