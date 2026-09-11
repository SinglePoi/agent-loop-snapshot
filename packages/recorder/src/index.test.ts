import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidLifecycleTransitionError, Recorder, type RecorderClock } from './index.js';

const fixedClock: RecorderClock = {
  now: () => new Date('2026-09-06T03:00:00.000Z'),
  monotonicNow: () => 100,
};

function createRecorder(): Recorder {
  return new Recorder({ clock: fixedClock });
}

test('records lifecycle events, checkpoints, and rejects append after completion', async () => {
  const recorder = createRecorder();
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });

  const decision = await recorder.appendEvent(run.context(), {
    type: 'decision.recorded',
    payload: {
      decision: 'continue',
      basis_summary: 'Fixture is complete.',
      success_conditions: ['state is recorded'],
    },
  });
  const checkpoint = await recorder.checkpoint(run, {
    state: { answer: 'ok' },
    stateHash: 'a'.repeat(64),
  });
  const completed = await recorder.completeRun(run, {
    final_state_hash: 'b'.repeat(64),
    output: { answer: 'ok' },
  });

  assert.equal(decision.sequence, 2);
  assert.deepEqual(decision.parent_ids, [run.startedEvent.event_id]);
  assert.equal(checkpoint.last_event_id, decision.event_id);
  assert.equal(completed.sequence, 4);
  assert.deepEqual(completed.parent_ids, [recorder.getEvents(run)[2]!.event_id]);
  assert.equal(run.status, 'completed');
  assert.equal(recorder.getManifest(run).terminal_status, 'completed');

  await assert.rejects(
    recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { path: '/answer', operation: 'set', value: 'late' },
    }),
    (error: unknown) => error instanceof InvalidLifecycleTransitionError,
  );
});

test('serializes concurrent branches and preserves shared parent context', async () => {
  const recorder = createRecorder();
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });
  const branchContext = run.context();

  const [left, right] = await Promise.all([
    recorder.appendEvent(branchContext, {
      type: 'tool.completed',
      payload: { correlation_key: 'left', output: { value: 'L' } },
    }),
    recorder.appendEvent(branchContext, {
      type: 'tool.completed',
      payload: { correlation_key: 'right', output: { value: 'R' } },
    }),
  ]);
  const merged = await recorder.appendEvent(run.context([left.event_id, right.event_id]), {
    type: 'state.changed',
    payload: {
      path: '/merged',
      operation: 'merge',
      value: { left: 'L', right: 'R' },
    },
  });

  const events = recorder.getEvents(run);
  assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(left.parent_ids, [run.startedEvent.event_id]);
  assert.deepEqual(right.parent_ids, [run.startedEvent.event_id]);
  assert.deepEqual(merged.parent_ids, [left.event_id, right.event_id]);
});

test('survives concurrent pressure and preserves call-arrival order for out-of-order completions', async () => {
  const recorder = createRecorder();
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });
  const branchContext = run.context();
  const eventCount = 500;

  const events = await Promise.all(
    Array.from({ length: eventCount }, (_, index) =>
      recorder.appendEvent(branchContext, {
        type: 'tool.completed',
        payload: { correlation_key: `stress-${String(index)}`, output: { index } },
      }),
    ),
  );
  const delayed = (async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    return recorder.appendEvent(branchContext, {
      type: 'tool.completed',
      payload: { correlation_key: 'slow-arrival', output: { order: 'slow' } },
    });
  })();
  const immediate = recorder.appendEvent(branchContext, {
    type: 'tool.completed',
    payload: { correlation_key: 'fast-arrival', output: { order: 'fast' } },
  });
  const [slow, fast] = await Promise.all([delayed, immediate]);

  const recorded = recorder.getEvents(run);
  assert.equal(recorded.length, eventCount + 3);
  assert.equal(new Set(recorded.map((event) => event.event_id)).size, recorded.length);
  assert.deepEqual(
    recorded.map((event) => event.sequence),
    Array.from({ length: eventCount + 3 }, (_, index) => index + 1),
  );
  assert.ok(events.every((event) => event.parent_ids[0] === run.startedEvent.event_id));
  assert.equal(fast.sequence, eventCount + 2);
  assert.equal(slow.sequence, eventCount + 3);
});

test('records a failed terminal state and rejects later completion', async () => {
  const recorder = createRecorder();
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });

  const failed = await recorder.failRun(run, {
    code: 'FIXTURE_FAILURE',
    message: 'The fixture intentionally failed.',
    retryable: false,
    kind: 'runtime',
  });

  assert.equal(failed.type, 'run.failed');
  assert.equal(run.status, 'failed');
  assert.equal(recorder.getManifest(run).terminal_status, 'failed');
  await assert.rejects(
    recorder.completeRun(run, { final_state_hash: 'c'.repeat(64) }),
    (error: unknown) => error instanceof InvalidLifecycleTransitionError,
  );
});

test('finishes an SDK observation without inventing a final state hash', async () => {
  const recorder = createRecorder();
  const run = await recorder.startRun({
    runtime: { name: 'test-sdk', version: '1.0.0' },
    source: 'sdk',
    completeness: 'partial',
    limitations: [
      { code: 'final_state_unavailable', message: 'The SDK does not expose application state.' },
    ],
  });

  await recorder.observeRun(run, { outcome: 'completed' });

  const manifest = recorder.getManifest(run);
  assert.equal(run.status, 'observed');
  assert.equal(manifest.terminal_status, 'unknown');
  assert.equal(manifest.source, 'sdk');
  assert.equal(manifest.completeness, 'partial');
  assert.deepEqual(manifest.limitations, [
    { code: 'final_state_unavailable', message: 'The SDK does not expose application state.' },
  ]);
});

test('interceptors can transform payloads without mutating event identity', async () => {
  const afterTypes: string[] = [];
  const recorder = new Recorder({
    clock: fixedClock,
    interceptors: [
      {
        beforeAppend(event) {
          return {
            ...event,
            payload: {
              ...(event.payload as Record<string, unknown>),
              intercepted: true,
            },
          } as typeof event;
        },
        afterAppend(event) {
          afterTypes.push(event.type);
        },
      },
    ],
  });
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });
  const event = await recorder.appendEvent(run.context(), {
    type: 'decision.recorded',
    payload: {
      decision: 'continue',
      basis_summary: 'test',
      success_conditions: ['test'],
    },
  });

  assert.equal((event.payload as Record<string, unknown>).intercepted, true);
  assert.deepEqual(afterTypes, ['run.started', 'decision.recorded']);
  assert.equal(event.sequence, 2);
});
