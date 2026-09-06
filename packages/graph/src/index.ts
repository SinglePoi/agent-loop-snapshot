import type { EventEnvelope } from '@agent-loop-snapshot/schema';
import type { TraceSnapshot } from '@agent-loop-snapshot/trace';

export interface GraphProjector {
  readonly packageName: '@agent-loop-snapshot/graph';
}

export const graphPackageName: GraphProjector['packageName'] = '@agent-loop-snapshot/graph';

export type GraphProjectionKind = 'causal-dag' | 'call-tree' | 'timeline';
export type GraphEdgeKind = 'causal' | 'timeline';
export type GraphNodeStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'changed'
  | 'recorded'
  | 'checkpointed'
  | 'verified'
  | 'unknown';

export interface GraphFilter {
  readonly actor?: string | readonly string[];
  readonly type?: string | readonly string[];
  readonly status?: GraphNodeStatus | readonly GraphNodeStatus[];
  readonly minSequence?: number;
  readonly maxSequence?: number;
}

export interface GraphProjectionOptions {
  readonly filter?: GraphFilter;
  /** Collapse adjacent model stream and low-level noise events. Defaults to true. */
  readonly foldNoise?: boolean;
}

export interface GraphNode {
  /** Stable presentation ID; for an ordinary event this equals eventId. */
  readonly id: string;
  readonly eventId: string;
  readonly eventIds: readonly string[];
  readonly sequence: number;
  readonly sequenceEnd: number;
  readonly timestamp: string;
  readonly timestampEnd: string;
  readonly actor: string;
  readonly actors: readonly string[];
  readonly type: string;
  readonly types: readonly string[];
  readonly status: GraphNodeStatus;
  readonly label: string;
  readonly parentEventIds: readonly string[];
  readonly folded: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: GraphEdgeKind;
}

