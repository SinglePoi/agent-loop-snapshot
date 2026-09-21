/* global console, fetch, process, URL */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { startViewer } from '../dist/index.js';

const eventCount = Number(process.env.ALS_BENCHMARK_EVENT_COUNT ?? 100_000);
const runId = 'run_00000000-0000-4000-8000-000000000300';
const root = await mkdtemp(join(tmpdir(), 'alsnap-viewer-100k-'));

function eventId(sequence) {
  return `evt_00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function event(sequence) {
  const base = {
    schema_version: '0.1.0',
    run_id: runId,
    event_id: eventId(sequence),
    parent_ids: sequence === 1 ? [] : [eventId(sequence - 1)],
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
    monotonic_offset_ms: sequence,
    actor: 'benchmark.viewer',
    security: { side_effect: 'read_only', redactions: [] },
  };
  if (sequence === 1)
    return {
      ...base,
      type: 'run.started',
      payload: { runtime: { name: 'viewer-benchmark', version: '1.0.0' } },
    };
  if (sequence === eventCount)
    return { ...base, type: 'run.completed', payload: { final_state_hash: '0'.repeat(64) } };
  return {
    ...base,
    type: 'state.changed',
    payload: { path: `/benchmark/${String(sequence)}`, operation: 'set', value: sequence },
  };
}

try {
  await writeFile(
    join(root, 'manifest.json'),
    `${JSON.stringify({
      schema_version: '0.1.0',
      snapshot_type: 'run-snapshot',
      run_id: runId,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:40.000Z',
      run_state: 'finished',
      terminal_status: 'completed',
      runtime: { name: 'viewer-benchmark', version: '1.0.0' },
      last_sequence: eventCount,
      event_count: eventCount,
      root_event_id: eventId(1),
      completed_at: '2026-01-01T00:01:40.000Z',
    })}\n`,
  );
  await writeFile(
    join(root, 'events.jsonl'),
    `${Array.from({ length: eventCount }, (_, index) => JSON.stringify(event(index + 1))).join('\n')}\n`,
  );
  const before = process.memoryUsage();
  const started = performance.now();
  const viewer = await startViewer({ snapshotDirectory: root });
  const readyMs = performance.now() - started;
  try {
    const apiUrl = (path) => {
      const url = new URL(viewer.url);
      url.pathname = path;
      url.searchParams.set('limit', '100');
      return url.toString();
    };
    const pageStarted = performance.now();
    const page = await fetch(apiUrl('/api/events')).then((response) => response.json());
    const pageMs = performance.now() - pageStarted;
    const graphStarted = performance.now();
    const graph = await fetch(apiUrl('/api/graph')).then((response) => response.json());
    const graphMs = performance.now() - graphStarted;
    const after = process.memoryUsage();
    if (page.total !== eventCount || page.events.length !== 100 || graph.nodes.length !== 100) {
      throw new Error('Viewer pagination did not return the expected bounded 100k-event pages.');
    }
    console.log(
      JSON.stringify(
        {
          event_count: eventCount,
          startup_ms: Math.round(readyMs * 100) / 100,
          first_timeline_page_ms: Math.round(pageMs * 100) / 100,
          first_graph_page_ms: Math.round(graphMs * 100) / 100,
          rss_delta_mb: Math.round(((after.rss - before.rss) / 1024 / 1024) * 100) / 100,
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
        },
        null,
        2,
      ),
    );
  } finally {
    await viewer.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
