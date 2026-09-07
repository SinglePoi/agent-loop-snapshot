import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { Checkpoint, EventEnvelope, EventId, RunId } from '@agent-loop-snapshot/schema';

import { Recorder, StateReconstructionError, hashState, reconstructState } from './index.js';
import { CheckpointStore } from './checkpoints.js';
import { SnapshotWriter, scanJsonlFile } from './writer.js';

const fixedRunId = 'run_00000000-0000-4000-8000-000000000201' as RunId;
const fixedEventIds = [
  'evt_00000000-0000-4000-8000-000000000201',
  'evt_00000000-0000-4000-8000-000000000202',
  'evt_00000000-0000-4000-8000-000000000203',
  'evt_00000000-0000-4000-8000-000000000204',
] as EventId[];
const execFileAsync = promisify(execFile);

function event(
  sequence: number,
  eventId: EventId,
  type: string,
  payload: unknown,
): EventEnvelope<string, unknown> {
  return {
    schema_version: '0.1.0',
    run_id: fixedRunId,
    event_id: eventId,
    parent_ids:
      sequence === 1 ? [] : [fixedEventIds[Math.min(sequence - 2, fixedEventIds.length - 1)]!],
    sequence,
    type,
    timestamp: `2026-09-06T05:00:0${sequence}.000Z`,
    monotonic_offset_ms: sequence * 100,
    actor: 'agent.main',
    payload,
    security: { side_effect: 'read_only', redactions: [] },
  };
}

function fixtureEvents(): EventEnvelope<string, unknown>[] {
  return [
    event(1, fixedEventIds[0]!, 'run.started', {
      runtime: { name: 'fixture-runtime', version: '0.1.0' },
    }),
    event(2, fixedEventIds[1]!, 'state.changed', {
      path: '/answer',
      operation: 'set',
      value: 'draft',
    }),
    event(3, fixedEventIds[2]!, 'checkpoint.created', {
      checkpoint_id: 'cp_00000000-0000-4000-8000-000000000201',
      last_event_id: fixedEventIds[1],
      sequence: 2,
      state_hash: hashState({ answer: 'draft' }),
    }),
    event(4, fixedEventIds[3]!, 'state.changed', {
      path: '/answer',
      operation: 'set',
      value: 'final',
    }),
  ];
}

function fixtureCheckpoint(): Checkpoint {
  return {
    schema_version: '0.1.0',
    checkpoint_id: 'cp_00000000-0000-4000-8000-000000000201',
    run_id: fixedRunId,
    created_at: '2026-09-06T05:00:02.000Z',
    last_event_id: fixedEventIds[1]!,
    sequence: 2,
    state_hash: hashState({ answer: 'draft' }),
    state: { answer: 'draft' },
  };
}

test('rebuilds the same state from the full event stream and from a checkpoint', async () => {
  const events = fixtureEvents();
  const checkpoint = fixtureCheckpoint();

  const fromEvents = await reconstructState(events);
  const fromCheckpoint = await reconstructState(events, { checkpoints: [checkpoint] });

  assert.deepEqual(fromEvents.state, { answer: 'final' });
  assert.equal(fromEvents.stateHash, hashState(fromEvents.state));
  assert.deepEqual(fromCheckpoint.state, fromEvents.state);
  assert.equal(fromCheckpoint.stateHash, fromEvents.stateHash);
  assert.equal(fromCheckpoint.usedCheckpoint, true);
  assert.equal(fromCheckpoint.checkpointId, checkpoint.checkpoint_id);
});

