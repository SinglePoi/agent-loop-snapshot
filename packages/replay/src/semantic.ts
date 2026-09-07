import {
  validateJsonSchemaValue,
  validateWorkflow,
  type ErrorInfo,
  type JsonValue,
  type WorkflowCondition,
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowVerifier,
} from '@agent-loop-snapshot/schema';
import { Recorder, hashState, type RunHandle } from '@agent-loop-snapshot/recorder';

import type { ReplayAdapterDescriptor, ReplayOutcome } from './adapters.js';
import {
  RecorderReplayPolicyAuditSink,
  ReplayPolicyEngine,
  type ReplayPolicyAction,
  type ReplayPolicyApproval,
  type ReplayPolicyOptions,
  createReplayPolicyAction,
} from './policy.js';

export interface SemanticAgentInvocation {
  readonly workflow: WorkflowDocument;
  readonly node: WorkflowNode;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly priorOutputs: Readonly<Record<string, JsonValue>>;
  readonly attempt: number;
}

/** An Agent may choose a different internal tool sequence than the source Trace. */
export interface SemanticAgentAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  execute(invocation: SemanticAgentInvocation): Promise<ReplayOutcome<JsonValue>>;
}

export interface SemanticVerifierInvocation {
  readonly workflow: WorkflowDocument;
  readonly node: WorkflowNode;
  readonly verifier: WorkflowVerifier;
  readonly output: JsonValue;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly outputs: Readonly<Record<string, JsonValue>>;
}

export interface SemanticVerifierAdapter {
  readonly descriptor: ReplayAdapterDescriptor;
  verify(invocation: SemanticVerifierInvocation): Promise<ReplayOutcome<JsonValue>>;
}

export type SemanticNodeStatus = 'completed' | 'failed' | 'skipped' | 'blocked';

export type SemanticAgentCapability =
  | 'semantic.node.agent_task'
  | 'semantic.node.tool_call'
  | 'semantic.node.verification'
  | 'semantic.node.human_approval';

export interface SemanticAgentCompatibility {
  readonly compatible: boolean;
  readonly required: readonly SemanticAgentCapability[];
  readonly unsupported: readonly SemanticAgentCapability[];
  /** No semantic node capability means a legacy adapter claims all node kinds. */
  readonly capabilityMode: 'explicit' | 'legacy_all';
}

export interface SemanticNodeResult {
  readonly nodeId: string;
  readonly status: SemanticNodeStatus;
  readonly attempts: number;
  readonly output?: JsonValue;
  readonly messages: readonly string[];
}

export type SemanticReplayDiagnosticCode =
  | 'INVALID_WORKFLOW'
  | 'INPUT_MISSING'
  | 'INPUT_SCHEMA_MISMATCH'
  | 'UNRESOLVED_DEPENDENCY'
  | 'POLICY_BLOCKED'
  | 'AGENT_FAILED'
  | 'AGENT_CAPABILITY_MISSING'
  | 'SUCCESS_CONDITION_FAILED'
  | 'VERIFIER_NOT_CONFIGURED'
  | 'VERIFIER_FAILED'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_SCHEMA_MISMATCH';

export interface SemanticReplayDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: SemanticReplayDiagnosticCode;
  readonly message: string;
  readonly nodeId?: string;
}

export interface SemanticReplayReport {
  /** The declared node order was followed without skipped nodes or retries. */
  readonly process: 'matched' | 'diverged';
  /** All declared output schemas and success conditions held for this new run. */
  readonly result: 'equivalent' | 'not_equivalent';
}

export interface SemanticReplayOptions {
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly approvalForAction?: (action: ReplayPolicyAction) => ReplayPolicyApproval | undefined;
}

export interface SemanticReplayRunnerOptions {
  readonly workflow: WorkflowDocument;
  readonly recorder: Recorder;
  readonly agent: SemanticAgentAdapter;
  readonly verifiers?: Readonly<Record<string, SemanticVerifierAdapter>>;
  readonly policy?: Omit<ReplayPolicyOptions, 'auditSink'>;
}

export interface SemanticReplayResult {
  readonly run: RunHandle;
  readonly nodeResults: readonly SemanticNodeResult[];
  readonly outputs: Readonly<Record<string, JsonValue>>;
  readonly diagnostics: readonly SemanticReplayDiagnostic[];
  readonly report: SemanticReplayReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]))
    );
  }
  return false;
}

