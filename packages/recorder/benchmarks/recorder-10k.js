/* global console, process */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Recorder, SnapshotWriter } from '../dist/index.js';

const eventCount = Number(process.env.ALS_BENCHMARK_EVENT_COUNT ?? 10_000);
if (!Number.isSafeInteger(eventCount) || eventCount < 3) {
  throw new Error('ALS_BENCHMARK_EVENT_COUNT must be an integer of at least 3.');
}

const root = await mkdtemp(join(tmpdir(), 'alsnap-recorder-10k-'));
const writer = await SnapshotWriter.open(root, { flushMode: 'batch', batchSize: 100 });
const recorder = new Recorder({ interceptors: [writer.asInterceptor()] });

try {
  const started = performance.now();
  const run = await recorder.startRun({
    runtime: { name: 'recorder-benchmark', version: '0.1.0' },
  });
  for (let sequence = 2; sequence < eventCount; sequence += 1) {
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { path: `/benchmark/${String(sequence)}`, operation: 'set', value: sequence },
    });
  }
  await recorder.completeRun(run, { final_state_hash: '0'.repeat(64) });
  await writer.commit(recorder.getManifest(run));
  await writer.close();
  const elapsedMs = performance.now() - started;
  const eventsFile = await stat(join(root, 'events.jsonl'));
  const manifestFile = await stat(join(root, 'manifest.json'));

  console.log(
    JSON.stringify(
      {
        event_count: eventCount,
        record_ms: Math.round(elapsedMs * 100) / 100,
        events_per_second: Math.round((eventCount / elapsedMs) * 1000),
        snapshot_bytes: eventsFile.size + manifestFile.size,
        bytes_per_event:
          Math.round(((eventsFile.size + manifestFile.size) / eventCount) * 100) / 100,
        flush_mode: 'batch-100',
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      null,
      2,
    ),
  );
} finally {
  await writer.close();
  await rm(root, { recursive: true, force: true });
}
