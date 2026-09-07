import type { EventEnvelope, SideEffectLevel } from '@agent-loop-snapshot/schema';
import type { EventContext, Recorder, RunHandle } from '@agent-loop-snapshot/recorder';

import type { ReplayAdapterKind, ReplayAdapterMode } from './adapters.js';

export type ReplayPolicyDecisionKind = 'allow' | 'deny' | 'dry_run' | 'require_approval';

export interface ReplayPolicyActionInput {
  readonly mode: ReplayAdapterMode;
  readonly adapterKind: ReplayAdapterKind;
  readonly target: string;
  readonly sideEffect: SideEffectLevel;
  readonly correlationKey: string;
  readonly attempt: number;
}

export interface ReplayPolicyAction extends ReplayPolicyActionInput {
  /** A deterministic identity used to bind a fresh approval to this action. */
  readonly id: string;
}

export interface ReplayPolicyRule {
  readonly decision: ReplayPolicyDecisionKind;
  readonly mode?: ReplayAdapterMode;
  readonly adapterKind?: ReplayAdapterKind;
  readonly target?: string;
  readonly sideEffect?: SideEffectLevel;
}

/**
 * An approval is valid only for the current action identity. It intentionally
 * has no representation for a historical trace's authorization.
 */
export interface ReplayPolicyApproval {
  readonly actionId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface ReplayPolicyDecision {
  readonly action: ReplayPolicyAction;
  readonly decision: ReplayPolicyDecisionKind;
  readonly reason: string;
  readonly ruleIndex?: number;
  readonly approval?: ReplayPolicyApproval;
}

export interface ReplayPolicyExecution<T> {
  readonly decision: ReplayPolicyDecision;
  readonly executed: boolean;
  readonly value?: T;
}

export interface ReplayPolicyAuditSink {
  record(decision: ReplayPolicyDecision): Promise<void>;
}

export interface ReplayPolicyOptions {
  /** First matching rule wins; unmatched actions use the secure default. */
  readonly rules?: readonly ReplayPolicyRule[];
  readonly auditSink?: ReplayPolicyAuditSink;
}

export interface ReplayPolicyEvaluationOptions {
  /** A newly supplied approval for this action, never one read from a trace. */
  readonly approval?: ReplayPolicyApproval;
}

export class ReplayPolicyError extends Error {
  constructor(
    readonly code:
      'INVALID_POLICY_TARGET' | 'INVALID_POLICY_CORRELATION_KEY' | 'INVALID_POLICY_ATTEMPT',
    message: string,
  ) {
    super(message);
    this.name = 'ReplayPolicyError';
  }
}

export function createReplayPolicyAction(input: ReplayPolicyActionInput): ReplayPolicyAction {
  if (input.target.trim() === '') {
    throw new ReplayPolicyError(
      'INVALID_POLICY_TARGET',
      'A policy action target must not be empty.',
    );
  }
  if (input.correlationKey.trim() === '') {
    throw new ReplayPolicyError(
      'INVALID_POLICY_CORRELATION_KEY',
      'A policy action correlation key must not be empty.',
    );
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new ReplayPolicyError(
      'INVALID_POLICY_ATTEMPT',
      'A policy action attempt must be a positive safe integer.',
    );
  }

  const idParts = [
    input.mode,
    input.adapterKind,
    input.sideEffect,
    input.target,
    input.correlationKey,
    String(input.attempt),
  ].map(encodeURIComponent);
  return { ...input, id: `replay-policy/v1/${idParts.join('/')}` };
}

function matches(rule: ReplayPolicyRule, action: ReplayPolicyAction): boolean {
  return (
    (rule.mode === undefined || rule.mode === action.mode) &&
    (rule.adapterKind === undefined || rule.adapterKind === action.adapterKind) &&
    (rule.target === undefined || rule.target === action.target) &&
    (rule.sideEffect === undefined || rule.sideEffect === action.sideEffect)
  );
}

function defaultDecision(action: ReplayPolicyAction): ReplayPolicyDecisionKind {
  // Recorded results are mock data. They do not repeat a source run's effect.
  if (action.mode === 'recorded') {
    return 'allow';
  }
  return action.sideEffect === 'read_only' ? 'allow' : 'deny';
}

function defaultReason(action: ReplayPolicyAction, decision: ReplayPolicyDecisionKind): string {
  if (action.mode === 'recorded') {
    return 'Recorded result adapters are permitted because they do not invoke a live dependency.';
  }
  if (decision === 'allow') {
    return 'Live read-only operations are permitted by the default replay policy.';
  }
  return `Live ${action.sideEffect} operations are denied by the default replay policy.`;
}

/**
 * Evaluates current replay authority. It never examines source trace security
 * metadata, so a historical approval cannot authorize a new execution.
 */
export class ReplayPolicyEngine {
  private readonly rules: readonly ReplayPolicyRule[];
  private readonly auditSink: ReplayPolicyAuditSink | undefined;

