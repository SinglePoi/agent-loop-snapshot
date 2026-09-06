/* global console, process */

import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadTraceSnapshot } from '../dist/index.js';

const eventCount = Number(process.env.ALS_BENCHMARK_EVENT_COUNT ?? 100_000);
const runId = 'run_00000000-0000-4000-8000-000000000100';
const root = await mkdtemp(join(tmpdir(), 'alsnap-trace-loader-100k-'));

function eventId(sequence) {
  return `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function eventFor(sequence) {
  const event_id = eventId(sequence);
  const parent_ids = sequence === 1 ? [] : [eventId(sequence - 1)];
  const base = {
    schema_version: '0.1.0',
    run_id: runId,
    event_id,
    parent_ids,
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
    monotonic_offset_ms: sequence,
    actor: 'benchmark.loader',
    security: { side_effect: 'read_only', redactions: [] },
  };
  if (sequence === 1) {
    return {
      ...base,
      type: 'run.started',
      payload: { runtime: { name: 'trace-loader-benchmark', version: '0.1.0' } },
    };
  }
  if (sequence === eventCount) {
    return {
      ...base,
      type: 'run.completed',
      payload: { final_state_hash: '0'.repeat(64) },
    };
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
    runtime: { name: 'trace-loader-benchmark', version: '0.1.0' },
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

  const before = process.memoryUsage();
  const started = performance.now();
  const snapshot = await loadTraceSnapshot(root);
  const elapsedMs = performance.now() - started;
  const after = process.memoryUsage();
  if (!snapshot.valid || snapshot.events.length !== eventCount) {
    throw new Error(`Benchmark fixture did not load as a valid ${eventCount}-event snapshot.`);
  }

  console.log(
    JSON.stringify(
      {
        event_count: snapshot.events.length,
        load_ms: Math.round(elapsedMs * 100) / 100,
        events_per_second: Math.round((eventCount / elapsedMs) * 1000),
        rss_delta_mb: Math.round(((after.rss - before.rss) / 1024 / 1024) * 100) / 100,
        heap_delta_mb: Math.round(((after.heapUsed - before.heapUsed) / 1024 / 1024) * 100) / 100,
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
