import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { EventEnvelope } from '@agent-loop-snapshot/schema';
import { loadTraceSnapshot } from '@agent-loop-snapshot/trace';

import { projectCallTree, projectCausalDag, projectTimeline } from './index.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parallelFixture = resolve(packageDirectory, '../schema/fixtures/parallel-calls');
const causalDagGolden = resolve(packageDirectory, 'golden/parallel-calls.causal-dag.json');

test('projects parallel branches and multi-parent joins without serializing causality', async () => {
  const snapshot = await loadTraceSnapshot(parallelFixture);
  const graph = projectCausalDag(snapshot);

  assert.equal(graph.kind, 'causal-dag');
  assert.equal(graph.nodes.length, 7);
  assert.equal(graph.edges.length, 7);

  const requestA = 'evt_00000000-0000-4000-8000-000000000022';
  const requestB = 'evt_00000000-0000-4000-8000-000000000023';
  const completeA = 'evt_00000000-0000-4000-8000-000000000024';
  const completeB = 'evt_00000000-0000-4000-8000-000000000025';
  const join = 'evt_00000000-0000-4000-8000-000000000026';
  const edgeKeys = new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));

  assert.ok(edgeKeys.has(`${requestA}->${completeA}`));
  assert.ok(edgeKeys.has(`${requestB}->${completeB}`));
  assert.ok(edgeKeys.has(`${completeA}->${join}`));
  assert.ok(edgeKeys.has(`${completeB}->${join}`));
  assert.equal(edgeKeys.has(`${requestA}->${requestB}`), false);
  assert.equal(edgeKeys.has(`${requestB}->${requestA}`), false);

  const joinNode = graph.nodes.find((node) => node.eventId === join);
  assert.ok(joinNode);
  assert.deepEqual(joinNode.parentEventIds, [completeA, completeB]);
  assert.deepEqual(joinNode.eventIds, [join]);
});

test('matches the stable causal DAG golden snapshot', async () => {
  const snapshot = await loadTraceSnapshot(parallelFixture);
  const expected = JSON.parse(await readFile(causalDagGolden, 'utf8')) as unknown;

  assert.deepEqual(projectCausalDag(snapshot), expected);
});

test('provides a deterministic call tree and timeline projection', async () => {
  const snapshot = await loadTraceSnapshot(parallelFixture);
  const tree = projectCallTree(snapshot);
  const timeline = projectTimeline(snapshot);

  assert.equal(tree.nodes.length, 7);
  assert.equal(tree.edges.length, 6);
  assert.equal(
    tree.edges.filter((edge) => edge.to === 'evt_00000000-0000-4000-8000-000000000026').length,
    1,
  );
  assert.deepEqual(
    timeline.nodes.map((node) => node.sequence),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(timeline.edges.length, 6);
  assert.ok(timeline.edges.every((edge) => edge.kind === 'timeline'));
});

test('filters projections by actor, type, status, and sequence range', async () => {
  const snapshot = await loadTraceSnapshot(parallelFixture);
  const graph = projectCausalDag(snapshot, {
    filter: {
      actor: 'read_file',
      status: 'completed',
      minSequence: 4,
      maxSequence: 5,
    },
  });

  assert.deepEqual(
    graph.nodes.map((node) => node.eventId),
    ['evt_00000000-0000-4000-8000-000000000024', 'evt_00000000-0000-4000-8000-000000000025'],
  );
  assert.equal(graph.edges.length, 0);
});

test('folds adjacent model stream events and preserves their source IDs', async () => {
  const snapshot = await loadTraceSnapshot(parallelFixture);
  const template = snapshot.events[0];
  assert.ok(template);
  const events = [1, 2, 3].map((sequence) => ({
    ...template,
    event_id: `evt_00000000-0000-4000-8000-0000000000${30 + sequence}`,
    parent_ids: sequence === 1 ? [] : [`evt_00000000-0000-4000-8000-0000000000${29 + sequence}`],
    sequence,
    type: 'model.delta',
  })) as unknown as EventEnvelope<string, unknown>[];
  const graph = projectCausalDag({ ...snapshot, events });

  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0]?.folded, true);
  assert.equal(graph.nodes[0]?.eventIds.length, 3);
  assert.equal(graph.nodes[0]?.sequenceEnd, 3);
  assert.equal(graph.nodes[0]?.label, 'model stream (3)');
  assert.equal(graph.edges.length, 0);
});