function pointer(value: JsonValue | undefined, path: string | undefined): JsonValue | undefined {
  if (path === undefined || path === '') {
    return value;
  }
  if (!path.startsWith('/')) {
    return undefined;
  }
  let current: JsonValue | undefined = value;
  for (const rawSegment of path.slice(1).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isSafeInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment] as JsonValue | undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

function conditionValue(
  condition: WorkflowCondition,
  inputs: Readonly<Record<string, JsonValue>>,
  nodeOutputs: Readonly<Record<string, JsonValue>>,
): JsonValue | undefined {
  const source =
    condition.from.kind === 'input'
      ? inputs[condition.from.name]
      : nodeOutputs[condition.from.name];
  return pointer(source, condition.from.path);
}

function conditionPasses(
  condition: WorkflowCondition,
  inputs: Readonly<Record<string, JsonValue>>,
  nodeOutputs: Readonly<Record<string, JsonValue>>,
): boolean {
  const value = conditionValue(condition, inputs, nodeOutputs);
  switch (condition.operator) {
    case 'exists':
      return value !== undefined;
    case 'equals':
      return equalJson(value, condition.value);
    case 'not_equals':
      return !equalJson(value, condition.value);
    case 'truthy':
      return Boolean(value);
    case 'falsy':
      return !value;
  }
}

function failure(message: string): ErrorInfo {
  return { code: 'SEMANTIC_REPLAY_FAILED', message, retryable: false, kind: 'validation' };
}

function capabilityForNode(node: WorkflowNode): SemanticAgentCapability {
  return `semantic.node.${node.kind}` as SemanticAgentCapability;
}

export function inspectSemanticAgentCompatibility(
  workflow: WorkflowDocument,
  agent: Pick<SemanticAgentAdapter, 'descriptor'>,
): SemanticAgentCompatibility {
  const required = [
    ...new Set(workflow.nodes.map(capabilityForNode)),
  ].sort() as SemanticAgentCapability[];
  const declared = agent.descriptor.capabilities.filter(
    (capability): capability is SemanticAgentCapability => capability.startsWith('semantic.node.'),
  );
  if (declared.length === 0) {
    return { compatible: true, required, unsupported: [], capabilityMode: 'legacy_all' };
  }
  const unsupported = required.filter((capability) => !declared.includes(capability));
  return {
    compatible: unsupported.length === 0,
    required,
    unsupported,
    capabilityMode: 'explicit',
  };
}

function mostRestrictiveSideEffect(
  left: WorkflowNode['permissions']['side_effect'],
  right: ReplayAdapterDescriptor['sideEffect'],
): WorkflowNode['permissions']['side_effect'] {
  const ranks = { read_only: 0, workspace_write: 1, external_write: 2, destructive: 3 } as const;
  return ranks[left] >= ranks[right] ? left : right;
}

function dependenciesResolved(
  node: WorkflowNode,
  results: ReadonlyMap<string, SemanticNodeResult>,
): 'ready' | 'waiting' | 'blocked' {
  for (const dependency of node.depends_on) {
    const result = results.get(dependency.node_id);
    if (result === undefined) {
      return 'waiting';
    }
    if (
      (dependency.on === 'success' && result.status !== 'completed') ||
      (dependency.on === 'failure' && result.status !== 'failed') ||
      (dependency.on === 'always' && result.status === 'blocked')
    ) {
      return 'blocked';
    }
  }
  return 'ready';
}

export class SemanticReplayRunner {
  private readonly workflow: WorkflowDocument;
  private readonly recorder: Recorder;
  private readonly agent: SemanticAgentAdapter;
  private readonly verifiers: Readonly<Record<string, SemanticVerifierAdapter>>;
  private readonly policyOptions: Omit<ReplayPolicyOptions, 'auditSink'>;

  constructor(options: SemanticReplayRunnerOptions) {
    this.workflow = options.workflow;
    this.recorder = options.recorder;
    this.agent = options.agent;
    this.verifiers = options.verifiers ?? {};
    this.policyOptions = options.policy ?? {};
  }

  async run(options: SemanticReplayOptions): Promise<SemanticReplayResult> {
    const diagnostics: SemanticReplayDiagnostic[] = [];
    const nodeResults = new Map<string, SemanticNodeResult>();
    const nodeOutputs: Record<string, JsonValue> = {};
    const finalOutputs: Record<string, JsonValue> = {};
    const workflowValidation = validateWorkflow(this.workflow);
    const run = await this.recorder.startRun({
      runtime: {
        name: 'semantic-replay',
        version: '0.1.0',
        adapter: '@agent-loop-snapshot/replay',
      },
      input: {
        workflow_id: this.workflow.workflow_id,
        input_names: Object.keys(options.inputs).sort(),
      },
    });

    if (!workflowValidation.valid) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_WORKFLOW',
        message: 'Semantic replay requires a valid Workflow IR.',
      });
      await this.recorder.failRun(run, failure(diagnostics[0]!.message));
      return this.result(run, nodeResults, finalOutputs, diagnostics, false, false);
    }
    if (!this.agent.descriptor.capabilities.includes('agent.execute')) {
      diagnostics.push({
        severity: 'error',
        code: 'AGENT_FAILED',
        message: 'Semantic Agent adapter does not declare the agent.execute capability.',
      });
      await this.recorder.failRun(run, failure(diagnostics[0]!.message));
      return this.result(run, nodeResults, finalOutputs, diagnostics, false, false);
    }
    const compatibility = inspectSemanticAgentCompatibility(this.workflow, this.agent);
    if (!compatibility.compatible) {
      diagnostics.push({
        severity: 'error',
        code: 'AGENT_CAPABILITY_MISSING',
        message: `Semantic Agent adapter does not support: ${compatibility.unsupported.join(', ')}.`,
      });
      await this.recorder.failRun(run, failure(diagnostics[0]!.message));
      return this.result(run, nodeResults, finalOutputs, diagnostics, false, false);
    }

    for (const [name, definition] of Object.entries(this.workflow.inputs)) {
      const value = options.inputs[name];
      if (value === undefined) {
        if (definition.required === true) {
          diagnostics.push({
            severity: 'error',
            code: 'INPUT_MISSING',
            message: `Required workflow input "${name}" is missing.`,
          });
        }
        continue;
      }
      const validation = validateJsonSchemaValue(definition.schema, value);
      if (!validation.valid) {
        diagnostics.push({
          severity: 'error',
          code: 'INPUT_SCHEMA_MISMATCH',
          message: `Workflow input "${name}" does not match its schema.`,
        });
      }
    }
    if (diagnostics.length > 0) {
      await this.recorder.failRun(run, failure(diagnostics[0]!.message));
      return this.result(run, nodeResults, finalOutputs, diagnostics, false, false);
    }

    const policy = new ReplayPolicyEngine({
      ...this.policyOptions,
      auditSink: new RecorderReplayPolicyAuditSink(this.recorder, run),
    });
    const pending = new Set(this.workflow.nodes.map((node) => node.node_id));
    let stopped = false;

    while (pending.size > 0 && !stopped) {
      let progressed = false;
      for (const node of this.workflow.nodes) {
        if (!pending.has(node.node_id)) {
          continue;
        }
        const state = dependenciesResolved(node, nodeResults);
        if (state === 'waiting') {
          continue;
        }
        if (state === 'blocked') {
          nodeResults.set(node.node_id, {
            nodeId: node.node_id,
            status: 'blocked',
            attempts: 0,
            messages: ['A dependency did not reach the required outcome.'],
          });
          pending.delete(node.node_id);
          progressed = true;
          continue;
        }
        if (
          node.condition !== undefined &&
          !conditionPasses(node.condition, options.inputs, nodeOutputs)
        ) {
          nodeResults.set(node.node_id, {
            nodeId: node.node_id,
            status: 'skipped',
            attempts: 0,
            messages: ['The node condition evaluated to false.'],
          });
          pending.delete(node.node_id);
          progressed = true;
          continue;
        }

        const result = await this.executeNode(
          node,
          options.inputs,
          nodeOutputs,
          policy,
          options,
          run,
        );
        nodeResults.set(node.node_id, result);
        pending.delete(node.node_id);
        progressed = true;
        if (result.status === 'completed' && result.output !== undefined) {
          nodeOutputs[node.node_id] = result.output;
        }
        if (result.status === 'failed') {
          const policyBlocked = result.messages.some((message) =>
            message.startsWith('Policy blocked attempt '),
          );
          diagnostics.push({
            severity: 'error',
            code: policyBlocked ? 'POLICY_BLOCKED' : 'SUCCESS_CONDITION_FAILED',
            nodeId: node.node_id,
            message: result.messages.at(-1) ?? `Workflow node "${node.node_id}" failed.`,
          });
          if (node.on_failure === 'stop') {
            stopped = true;
            break;
          }
        }
      }
      if (!progressed) {
        pending.forEach((nodeId) => {
          nodeResults.set(nodeId, {
            nodeId,
            status: 'blocked',
            attempts: 0,
            messages: ['Dependencies could not be resolved.'],
          });
          diagnostics.push({
            severity: 'error',
            code: 'UNRESOLVED_DEPENDENCY',
            nodeId,
            message: `Workflow node "${nodeId}" could not be scheduled.`,
          });
        });
        pending.clear();
      }
    }

    if (stopped) {
      pending.forEach((nodeId) => {
        nodeResults.set(nodeId, {
          nodeId,
          status: 'blocked',
          attempts: 0,
          messages: ['Execution stopped after a terminal node failure.'],
        });
      });
    }

    let outputsValid = true;
    for (const [name, definition] of Object.entries(this.workflow.outputs)) {
      const value = pointer(nodeOutputs[definition.from.node_id], definition.from.path);
      if (value === undefined) {
        outputsValid = false;
        diagnostics.push({
          severity: 'error',
          code: 'OUTPUT_MISSING',
          message: `Workflow output "${name}" is missing.`,
        });
        continue;
      }
      finalOutputs[name] = value;
      if (!validateJsonSchemaValue(definition.schema, value).valid) {
        outputsValid = false;
        diagnostics.push({
          severity: 'error',
          code: 'OUTPUT_SCHEMA_MISMATCH',
          message: `Workflow output "${name}" does not match its schema.`,
        });
      }
    }

    const complete = diagnostics.length === 0 && outputsValid;
    if (complete) {
      await this.recorder.completeRun(run, {
        final_state_hash: hashState({ outputs: finalOutputs }),
        output: finalOutputs,
      });
    } else {
      await this.recorder.failRun(
        run,
        failure(diagnostics[0]?.message ?? 'Semantic replay failed.'),
      );
    }
    const processMatched =
      [...nodeResults.values()].every(
        (result) => result.status === 'completed' && result.attempts === 1,
      ) &&
      [...nodeResults.keys()].every(
        (nodeId, index) => nodeId === this.workflow.nodes[index]?.node_id,
      );
    return this.result(run, nodeResults, finalOutputs, diagnostics, processMatched, complete);
  }

  private async executeNode(
    node: WorkflowNode,
    inputs: Readonly<Record<string, JsonValue>>,
    outputs: Readonly<Record<string, JsonValue>>,
    policy: ReplayPolicyEngine,
    options: SemanticReplayOptions,
    run: RunHandle,
  ): Promise<SemanticNodeResult> {
    const maxAttempts = node.retry?.max_attempts ?? 1;
    const messages: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const action = createReplayPolicyAction({
        mode: 'live',
        adapterKind: 'agent',
        target: node.node_id,
        sideEffect: mostRestrictiveSideEffect(
          node.permissions.side_effect,
          this.agent.descriptor.sideEffect,
        ),
        correlationKey: `semantic/${this.workflow.workflow_id}/${node.node_id}`,
        attempt,
      });
      const execution = await policy.execute(
        action,
        () =>
          this.agent.execute({
            workflow: this.workflow,
            node,
            inputs,
            priorOutputs: outputs,
            attempt,
          }),
        (() => {
          const approval = options.approvalForAction?.(action);
          return {
            ...(node.permissions.requires_approval === true ? { requiresApproval: true } : {}),
            ...(approval === undefined ? {} : { approval }),
          };
        })(),
      );
      if (!execution.executed || execution.value === undefined) {
        messages.push(`Policy blocked attempt ${String(attempt)}: ${execution.decision.decision}.`);
        return { nodeId: node.node_id, status: 'failed', attempts: attempt, messages };
      }
      const outcome = execution.value;
      if (outcome.status === 'failed') {
        messages.push(outcome.error.code);
        continue;
      }
      const verification = await this.verifyNode(
        node,
        outcome.output,
        inputs,
        outputs,
        policy,
        options,
        attempt,
      );
      if (verification.length === 0) {
        await this.recorder.appendEvent(this.recorder.context(run), {
          type: 'decision.recorded',
          payload: {
            decision: `node ${node.node_id} completed`,
            basis_summary: 'Semantic node output met its declared success conditions.',
            success_conditions: ['all declared conditions passed'],
          },
          security: { side_effect: 'read_only', redactions: [] },
        });
        return {
          nodeId: node.node_id,
          status: 'completed',
          attempts: attempt,
          output: outcome.output,
          messages,
        };
      }
      messages.push(...verification);
    }
    return { nodeId: node.node_id, status: 'failed', attempts: maxAttempts, messages };
  }

  private async verifyNode(
    node: WorkflowNode,
    output: JsonValue,
    inputs: Readonly<Record<string, JsonValue>>,
    outputs: Readonly<Record<string, JsonValue>>,
    policy: ReplayPolicyEngine,
    options: SemanticReplayOptions,
    attempt: number,
  ): Promise<string[]> {
    const messages: string[] = [];
    for (const condition of node.success_conditions) {
      if (
        condition.kind === 'output_schema' &&
        !validateJsonSchemaValue(condition.schema, output).valid
      ) {
        messages.push('Output does not match a declared success schema.');
      } else if (
        condition.kind === 'condition' &&
        !conditionPasses(condition.condition, inputs, { ...outputs, [node.node_id]: output })
      ) {
        messages.push('A declared success condition evaluated to false.');
      } else if (condition.kind === 'verifier') {
        messages.push(
          ...(await this.runVerifier(
            condition.verifier_id,
            node,
            output,
            inputs,
            outputs,
            policy,
            options,
            attempt,
          )),
        );
      }
    }
    if (node.kind === 'verification') {
      messages.push(
        ...(await this.runVerifier(
          node.verifier_id,
          node,
          output,
          inputs,
          outputs,
          policy,
          options,
          attempt,
        )),
      );
    }
    return messages;
  }

  private async runVerifier(
    verifierId: string,
    node: WorkflowNode,
    output: JsonValue,
    inputs: Readonly<Record<string, JsonValue>>,
    outputs: Readonly<Record<string, JsonValue>>,
    policy: ReplayPolicyEngine,
    options: SemanticReplayOptions,
    attempt: number,
  ): Promise<string[]> {
    const verifier = this.workflow.verifiers?.find((entry) => entry.verifier_id === verifierId);
    if (verifier === undefined) {
      return [`Verifier "${verifierId}" is not declared.`];
    }
    if (verifier.kind === 'json_schema') {
      return validateJsonSchemaValue(verifier.schema, output).valid
        ? []
        : [`Verifier "${verifierId}" rejected the output schema.`];
    }
    const adapter = this.verifiers[verifierId];
    if (adapter === undefined) {
      return [`Verifier "${verifierId}" is not configured.`];
    }
    const action = createReplayPolicyAction({
      mode: 'live',
      adapterKind: 'verifier',
      target: verifierId,
      sideEffect: adapter.descriptor.sideEffect,
      correlationKey: `semantic/${this.workflow.workflow_id}/${node.node_id}/${verifierId}`,
      attempt,
    });
    const execution = await policy.execute(
      action,
      () => adapter.verify({ workflow: this.workflow, node, verifier, output, inputs, outputs }),
      (() => {
        const approval = options.approvalForAction?.(action);
        return approval === undefined ? {} : { approval };
      })(),
    );
    if (!execution.executed || execution.value === undefined) {
      return [`Verifier "${verifierId}" was blocked by policy.`];
    }
    return execution.value.status === 'completed'
      ? []
      : [`Verifier "${verifierId}" failed: ${execution.value.error.code}.`];
  }

  private result(
    run: RunHandle,
    results: ReadonlyMap<string, SemanticNodeResult>,
    outputs: Readonly<Record<string, JsonValue>>,
    diagnostics: readonly SemanticReplayDiagnostic[],
    processMatched: boolean,
    resultEquivalent: boolean,
  ): SemanticReplayResult {
    return {
      run,
      nodeResults: this.workflow.nodes
        .map((node) => results.get(node.node_id))
        .filter((result): result is SemanticNodeResult => result !== undefined),
      outputs,
      diagnostics,
      report: {
        process: processMatched ? 'matched' : 'diverged',
        result: resultEquivalent ? 'equivalent' : 'not_equivalent',
      },
    };
  }
}