test('applies set, merge, append, and delete state changes while ignoring observational events', async () => {
  const events = [
    event(1, fixedEventIds[0]!, 'run.started', {
      runtime: { name: 'fixture-runtime', version: '0.1.0' },
    }),
    event(2, fixedEventIds[1]!, 'state.changed', {
      path: '/profile',
      operation: 'set',
      value: { name: 'Ada' },
    }),
    event(3, fixedEventIds[2]!, 'state.changed', {
      path: '/profile',
      operation: 'merge',
      value: { role: 'engineer' },
    }),
    event(4, fixedEventIds[3]!, 'state.changed', {
      path: '/items',
      operation: 'set',
      value: [],
    }),
    event(5, 'evt_00000000-0000-4000-8000-000000000205' as EventId, 'state.changed', {
      path: '/items',
      operation: 'append',
      value: 'one',
    }),
    event(6, 'evt_00000000-0000-4000-8000-000000000206' as EventId, 'state.changed', {
      path: '/profile/name',
      operation: 'delete',
    }),
    event(7, 'evt_00000000-0000-4000-8000-000000000207' as EventId, 'decision.recorded', {
      decision: 'continue',
    }),
  ];

  const result = await reconstructState(events);

  assert.deepEqual(result.state, {
    profile: { role: 'engineer' },
    items: ['one'],
  });
});

