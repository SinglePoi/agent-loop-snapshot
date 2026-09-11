import {
  validateWorkflow,
  workflowSchemaVersion,
  type EventEnvelope,
  type JsonSchema,
  type SideEffectLevel,
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowNodeId,
} from '@agent-loop-snapshot/schema';
import type { TraceSnapshot } from '@agent-loop-snapshot/trace';

import { assessTraceExecution } from './execution-gate.js';

export type TraceCompilerDiagnosticCode =
  | 'SOURCE_TRACE_INVALID'
  | 'SOURCE_TRACE_OBSERVATION_ONLY'
  | 'MISSING_RUN_STARTED'
  | 'NO_COMPILABLE_CALLS'
  | 'GENERATED_WORKFLOW_INVALID';

export interface TraceCompilerDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: TraceCompilerDiagnosticCode;
  readonly message: string;
  readonly eventIds?: readonly string[];
}

export interface TraceCompilerSourceMapEntry {
  readonly nodeId: WorkflowNodeId;
  readonly eventIds: readonly string[];
}

export interface TraceCompilerParameterCandidate {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly sourceEventIds: readonly string[];
  readonly reason: 'run_input';
}

export interface TraceCompilerEnvironmentConstant {
  readonly kind: 'model' | 'tool';
  readonly name: string;
  readonly sourceEventIds: readonly string[];
}

export interface TraceCompilerRemovedFailureStep {
  readonly kind: 'model' | 'tool';
  readonly correlationKey: string;
  readonly eventIds: readonly string[];
  readonly errorCodes: readonly string[];
  readonly reason: 'retry_merged' | 'terminal_failure_merged';
}

export interface TraceCompilationReport {
  readonly parameterCandidates: readonly TraceCompilerParameterCandidate[];
  readonly environmentConstants: readonly TraceCompilerEnvironmentConstant[];
  readonly removedFailureSteps: readonly TraceCompilerRemovedFailureStep[];
}

export interface TraceCompilationResult {
  readonly workflow?: WorkflowDocument;
  readonly sourceMap: readonly TraceCompilerSourceMapEntry[];
  readonly report: TraceCompilationReport;
  readonly diagnostics: readonly TraceCompilerDiagnostic[];
}

interface CallGroup {
  readonly kind: 'model' | 'tool';
  readonly correlationKey: string;
  readonly target: string;
  readonly requestEvents: EventEnvelope<string, unknown>[];
  readonly responseEvents: EventEnvelope<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === 'string' && value[field].trim() !== ''
    ? value[field]
    : undefined;
}

function sideEffect(event: EventEnvelope<string, unknown>): SideEffectLevel {
  const value = event.security.side_effect;
  return value === 'workspace_write' || value === 'external_write' || value === 'destructive'
    ? value
    : 'read_only';
}

function inferSchema(value: unknown): JsonSchema {
  if (value === null) {
    return { type: 'null' };
  }
  if (Array.isArray(value)) {
    return { type: 'array' };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'object':
      return { type: 'object' };
    default:
      return true;
  }
}

