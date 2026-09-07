/* global console, process */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { projectCausalDag } from '../dist/index.js';
import { loadTraceSnapshot } from '../../trace/dist/index.js';

const eventCount = Number(process.env.ALS_BENCHMARK_EVENT_COUNT ?? 100_000);
if (!Number.isSafeInteger(eventCount) || eventCount < 3) {
  throw new Error('ALS_BENCHMARK_EVENT_COUNT must be an integer of at least 3.');
}

const runId = 'run_00000000-0000-4000-8000-000000000200';
const root = await mkdtemp(join(tmpdir(), 'alsnap-graph-project-100k-'));

function eventId(sequence) {
  return `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function eventFor(sequence) {
  const base = {
    schema_version: '0.1.0',
    run_id: runId,
    event_id: eventId(sequence),
    parent_ids: sequence === 1 ? [] : [eventId(sequence - 1)],
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
    monotonic_offset_ms: sequence,
    actor: 'benchmark.graph',
    security: { side_effect: 'read_only', redactions: [] },
  };
  if (sequence === 1) {
    return {
      ...base,
      type: 'run.started',
      payload: { runtime: { name: 'graph-benchmark', version: '0.1.0' } },
    };
  }
  if (sequence === eventCount) {
    return { ...base, type: 'run.completed', payload: { final_state_hash: '0'.repeat(64) } };
  }
  return {
    ...base,
    type: 'state.changed',
    payload: { path: `/benchmark/${String(sequence)}`, operation: 'set', value: sequence },
  };
}

try {
  const manifest = {
    schema_version: '0.1.0',
    snapshot_type: 'run-snapshot',
    run_id: runId,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:40.000Z',
    run_state: 'finished',
    terminal_status: 'completed',
    runtime: { name: 'graph-benchmark', version: '0.1.0' },
    last_sequence: eventCount,
    event_count: eventCount,
    root_event_id: eventId(1),
    completed_at: '2026-01-01T00:01:40.000Z',
  };
  const events = Array.from({ length: eventCount }, (_, index) =>
    JSON.stringify(eventFor(index + 1)),
  ).join('\n');
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(root, 'events.jsonl'), `${events}\n`);

  const snapshot = await loadTraceSnapshot(root);
  if (!snapshot.valid || snapshot.events.length !== eventCount) {
    throw new Error(`Benchmark fixture did not load as a valid ${eventCount}-event snapshot.`);
  }
  const started = performance.now();
  const graph = projectCausalDag(snapshot);
  const elapsedMs = performance.now() - started;
  if (graph.nodes.length !== eventCount || graph.edges.length !== eventCount - 1) {
    throw new Error('Graph projection did not preserve every benchmark event and causal edge.');
  }

  console.log(
    JSON.stringify(
      {
        event_count: eventCount,
        project_ms: Math.round(elapsedMs * 100) / 100,
        events_per_second: Math.round((eventCount / elapsedMs) * 1000),
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