  constructor(options: ReplayPolicyOptions = {}) {
    this.rules = options.rules ?? [];
    this.auditSink = options.auditSink;
  }

  evaluate(
    action: ReplayPolicyAction,
    options: ReplayPolicyEvaluationOptions = {},
  ): ReplayPolicyDecision {
    const ruleIndex = this.rules.findIndex((rule) => matches(rule, action));
    const configuredDecision =
      ruleIndex === -1 ? defaultDecision(action) : this.rules[ruleIndex]!.decision;
    const reason =
      ruleIndex === -1
        ? defaultReason(action, configuredDecision)
        : `Rule ${String(ruleIndex)} selected ${configuredDecision} for this current replay action.`;

    if (configuredDecision !== 'require_approval') {
      return {
        action,
        decision: configuredDecision,
        reason,
        ...(ruleIndex === -1 ? {} : { ruleIndex }),
      };
    }

    const approval = options.approval;
    if (approval !== undefined && approval.actionId === action.id) {
      return {
        action,
        decision: 'allow',
        reason: `Rule ${String(ruleIndex)} required approval; a matching current approval was supplied.`,
        ruleIndex,
        approval,
      };
    }
    return {
      action,
      decision: 'require_approval',
      reason: `${reason} A matching approval for this action has not been supplied.`,
      ...(ruleIndex === -1 ? {} : { ruleIndex }),
    };
  }

  /** Records a decision before returning it; audit failures block execution. */
  async authorize(
    action: ReplayPolicyAction,
    options: ReplayPolicyEvaluationOptions = {},
  ): Promise<ReplayPolicyDecision> {
    const decision = this.evaluate(action, options);
    await this.auditSink?.record(decision);
    return decision;
  }

  /**
   * Runs an operation only after an allow decision has been durably handed to
   * the configured audit sink. deny, dry_run, and require_approval never call
   * the operation.
   */
  async execute<T>(
    action: ReplayPolicyAction,
    operation: () => T | Promise<T>,
    options: ReplayPolicyEvaluationOptions = {},
  ): Promise<ReplayPolicyExecution<T>> {
    const decision = await this.authorize(action, options);
    if (decision.decision !== 'allow') {
      return { decision, executed: false };
    }
    return { decision, executed: true, value: await operation() };
  }
}

export interface RecorderReplayPolicyAuditOptions {
  readonly actor?: string;
  readonly context?: (decision: ReplayPolicyDecision) => EventContext;
}

/** Writes policy decisions as `decision.recorded` events in a newly started Replay Trace. */
export class RecorderReplayPolicyAuditSink implements ReplayPolicyAuditSink {
  private readonly actor: string;
  private readonly context: ((decision: ReplayPolicyDecision) => EventContext) | undefined;

  constructor(
    private readonly recorder: Recorder,
    private readonly run: RunHandle,
    options: RecorderReplayPolicyAuditOptions = {},
  ) {
    this.actor = options.actor ?? 'replay.policy';
    this.context = options.context;
  }

  async record(decision: ReplayPolicyDecision): Promise<void> {
    const context = this.context?.(decision) ?? this.run.context(undefined, this.actor);
    await this.recorder.appendEvent(context, {
      type: 'decision.recorded',
      actor: this.actor,
      security: { side_effect: 'read_only', redactions: [] },
      payload: {
        decision: `policy.${decision.decision}`,
        basis_summary: decision.reason,
        success_conditions: ['policy decision recorded before adapter execution'],
        policy: {
          action_id: decision.action.id,
          mode: decision.action.mode,
          adapter_kind: decision.action.adapterKind,
          target: decision.action.target,
          side_effect: decision.action.sideEffect,
          correlation_key: decision.action.correlationKey,
          attempt: decision.action.attempt,
          ...(decision.ruleIndex === undefined ? {} : { rule_index: decision.ruleIndex }),
          approved: decision.approval !== undefined,
        },
      },
    });
  }
}

export type ReplayPolicyAuditEvent = EventEnvelope<'decision.recorded', unknown>;