function collectGroups(events: readonly EventEnvelope<string, unknown>[]): CallGroup[] {
  const groups = new Map<string, CallGroup>();
  const key = (kind: 'model' | 'tool', correlationKey: string) => `${kind}\u0000${correlationKey}`;

  for (const event of events) {
    const kind =
      event.type === 'model.requested' ||
      event.type === 'model.completed' ||
      event.type === 'model.failed'
        ? 'model'
        : event.type === 'tool.requested' ||
            event.type === 'tool.completed' ||
            event.type === 'tool.failed'
          ? 'tool'
          : undefined;
    const correlationKey = stringField(event.payload, 'correlation_key');
    if (kind === undefined || correlationKey === undefined) {
      continue;
    }

    const groupKey = key(kind, correlationKey);
    const existing = groups.get(groupKey);
    const target =
      (event.type === 'model.requested' ? stringField(event.payload, 'model') : undefined) ??
      (event.type === 'tool.requested' ? stringField(event.payload, 'tool') : undefined) ??
      existing?.target;
    if (target === undefined) {
      continue;
    }
    const group =
      existing ??
      ({ kind, correlationKey, target, requestEvents: [], responseEvents: [] } satisfies CallGroup);
    if (event.type.endsWith('.requested')) {
      group.requestEvents.push(event);
    } else {
      group.responseEvents.push(event);
    }
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .filter((group) => group.requestEvents.length > 0)
    .sort((left, right) => left.requestEvents[0]!.sequence - right.requestEvents[0]!.sequence);
}

function uniqueSortedEventIds(events: readonly EventEnvelope<string, unknown>[]): string[] {
  return [...new Set(events.map((event) => event.event_id))].sort((left, right) => {
    const leftEvent = events.find((event) => event.event_id === left);
    const rightEvent = events.find((event) => event.event_id === right);
    return (leftEvent?.sequence ?? 0) - (rightEvent?.sequence ?? 0);
  });
}

function workflowId(trace: TraceSnapshot): WorkflowDocument['workflow_id'] {
  const runId = trace.manifest?.run_id ?? 'unknown';
  return `wf_${runId.replaceAll(/[^a-z0-9_-]/gu, '_')}`;
}

function nodeId(kind: CallGroup['kind'], index: number): WorkflowNodeId {
  return `node_${kind}_${String(index + 1)}`;
}

function requestParentDependencies(
  group: CallGroup,
  sourceNodeByEventId: ReadonlyMap<string, WorkflowNodeId>,
  sourceEventById: ReadonlyMap<string, EventEnvelope<string, unknown>>,
  ownNodeId: WorkflowNodeId,
): WorkflowNode['depends_on'] {
  const dependencies = new Map<WorkflowNodeId, WorkflowNode['depends_on'][number]>();
  group.requestEvents.forEach((request) => {
    const visited = new Set<string>();
    const pending = [...request.parent_ids];
    while (pending.length > 0) {
      const eventId = pending.pop();
      if (eventId === undefined || visited.has(eventId)) {
        continue;
      }
      visited.add(eventId);

      const ancestorNodeId = sourceNodeByEventId.get(eventId);
      if (ancestorNodeId !== undefined) {
        if (ancestorNodeId !== ownNodeId) {
          dependencies.set(ancestorNodeId, { node_id: ancestorNodeId, on: 'success' });
        }
        continue;
      }

      const ancestor = sourceEventById.get(eventId);
      if (ancestor !== undefined) {
        pending.push(...ancestor.parent_ids);
      }
    }
  });
  return [...dependencies.values()].sort((left, right) =>
    left.node_id.localeCompare(right.node_id),
  );
}

function failuresForGroup(group: CallGroup): TraceCompilerRemovedFailureStep[] {
  const failures = group.responseEvents.filter((event) => event.type.endsWith('.failed'));
  if (failures.length === 0) {
    return [];
  }
  const hasCompletedResponse = group.responseEvents.some((event) =>
    event.type.endsWith('.completed'),
  );
  return [
    {
      kind: group.kind,
      correlationKey: group.correlationKey,
      eventIds: uniqueSortedEventIds(failures),
      errorCodes: errorCodesForGroup(group),
      reason: hasCompletedResponse ? 'retry_merged' : 'terminal_failure_merged',
    },
  ];
}

function errorCodesForGroup(group: CallGroup): string[] {
  return [
    ...new Set(
      group.responseEvents
        .filter((event) => event.type.endsWith('.failed'))
        .map((event) => {
          const error = isRecord(event.payload) ? event.payload.error : undefined;
          return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
        })
        .filter((code): code is string => code !== undefined),
    ),
  ];
}

/**
 * Compiles a Trace into an intentionally conservative, editable workflow.
 * It preserves event provenance, but never copies source input values, tool
 * arguments, approval records, or payload text into the generated IR.
 */
export function compileTraceToWorkflow(trace: TraceSnapshot): TraceCompilationResult {
  const diagnostics: TraceCompilerDiagnostic[] = [];
  const sourceMap: TraceCompilerSourceMapEntry[] = [];
  const parameterCandidates: TraceCompilerParameterCandidate[] = [];
  const environmentConstants: TraceCompilerEnvironmentConstant[] = [];
  const removedFailureSteps: TraceCompilerRemovedFailureStep[] = [];
  const report: TraceCompilationReport = {
    parameterCandidates,
    environmentConstants,
    removedFailureSteps,
  };

  if (!trace.valid) {
    diagnostics.push({
      severity: 'error',
      code: 'SOURCE_TRACE_INVALID',
      message: 'Trace compilation requires a structurally valid source trace.',
    });
    return { sourceMap, report, diagnostics };
  }

  const eligibility = assessTraceExecution(trace);
  if (eligibility.eligibility === 'observation_only') {
    diagnostics.push({
      severity: 'error',
      code: 'SOURCE_TRACE_OBSERVATION_ONLY',
      message: `Trace compilation is blocked: ${eligibility.reason}`,
    });
    return { sourceMap, report, diagnostics };
  }

  const runStarted = trace.events.find((event) => event.type === 'run.started');
  if (runStarted === undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_RUN_STARTED',
      message: 'Trace compilation requires a run.started event.',
    });
    return { sourceMap, report, diagnostics };
  }

  const sourceInput = isRecord(runStarted.payload) ? runStarted.payload.input : undefined;
  if (isRecord(sourceInput)) {
    Object.entries(sourceInput)
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([name, value]) => {
        parameterCandidates.push({
          name,
          schema: inferSchema(value),
          sourceEventIds: [runStarted.event_id],
          reason: 'run_input',
        });
      });
  }

  const groups = collectGroups(trace.events);
  if (groups.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'NO_COMPILABLE_CALLS',
      message: 'Trace contains no model.requested or tool.requested events to compile.',
    });
    return { sourceMap, report, diagnostics };
  }

  const sourceNodeByEventId = new Map<string, WorkflowNodeId>();
  groups.forEach((group, index) => {
    const id = nodeId(group.kind, index);
    [...group.requestEvents, ...group.responseEvents].forEach((event) => {
      sourceNodeByEventId.set(event.event_id, id);
    });
  });
  const sourceEventById = new Map(trace.events.map((event) => [event.event_id, event]));

  const nodes: WorkflowNode[] = groups.map((group, index) => {
    const id = nodeId(group.kind, index);
    const eventIds = uniqueSortedEventIds([...group.requestEvents, ...group.responseEvents]);
    const retryOn = errorCodesForGroup(group);
    const terminalFailure = !group.responseEvents.some((event) =>
      event.type.endsWith('.completed'),
    );
    const request = group.requestEvents[0]!;
    const base = {
      node_id: id,
      depends_on: requestParentDependencies(group, sourceNodeByEventId, sourceEventById, id),
      ...(group.requestEvents.length > 1 || retryOn.length > 0
        ? {
            retry: {
              max_attempts: group.requestEvents.length,
              ...(retryOn.length === 0 ? {} : { retry_on: retryOn }),
            },
          }
        : {}),
      on_failure: terminalFailure ? ('continue' as const) : ('stop' as const),
      permissions: { side_effect: sideEffect(request) },
      success_conditions: [{ kind: 'output_schema' as const, schema: true }],
    };

    sourceMap.push({ nodeId: id, eventIds });
    environmentConstants.push({
      kind: group.kind,
      name: group.target,
      sourceEventIds: uniqueSortedEventIds(group.requestEvents),
    });
    removedFailureSteps.push(...failuresForGroup(group));

    return group.kind === 'model'
      ? {
          ...base,
          kind: 'agent_task',
          goal: 'Run the compiled model task.',
        }
      : {
          ...base,
          kind: 'tool_call',
          tool: group.target,
        };
  });

  const lastNode = nodes[nodes.length - 1]!;
  const workflow: WorkflowDocument = {
    schema_version: workflowSchemaVersion,
    workflow_type: 'agent-workflow',
    workflow_id: workflowId(trace),
    name: `Compiled ${trace.manifest?.runtime.name ?? 'agent'} workflow`,
    inputs: Object.fromEntries(
      report.parameterCandidates.map((candidate) => [
        candidate.name,
        { schema: candidate.schema, required: true },
      ]),
    ),
    nodes,
    outputs: {
      result: {
        from: { node_id: lastNode.node_id },
        schema: true,
      },
    },
  };

  const validation = validateWorkflow(workflow);
  if (!validation.valid) {
    diagnostics.push({
      severity: 'error',
      code: 'GENERATED_WORKFLOW_INVALID',
      message: 'Compiler generated an invalid Workflow IR.',
    });
    return { sourceMap, report, diagnostics };
  }

  return { workflow, sourceMap, report, diagnostics };
}
