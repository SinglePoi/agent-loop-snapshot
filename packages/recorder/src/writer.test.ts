import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { EventEnvelope, EventId, RunId, SnapshotManifest } from '@agent-loop-snapshot/schema';

import { Recorder } from './index.js';
import {
  JsonlEventWriter,
  SnapshotWriter,
  inspectSnapshotDirectory,
  scanJsonlFile,
} from './writer.js';

const runId = 'run_00000000-0000-4000-8000-000000000101' as RunId;

function event(
  sequence: number,
  suffix: string,
  parentIds: EventId[] = [],
): EventEnvelope<string, unknown> {
  return {
    schema_version: '0.1.0',
    run_id: runId,
    event_id: `evt_00000000-0000-4000-8000-0000000001${suffix}` as EventId,
    parent_ids: parentIds,
    sequence,
    type: sequence === 1 ? 'run.started' : 'state.changed',
    timestamp: '2026-09-06T04:00:00.000Z',
    monotonic_offset_ms: sequence * 10,
    actor: 'test',
    payload: sequence === 1 ? { runtime: { name: 'test', version: '0.1.0' } } : {},
    security: { side_effect: 'read_only', redactions: [] },
  };
}

function manifest(runState: SnapshotManifest['run_state'], eventCount: number): SnapshotManifest {
  return {
    schema_version: '0.1.0',
    snapshot_type: 'run-snapshot',
    run_id: runId,
    created_at: '2026-09-06T04:00:00.000Z',
    updated_at: '2026-09-06T04:00:01.000Z',
    run_state: runState,
    terminal_status: runState === 'finished' ? 'completed' : null,
    runtime: { name: 'test-runtime', version: '0.1.0' },
    last_sequence: eventCount,
    event_count: eventCount,
    ...(runState === 'finished'
      ? {
          completed_at: '2026-09-06T04:00:01.000Z',
          root_event_id: event(1, '01').event_id,
        }
      : {}),
  };
}

test('keeps complete JSONL events readable when the tail is partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-jsonl-'));
  const filePath = join(root, 'events.jsonl');
  const first = event(1, '01');

  try {
    await writeFile(filePath, `${JSON.stringify(first)}\n{"schema_version":"0.1.0","partial":`);
    const before = await scanJsonlFile(filePath);
    assert.equal(before.events.length, 1);
    assert.equal(before.tailCorrupt, true);
    assert.equal(before.diagnostics[0]?.code, 'PARTIAL_JSONL_TAIL');

    const writer = await JsonlEventWriter.open(filePath, { flushMode: 'event' });
    await writer.append(event(2, '02', [first.event_id]));
    await writer.close();

    const after = await scanJsonlFile(filePath);
    assert.equal(after.events.length, 2);
    assert.equal(after.diagnostics[0]?.code, 'INVALID_JSONL_LINE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses a temporary manifest and atomically commits a terminal manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-manifest-'));
  const writer = await SnapshotWriter.open(root, { flushMode: 'event' });

  try {
    await writer.writeManifest(manifest('running', 0));
    const unfinished = await inspectSnapshotDirectory(root);
    assert.equal(unfinished.unfinished, true);
    assert.equal(unfinished.manifestSource, 'temporary');
    assert.ok(unfinished.diagnostics.some((diagnostic) => diagnostic.code === 'UNFINISHED_RUN'));

    await writer.commit(manifest('finished', 0));
    const committed = await inspectSnapshotDirectory(root);
    assert.equal(committed.unfinished, false);
    assert.equal(committed.manifestSource, 'final');
    assert.deepEqual(committed.manifest, manifest('finished', 0));
    await assert.rejects(readFile(join(root, 'manifest.json.tmp')));
  } finally {
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects non-increasing sequence numbers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-sequence-'));
  const writer = await JsonlEventWriter.open(join(root, 'events.jsonl'));

  try {
    await writer.append(event(1, '01'));
    await assert.rejects(
      writer.append(event(1, '02')),
      (error: unknown) => error instanceof Error && error.message.includes('must be greater'),
    );
  } finally {
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('can persist Recorder events through an interceptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-recorder-'));
  const writer = await SnapshotWriter.open(root, { flushMode: 'event' });
  const recorder = new Recorder({ interceptors: [writer.asInterceptor()] });

  try {
    const run = await recorder.startRun({
      runtime: { name: 'test-runtime', version: '0.1.0' },
    });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { path: '/ready', operation: 'set', value: true },
    });
    await recorder.completeRun(run, { final_state_hash: 'd'.repeat(64) });
    await writer.commit(recorder.getManifest(run));
    await writer.close();

    const inspection = await inspectSnapshotDirectory(root);
    assert.equal(inspection.unfinished, false);
    assert.equal(inspection.events.events.length, 3);
    assert.equal(inspection.events.diagnostics.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