test('rejects prototype-polluting paths without contaminating the test process', async () => {
  const moduleUrl = new URL('./index.js', import.meta.url).href;
  const script = `
    import { reconstructState } from ${JSON.stringify(moduleUrl)};

    const events = [{
      schema_version: '0.1.0',
      run_id: 'run_00000000-0000-4000-8000-000000000299',
      event_id: 'evt_00000000-0000-4000-8000-000000000299',
      parent_ids: [],
      sequence: 1,
      type: 'state.changed',
      timestamp: '2026-09-06T05:00:00.000Z',
      monotonic_offset_ms: 0,
      actor: 'agent.main',
      payload: {
        operation: 'set',
        path: '/__proto__/als_review_probe',
        value: 'polluted',
      },
      security: { side_effect: 'read_only', redactions: [] },
    }];

    let errorCode;
    try {
      await reconstructState(events);
    } catch (error) {
      errorCode = error instanceof Error && 'code' in error ? error.code : undefined;
    }
    console.log(JSON.stringify({
      errorCode,
      prototypePolluted: ({}).als_review_probe === 'polluted',
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    script,
  ]);

  assert.deepEqual(JSON.parse(stdout), {
    errorCode: 'STATE_EVENT_INVALID',
    prototypePolluted: false,
  });
});

test('rejects dangerous keys for every state mutation operation', async () => {
  const cases = [
    { operation: 'set', path: '/__proto__', value: {} },
    { operation: 'merge', path: '/constructor', value: {} },
    { operation: 'delete', path: '/prototype' },
    { operation: 'append', path: '/profile/prototype', value: 'unsafe' },
  ] as const;

  for (const payload of cases) {
    await assert.rejects(
      reconstructState([
        event(1, fixedEventIds[0]!, 'run.started', {}),
        event(2, fixedEventIds[1]!, 'state.changed', payload),
      ]),
      (error: unknown) =>
        error instanceof StateReconstructionError && error.code === 'STATE_EVENT_INVALID',
    );
  }
});

test('rejects dangerous keys nested in set, merge, and append values', async () => {
  const dangerousValues = ['__proto__', 'constructor', 'prototype'].map((key) =>
    JSON.parse(`{"nested":{${JSON.stringify(key)}:{"polluted":true}}}`),
  );
  const cases = dangerousValues.flatMap((value) => [
    { operation: 'set', path: '/value', value },
    { operation: 'merge', path: '/value', value },
    { operation: 'append', path: '/items', value: [value] },
  ]);

  for (const payload of cases) {
    await assert.rejects(
      reconstructState([
        event(1, fixedEventIds[0]!, 'run.started', {}),
        event(2, fixedEventIds[1]!, 'state.changed', payload),
      ]),
      (error: unknown) =>
        error instanceof StateReconstructionError && error.code === 'STATE_VALUE_INVALID',
    );
  }
});

test('preserves valid nested objects, arrays, and escaped JSON Pointer keys', async () => {
  const result = await reconstructState([
    event(1, fixedEventIds[0]!, 'run.started', {}),
    event(2, fixedEventIds[1]!, 'state.changed', {
      operation: 'set',
      path: '/settings',
      value: { 'slash/key': { '~key': [] } },
    }),
    event(3, fixedEventIds[2]!, 'state.changed', {
      operation: 'append',
      path: '/settings/slash~1key/~0key',
      value: { name: 'Ada' },
    }),
    event(4, fixedEventIds[3]!, 'state.changed', {
      operation: 'set',
      path: '/settings/slash~1key/~0key/0/name',
      value: 'Grace',
    }),
    event(5, 'evt_00000000-0000-4000-8000-000000000205' as EventId, 'state.changed', {
      operation: 'merge',
      path: '/settings/slash~1key',
      value: { role: 'engineer' },
    }),
    event(6, 'evt_00000000-0000-4000-8000-000000000206' as EventId, 'state.changed', {
      operation: 'delete',
      path: '/settings/slash~1key/role',
    }),
  ]);

  assert.deepEqual(result.state, {
    settings: { 'slash/key': { '~key': [{ name: 'Grace' }] } },
  });
});

test('persists checkpoints through SnapshotWriter and uses the latest valid checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-checkpoints-'));
  const writer = await SnapshotWriter.open(root, { flushMode: 'event' });
  const recorder = new Recorder({
    interceptors: [writer.asInterceptor()],
  });

  try {
    const run = await recorder.startRun({
      runtime: { name: 'test-runtime', version: '0.1.0' },
    });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { path: '/answer', operation: 'set', value: 'draft' },
    });
    await recorder.checkpoint(run, {
      state: { answer: 'draft' },
      stateHash: hashState({ answer: 'draft' }),
    });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { path: '/answer', operation: 'set', value: 'final' },
    });
    await recorder.completeRun(run, { final_state_hash: hashState({ answer: 'final' }) });
    await writer.commit(recorder.getManifest(run));
    await writer.close();

    const checkpointFile = join(root, 'checkpoints', '000002.json');
    assert.deepEqual(
      JSON.parse(await readFile(checkpointFile, 'utf8')),
      recorder.getCheckpoints(run)[0],
    );

    const eventScan = await scanJsonlFile(join(root, 'events.jsonl'));
    const store = await CheckpointStore.open(join(root, 'checkpoints'));
    const result = await reconstructState(eventScan.events as EventEnvelope<string, unknown>[], {
      checkpointStore: store,
    });
    await store.close();

    assert.deepEqual(result.state, { answer: 'final' });
    assert.equal(result.usedCheckpoint, true);
    assert.equal(result.stateHash, hashState({ answer: 'final' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falls back to event reconstruction when a checkpoint is missing or damaged', async () => {
  const events = fixtureEvents();
  const root = await mkdtemp(join(tmpdir(), 'alsnap-checkpoint-fallback-'));

  try {
    const store = await CheckpointStore.open(root);
    const missing = await reconstructState(events, { checkpointStore: store });
    assert.deepEqual(missing.state, { answer: 'final' });
    assert.equal(missing.usedCheckpoint, false);

    await writeFile(join(root, '000002.json'), '{"schema_version":');
    const damaged = await reconstructState(events, { checkpointStore: store });
    await store.close();

    assert.deepEqual(damaged.state, { answer: 'final' });
    assert.equal(damaged.usedCheckpoint, false);
    assert.ok(
      damaged.diagnostics.some((diagnostic) => diagnostic.code === 'CHECKPOINT_FILE_INVALID_JSON'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips a checkpoint whose state hash is corrupt and uses the event stream', async () => {
  const corrupt = fixtureCheckpoint();
  corrupt.state_hash = 'f'.repeat(64);

  const result = await reconstructState(fixtureEvents(), { checkpoints: [corrupt] });

  assert.deepEqual(result.state, { answer: 'final' });
  assert.equal(result.usedCheckpoint, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'CHECKPOINT_STATE_HASH_MISMATCH'),
  );
});