export interface GraphProjection {
  readonly kind: GraphProjectionKind;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

interface EventGroup {
  readonly events: readonly EventEnvelope<string, unknown>[];
  readonly foldKind?: 'model-stream' | 'low-level';
}

interface ProjectedGraph {
  readonly groups: readonly EventGroup[];
  readonly nodes: readonly GraphNode[];
  readonly nodeByEventId: ReadonlyMap<string, GraphNode>;
}

function statusForType(type: string): GraphNodeStatus {
  if (type.endsWith('.failed') || type === 'run.failed') {
    return 'failed';
  }
  if (type.endsWith('.completed') || type === 'run.completed') {
    return 'completed';
  }
  if (type === 'state.changed') {
    return 'changed';
  }
  if (type === 'decision.recorded') {
    return 'recorded';
  }
  if (type === 'checkpoint.created') {
    return 'checkpointed';
  }
  if (type === 'verification.completed') {
    return 'verified';
  }
  if (type.endsWith('.requested') || type === 'run.started') {
    return 'started';
  }
  return 'unknown';
}

function aggregateStatus(events: readonly EventEnvelope<string, unknown>[]): GraphNodeStatus {
  const statuses = events.map((event) => statusForType(event.type));
  if (statuses.includes('failed')) {
    return 'failed';
  }
  if (statuses.includes('completed')) {
    return 'completed';
  }
  return statuses[0] ?? 'unknown';
}

function foldKind(type: string): EventGroup['foldKind'] {
  if (/^(model\.)/.test(type) && /(?:delta|stream|chunk|token|partial|segment)/.test(type)) {
    return 'model-stream';
  }
  if (/^(?:span|telemetry|trace|log|debug|internal|stream)\./.test(type)) {
    return 'low-level';
  }
  return undefined;
}

function groupEvents(
  events: readonly EventEnvelope<string, unknown>[],
  shouldFold: boolean,
): EventGroup[] {
  const groups: EventGroup[] = [];
  events.forEach((event) => {
    const kind = shouldFold ? foldKind(event.type) : undefined;
    const previous = groups.at(-1);
    if (kind !== undefined && previous?.foldKind === kind) {
      groups[groups.length - 1] = {
        ...previous,
        events: [...previous.events, event],
      };
      return;
    }
    groups.push({
      events: [event],
      ...(kind === undefined ? {} : { foldKind: kind }),
    });
  });
  return groups;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function createNode(group: EventGroup): GraphNode {
  const first = group.events[0];
  const last = group.events.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('Cannot project an empty event group.');
  }

  const eventIds = group.events.map((event) => event.event_id);
  const types = uniqueStrings(group.events.map((event) => event.type));
  const actors = uniqueStrings(group.events.map((event) => event.actor));
  const parentEventIds = uniqueStrings(group.events.flatMap((event) => event.parent_ids));
  const folded = group.events.length > 1;
  const label = folded
    ? `${group.foldKind === 'model-stream' ? 'model stream' : 'low-level events'} (${String(group.events.length)})`
    : first.type;

  return {
    id: folded ? `group:${first.event_id}` : first.event_id,
    eventId: first.event_id,
    eventIds,
    sequence: first.sequence,
    sequenceEnd: last.sequence,
    timestamp: first.timestamp,
    timestampEnd: last.timestamp,
    actor: actors.length === 1 ? (actors[0] ?? first.actor) : 'multiple',
    actors,
    type: types.length === 1 ? (types[0] ?? first.type) : 'multiple',
    types,
    status: aggregateStatus(group.events),
    label,
    parentEventIds,
    folded,
  };
}

function valuesMatch<T extends string>(actual: T, expected: T | readonly T[] | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

function matchesFilter(node: GraphNode, filter: GraphFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return (
    valuesMatch(node.actor, filter.actor) &&
    (filter.type === undefined || node.types.some((type) => valuesMatch(type, filter.type))) &&
    valuesMatch(node.status, filter.status) &&
    (filter.minSequence === undefined || node.sequenceEnd >= filter.minSequence) &&
    (filter.maxSequence === undefined || node.sequence <= filter.maxSequence)
  );
}

function projectBase(snapshot: TraceSnapshot, options: GraphProjectionOptions): ProjectedGraph {
  const groups = groupEvents(snapshot.events, options.foldNoise ?? true);
  const allNodes = groups.map(createNode);
  const nodes = allNodes.filter((node) => matchesFilter(node, options.filter));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const nodeByEventId = new Map<string, GraphNode>();

  groups.forEach((group, groupIndex) => {
    const node = allNodes[groupIndex];
    if (node !== undefined && visibleIds.has(node.id)) {
      group.events.forEach((event) => nodeByEventId.set(event.event_id, node));
    }
  });

  return { groups, nodes, nodeByEventId };
}

function addEdge(
  edges: Map<string, GraphEdge>,
  from: GraphNode | undefined,
  to: GraphNode | undefined,
  kind: GraphEdgeKind,
): void {
  if (from === undefined || to === undefined || from.id === to.id) {
    return;
  }
  const key = `${kind}:${from.id}\u0000${to.id}`;
  edges.set(key, { from: from.id, to: to.id, kind });
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return (
    left.timestamp.localeCompare(right.timestamp) ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

function causalEdges(base: ProjectedGraph, mode: 'dag' | 'tree'): GraphEdge[] {
  const edges = new Map<string, GraphEdge>();
  base.nodes.forEach((node) => {
    const parents = uniqueStrings(node.parentEventIds)
      .map((eventId) => base.nodeByEventId.get(eventId))
      .filter((parent): parent is GraphNode => parent !== undefined)
      .sort(compareNodes);
    const selectedParents = mode === 'tree' ? parents.slice(0, 1) : parents;
    selectedParents.forEach((parent) => addEdge(edges, parent, node, 'causal'));
  });
  return [...edges.values()].sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function timelineEdges(nodes: readonly GraphNode[]): GraphEdge[] {
  const ordered = [...nodes].sort(compareNodes);
  const edges: GraphEdge[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined) {
      edges.push({ from: previous.id, to: current.id, kind: 'timeline' });
    }
  }
  return edges;
}

function project(
  snapshot: TraceSnapshot,
  kind: GraphProjectionKind,
  options: GraphProjectionOptions = {},
): GraphProjection {
  const base = projectBase(snapshot, options);
  const nodes = kind === 'timeline' ? [...base.nodes].sort(compareNodes) : base.nodes;
  const edges =
    kind === 'causal-dag'
      ? causalEdges(base, 'dag')
      : kind === 'call-tree'
        ? causalEdges(base, 'tree')
        : timelineEdges(nodes);
  return { kind, nodes, edges };
}

export function projectCausalDag(
  snapshot: TraceSnapshot,
  options: GraphProjectionOptions = {},
): GraphProjection {
  return project(snapshot, 'causal-dag', options);
}

export function projectCallTree(
  snapshot: TraceSnapshot,
  options: GraphProjectionOptions = {},
): GraphProjection {
  return project(snapshot, 'call-tree', options);
}

export function projectTimeline(
  snapshot: TraceSnapshot,
  options: GraphProjectionOptions = {},
): GraphProjection {
  return project(snapshot, 'timeline', options);
}

export function projectGraph(
  snapshot: TraceSnapshot,
  kind: GraphProjectionKind,
  options: GraphProjectionOptions = {},
): GraphProjection {
  return project(snapshot, kind, options);
}
