import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ArtifactReference,
  Checkpoint,
  EventEnvelope,
  JsonValue,
  RunId,
} from '@agent-loop-snapshot/schema';

import { Recorder, hashState, reconstructState } from './index.js';
import { CheckpointStore } from './checkpoints.js';
import {
  RedactionPipeline,
  RedactionError,
  createDefaultRedactionPipeline,
  type FieldRedactionRule,
  type RedactionPipelineOptions,
} from './redaction.js';
import { SnapshotWriter, scanJsonlFile } from './writer.js';

const runId = 'run_00000000-0000-4000-8000-000000000301' as RunId;

function event(payload: unknown): EventEnvelope<string, unknown> {
  return {
    schema_version: '0.1.0',
    run_id: runId,
    event_id: 'evt_00000000-0000-4000-8000-000000000301',
    parent_ids: [],
    sequence: 1,
    type: 'tool.requested',
    timestamp: '2026-09-06T06:00:00.000Z',
    monotonic_offset_ms: 0,
    actor: 'agent.main',
    payload,
    security: { side_effect: 'read_only', redactions: [] },
  };
}

const fieldRules: readonly FieldRedactionRule[] = [
  { path: '/credentials/apiKey', category: 'api_key', strategy: 'reference' },
  { path: '/users/*/token', category: 'session_token', strategy: 'mask' },
];

test('redacts nested objects and arrays with field paths and records only metadata', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules,
    customRedactors: [
      {
        path: '/profile/email',
        category: 'personal_data',
        redact: () => ({ action: 'replace', value: '[email removed]' }),
      },
    ],
  });
  const secret = 'api-secret-value';
  const eventResult = await pipeline.redactEvent(
    event({
      credentials: { apiKey: secret },
      users: [{ token: 'token-one' }, { token: 'token-two' }],
      profile: { email: 'ada@example.com' },
    }),
  );

  const serialized = JSON.stringify(eventResult);
  assert.equal(serialized.includes(secret), false);
  const payload = eventResult.payload as {
    credentials: { apiKey: string };
    users: Array<{ token: string }>;
    profile: { email: string };
  };
  assert.match(payload.credentials.apiKey, /^\[REDACTED:api_key:ref_[^\]]+\]$/);
  assert.deepEqual(payload.users, [
    { token: '[REDACTED:session_token]' },
    { token: '[REDACTED:session_token]' },
  ]);
  assert.equal(payload.profile.email, '[email removed]');
  assert.deepEqual(
    eventResult.security.redactions.map(({ category, path, strategy }) => ({
      category,
      path,
      strategy,
    })),
    [
      { category: 'api_key', path: '/payload/credentials/apiKey', strategy: 'reference' },
      { category: 'session_token', path: '/payload/users/1/token', strategy: 'mask' },
      { category: 'session_token', path: '/payload/users/0/token', strategy: 'mask' },
      { category: 'personal_data', path: '/payload/profile/email', strategy: 'custom' },
    ],
  );
});

test('preserves lifecycle protocol controls while redacting error data', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/state_hash', category: 'private', strategy: 'mask' },
      { path: '/sequence', category: 'private', strategy: 'mask' },
      { path: '/checkpoint_id', category: 'private', strategy: 'mask' },
      { path: '/last_event_id', category: 'private', strategy: 'mask' },
      { path: '/final_state_hash', category: 'private', strategy: 'mask' },
      { path: '/error/message', category: 'private', strategy: 'mask' },
    ],
  });
  const checkpoint = await pipeline.redactEvent({
    ...event({
      checkpoint_id: 'cp_00000000-0000-4000-8000-000000000301',
      last_event_id: 'evt_00000000-0000-4000-8000-000000000301',
      sequence: 7,
      state_hash: 'a'.repeat(64),
    }),
    type: 'checkpoint.created',
  });
  assert.deepEqual(checkpoint.payload, {
    checkpoint_id: 'cp_00000000-0000-4000-8000-000000000301',
    last_event_id: 'evt_00000000-0000-4000-8000-000000000301',
    sequence: 7,
    state_hash: 'a'.repeat(64),
  });
  assert.deepEqual(checkpoint.security.redactions, []);

  const failed = await pipeline.redactEvent({
    ...event({
      error: { code: 'TEST_ERROR', message: 'review-only-secret', retryable: false },
    }),
    type: 'run.failed',
  });
  assert.deepEqual(failed.payload, {
    error: { code: 'TEST_ERROR', message: '[REDACTED:private]', retryable: false },
  });
  await assert.rejects(
    new RedactionPipeline({
      fieldRules: [{ path: '/error', category: 'private', strategy: 'remove' }],
    }).redactEvent({ ...failed, type: 'run.failed' }),
    (error: unknown) =>
      error instanceof RedactionError && error.code === 'PROTOCOL_REDACTION_UNREPRESENTABLE',
  );
});

test('uses canonical reference identities and records structural array redactions accurately', async () => {
  const referencePipeline = new RedactionPipeline({
    fieldRules: [{ path: '/profile', category: 'private', strategy: 'reference' }],
  });
  const eventResult = await referencePipeline.redactEvent({
    ...event({ operation: 'set', path: '/profile', value: { a: 'review-only-secret', b: 2 } }),
    type: 'state.changed',
  });
  const checkpoint = await referencePipeline.redactCheckpoint({
    schema_version: '0.1.0',
    checkpoint_id: 'cp_00000000-0000-4000-8000-000000000301',
    run_id: runId,
    created_at: '2026-09-06T06:00:00.000Z',
    last_event_id: 'evt_00000000-0000-4000-8000-000000000301',
    sequence: 1,
    state_hash: hashState({ profile: { b: 2, a: 'review-only-secret' } }),
    state: { profile: { b: 2, a: 'review-only-secret' } },
  });
  assert.equal(
    (eventResult.payload as { value: string }).value,
    (checkpoint.state as { profile: string }).profile,
  );

  const removePipeline = new RedactionPipeline({
    fieldRules: [{ path: '/items/0', category: 'private', strategy: 'remove' }],
    customRedactors: [
      {
        path: '/custom/0',
        category: 'private',
        redact: () => ({ action: 'remove' }),
      },
    ],
  });
  const removed = await removePipeline.redactEvent({
    ...event({ operation: 'set', path: '/items', value: ['secret', 'public'] }),
    type: 'state.changed',
  });
  const customRemoved = await removePipeline.redactEvent({
    ...event({ operation: 'set', path: '/custom', value: ['secret', 'public'] }),
    type: 'state.changed',
  });
  assert.deepEqual((removed.payload as { value: unknown }).value, ['public']);
  assert.ok(removed.security.redactions.some((entry) => entry.path === '/items/0'));
  assert.ok(customRemoved.security.redactions.some((entry) => entry.path === '/custom/0'));

  const appendPipeline = new RedactionPipeline({
    fieldRules: [{ path: '/items/*/password', category: 'private', strategy: 'mask' }],
  });
  for (const payload of [
    { operation: 'append', path: '/items', value: { password: 'review-only-secret' } },
    { operation: 'set', path: '/items/-', value: { password: 'review-only-secret' } },
  ]) {
    const appended = await appendPipeline.redactEvent({ ...event(payload), type: 'state.changed' });
    assert.ok(appended.security.redactions.some((entry) => entry.path === '/items/-/password'));
    assert.equal(JSON.stringify(appended).includes('review-only-secret'), false);
  }
});

test('redacts API keys, authorization headers, and exception stacks with default rules', async () => {
  const pipeline = createDefaultRedactionPipeline();
  const apiKey = 'sk-abcdefghijklmnop';
  const redacted = await pipeline.redactEvent(
    event({
      headers: { authorization: 'Bearer authorization-secret' },
      message: `request failed with ${apiKey}`,
      error: new Error(`tool failed with ${apiKey}`),
    }),
  );

  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes('authorization-secret'), false);
  assert.ok(redacted.security.redactions.some((entry) => entry.category === 'authorization'));
  assert.ok(redacted.security.redactions.some((entry) => entry.category === 'api_key'));
  assert.ok(redacted.security.redactions.some((entry) => entry.path.endsWith('/stack')));
});

test('redacts JSON and text artifacts before they are persisted', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules: [{ path: '/password', category: 'password', strategy: 'reference' }],
    regexRules: [{ pattern: /secret-[A-Za-z0-9-]+/g, category: 'secret', strategy: 'mask' }],
  });
  const secret = 'secret-artifact-value';

  const jsonArtifact = await pipeline.redactArtifact(
    JSON.stringify({ password: 'password-value', note: secret }),
    { mediaType: 'application/json', preview: secret },
  );
  const textArtifact = await pipeline.redactArtifact(`payload=${secret}`, {
    mediaType: 'text/plain',
  });

  assert.equal(String(jsonArtifact.content).includes('password-value'), false);
  assert.equal(String(jsonArtifact.content).includes(secret), false);
  assert.equal(jsonArtifact.preview?.includes(secret), false);
  assert.equal(String(textArtifact.content).includes(secret), false);
  assert.ok(jsonArtifact.redactions.some((entry) => entry.path === '/artifact/password'));
  assert.ok(textArtifact.redactions.some((entry) => entry.path === '/artifact'));
});

test('runs redaction before the SnapshotWriter persistence boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-redaction-'));
  const writer = await SnapshotWriter.open(root, { flushMode: 'event' });
  const pipeline = createDefaultRedactionPipeline();
  const recorder = new Recorder({
    interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
  });
  const secret = 'sk-abcdefghijklmnop';

  try {
    const run = await recorder.startRun({
      runtime: { name: 'test-runtime', version: '0.1.0' },
      input: { api_key: secret },
    });
    await recorder.appendEvent(run.context(), {
      type: 'tool.requested',
      payload: { headers: { authorization: `Bearer ${secret}` } },
    });
    await recorder.completeRun(run, { final_state_hash: 'a'.repeat(64) });
    await writer.close();

    const serialized = await readFile(join(root, 'events.jsonl'), 'utf8');
    assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /"redactions":\[/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('redacts checkpoint state before SnapshotWriter persists it and preserves recovery hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-redacted-checkpoint-'));
  const writer = await SnapshotWriter.open(root, { flushMode: 'event' });
  const pipeline = createDefaultRedactionPipeline();
  const recorder = new Recorder({
    interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
  });
  const secret = 'sk-reviewsecret123456789';
  const originalState = {
    api_key: secret,
    nested: { token: secret },
    users: [{ token: secret }],
  };

  try {
    const run = await recorder.startRun({
      runtime: { name: 'test-runtime', version: '0.1.0' },
    });
    const originalHash = hashState(originalState);
    const checkpoint = await recorder.checkpoint(run, {
      state: originalState,
      stateHash: originalHash,
    });
    const checkpointEvent = recorder
      .getEvents(run)
      .find((recorded) => recorded.type === 'checkpoint.created');

    assert.notEqual(checkpoint.state_hash, originalHash);
    assert.equal(hashState(checkpoint.state as typeof originalState), checkpoint.state_hash);
    assert.equal(
      (checkpointEvent?.payload as { state_hash?: string }).state_hash,
      checkpoint.state_hash,
    );
    assert.equal(JSON.stringify(checkpoint).includes(secret), false);

    await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
    await writer.commit(recorder.getManifest(run));
    await writer.close();

    const checkpointFile = join(root, 'checkpoints', '000001.json');
    const checkpointContents = await readFile(checkpointFile, 'utf8');
    const eventContents = await readFile(join(root, 'events.jsonl'), 'utf8');
    const storedCheckpoint = JSON.parse(checkpointContents) as Checkpoint;
    assert.equal(checkpointContents.includes(secret), false);
    assert.equal(eventContents.includes(secret), false);
    assert.deepEqual(storedCheckpoint, checkpoint);

    const eventScan = await scanJsonlFile(join(root, 'events.jsonl'));
    const store = await CheckpointStore.open(join(root, 'checkpoints'));
    const restored = await reconstructState(eventScan.events as EventEnvelope<string, unknown>[], {
      checkpointStore: store,
    });
    await store.close();

    assert.deepEqual(restored.state, checkpoint.state);
    assert.equal(restored.stateHash, checkpoint.state_hash);
    assert.equal(restored.usedCheckpoint, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps checkpoint redaction consistent with redacted state-change events', async () => {
  const redactionSources = new Set<string>();
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/state/api_key', category: 'api_key', strategy: 'mask' },
      { path: '/state/nested/token', category: 'token', strategy: 'mask' },
      { path: '/state/users/*/token', category: 'token', strategy: 'mask' },
    ],
    customRedactors: [
      {
        path: '/state/profile/email',
        category: 'personal_data',
        redact: (_value, context) => {
          redactionSources.add(context.source);
          return { action: 'replace', value: '[email removed]' };
        },
      },
    ],
  });
  const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
  const sourceState = {
    api_key: 'sk-reviewsecret123456789',
    nested: { token: 'nested-secret' },
    users: [{ token: 'first-secret' }, { token: 'second-secret' }],
    profile: { email: 'ada@example.com' },
  };
  const expectedState = {
    state: {
      api_key: '[REDACTED:api_key]',
      nested: { token: '[REDACTED:token]' },
      users: [{ token: '[REDACTED:token]' }, { token: '[REDACTED:token]' }],
      profile: { email: '[email removed]' },
    },
  };

  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'set', path: '/state', value: sourceState },
  });
  const checkpoint = await recorder.checkpoint(run, {
    state: { state: sourceState },
    stateHash: hashState({ state: sourceState }),
  });
  const fromEvents = await reconstructState(recorder.getEvents(run));
  const checkpointEvent = recorder
    .getEvents(run)
    .find((recorded) => recorded.type === 'checkpoint.created');

  assert.deepEqual(checkpoint.state, expectedState);
  assert.deepEqual(fromEvents.state, expectedState);
  assert.equal(checkpoint.state_hash, fromEvents.stateHash);
  assert.equal(
    (checkpointEvent?.payload as { state_hash?: string }).state_hash,
    checkpoint.state_hash,
  );
  assert.deepEqual([...redactionSources].sort(), ['checkpoint', 'event']);
});

test('applies logical state paths to merge, append, and escaped-pointer changes', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/profile/token', category: 'token', strategy: 'mask' },
      { path: '/tokens/*', category: 'token', strategy: 'mask' },
      { path: '/users/a~1b/password', category: 'password', strategy: 'mask' },
    ],
  });
  const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'merge', path: '/profile', value: { token: 'merged-secret' } },
  });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'set', path: '/tokens', value: [] },
  });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'append', path: '/tokens', value: 'appended-secret' },
  });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'set', path: '/users', value: { 'a/b': {} } },
  });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: {
      operation: 'set',
      path: '/users/a~1b/password',
      value: 'escaped-pointer-password',
    },
  });

  const rawState = {
    profile: { token: 'merged-secret' },
    tokens: ['appended-secret'],
    users: { 'a/b': { password: 'escaped-pointer-password' } },
  };
  const checkpoint = await recorder.checkpoint(run, {
    state: rawState,
    stateHash: hashState(rawState),
  });
  const expectedState = {
    profile: { token: '[REDACTED:token]' },
    tokens: ['[REDACTED:token]'],
    users: { 'a/b': { password: '[REDACTED:password]' } },
  };
  const fromEvents = await reconstructState(recorder.getEvents(run));

  assert.deepEqual(fromEvents.state, expectedState);
  assert.deepEqual(checkpoint.state, expectedState);
  assert.equal(fromEvents.stateHash, checkpoint.state_hash);
  assert.equal(JSON.stringify(recorder.getEvents(run)).includes('merged-secret'), false);
  assert.equal(JSON.stringify(recorder.getEvents(run)).includes('appended-secret'), false);
  assert.equal(JSON.stringify(recorder.getEvents(run)).includes('escaped-pointer-password'), false);
});

test('never falls back to raw state values after a remove rule or ancestor replacement', async () => {
  for (const pipeline of [
    new RedactionPipeline({
      fieldRules: [{ path: '/password', category: 'password', strategy: 'remove' }],
    }),
    new RedactionPipeline({
      customRedactors: [
        { path: '/password', category: 'password', redact: () => ({ action: 'remove' }) },
      ],
    }),
    new RedactionPipeline({
      fieldRules: [{ path: '/profile', category: 'profile', strategy: 'mask' }],
    }),
  ]) {
    const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    for (const path of ['/password', '/profile/password']) {
      if ((path === '/profile/password') !== (pipeline.fieldRules[0]?.path === '/profile'))
        continue;
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: { operation: 'set', path, value: 'review-only-secret' },
        }),
        (error: unknown) =>
          error instanceof RedactionError && error.code === 'STATE_REDACTION_UNREPRESENTABLE',
      );
      assert.equal(recorder.getEvents(run).length, 1);
    }
  }
});

test('rejects index-sensitive append rules including dash writes and custom callbacks', async () => {
  for (const pipeline of [
    new RedactionPipeline({
      fieldRules: [{ path: '/tokens/1', category: 'token', strategy: 'mask' }],
    }),
    new RedactionPipeline({
      customRedactors: [
        { path: '/tokens/*', category: 'token', redact: () => ({ action: 'keep' }) },
      ],
    }),
  ]) {
    const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/tokens', value: ['public'] },
    });
    for (const [operation, path] of [
      ['append', '/tokens'],
      ['set', '/tokens/-'],
    ]) {
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: { operation, path, value: 'review-only-secret' },
        }),
        (error: unknown) =>
          error instanceof RedactionError && error.code === 'STATE_REDACTION_CONTEXT_REQUIRED',
      );
      assert.equal(recorder.getEvents(run).length, 2);
    }
  }
});

test('rejects non-object merge redaction and custom merge rules that lack state context', async () => {
  const pipelines = [
    ...(['mask', 'reference'] as const).map(
      (strategy) =>
        new RedactionPipeline({
          fieldRules: [{ path: '/profile', category: 'private', strategy }],
        }),
    ),
    ...[null, [], 'hidden', 0, false].map(
      (value) =>
        new RedactionPipeline({
          customRedactors: [
            {
              path: '/profile',
              category: 'private',
              redact: () => ({ action: 'replace', value }),
            },
          ],
        }),
    ),
  ];
  for (const [index, pipeline] of pipelines.entries()) {
    const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    const before = recorder.getEvents(run);
    await assert.rejects(
      recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: {
          operation: 'merge',
          path: '/profile',
          value: { password: 'review-only-secret' },
        },
      }),
      (error: unknown) =>
        error instanceof RedactionError &&
        error.code ===
          (index < 2 ? 'STATE_REDACTION_UNREPRESENTABLE' : 'STATE_REDACTION_CONTEXT_REQUIRED') &&
        !error.message.includes('review-only-secret'),
    );
    assert.deepEqual(recorder.getEvents(run), before);
  }

  const recorder = new Recorder({
    interceptors: [
      new RedactionPipeline({
        fieldRules: [{ path: '/profile/password', category: 'private', strategy: 'mask' }],
      }).asInterceptor(),
    ],
  });
  const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'merge', path: '/profile', value: { password: 'secret' } },
  });
  assert.deepEqual((await reconstructState(recorder.getEvents(run))).state, {
    profile: { password: '[REDACTED:private]' },
  });
});

test('rejects custom redaction that lacks incremental state context while allowing complete sets', async () => {
  const redactProfile = (value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { action: 'keep' } as const;
    }
    const profile = value as Record<string, JsonValue>;
    if (profile.private !== true) return { action: 'keep' } as const;
    const redacted: Record<string, JsonValue> = { ...profile };
    delete redacted.label;
    return { action: 'replace', value: redacted } as const;
  };
  const recorder = new Recorder({
    interceptors: [
      new RedactionPipeline({
        customRedactors: [{ path: '/profile', category: 'private', redact: redactProfile }],
      }).asInterceptor(),
    ],
  });
  const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: { operation: 'set', path: '/profile', value: { private: true } },
  });
  const before = recorder.getEvents(run);
  for (const payload of [
    { operation: 'merge', path: '/profile', value: { label: 'review-only-secret' } },
    { operation: 'set', path: '/profile/label', value: 'review-only-secret' },
  ]) {
    await assert.rejects(
      recorder.appendEvent(run.context(), { type: 'state.changed', payload }),
      (error: unknown) =>
        error instanceof RedactionError &&
        error.code === 'STATE_REDACTION_CONTEXT_REQUIRED' &&
        !error.message.includes('review-only-secret'),
    );
    assert.deepEqual(recorder.getEvents(run), before);
  }
  await recorder.appendEvent(run.context(), {
    type: 'state.changed',
    payload: {
      operation: 'set',
      path: '/profile',
      value: { private: true, label: 'review-only-secret' },
    },
  });
  assert.deepEqual((await reconstructState(recorder.getEvents(run))).state, {
    profile: { private: true },
  });

  const descendant = new Recorder({
    interceptors: [
      new RedactionPipeline({
        customRedactors: [
          {
            path: '/profile/token',
            category: 'private',
            redact: () => ({ action: 'replace', value: '[redacted]' }),
          },
        ],
      }).asInterceptor(),
    ],
  });
  const descendantRun = await descendant.startRun({ runtime: { name: 'test', version: '1' } });
  await descendant.appendEvent(descendantRun.context(), {
    type: 'state.changed',
    payload: { operation: 'merge', path: '/profile', value: { token: 'secret' } },
  });
  assert.deepEqual((await reconstructState(descendant.getEvents(descendantRun))).state, {
    profile: { token: '[redacted]' },
  });
});

test('rejects delete rules that need the original state or array positions', async () => {
  const scenarios = [
    { rule: '/profile/password', strategy: 'remove' as const, path: '/profile/password' },
    { rule: '/profile', strategy: 'remove' as const, path: '/profile/password' },
    { rule: '/profile', strategy: 'mask' as const, path: '/profile/password' },
    { rule: '/profile', strategy: 'reference' as const, path: '/profile/password' },
    { rule: '/tokens/0', strategy: 'remove' as const, path: '/tokens/1' },
    { rule: '/tokens/*', strategy: 'remove' as const, path: '/tokens/1' },
    { rule: '/tokens/1', strategy: 'mask' as const, path: '/tokens/0' },
    { rule: '/users/0', strategy: 'remove' as const, path: '/users/1/name' },
    { rule: '/users/1/token', strategy: 'reference' as const, path: '/users/0' },
    { rule: '/a~1b/*/password', strategy: 'remove' as const, path: '/a~1b/user/password' },
  ];
  for (const { rule, strategy, path } of scenarios) {
    const recorder = new Recorder({
      interceptors: [
        new RedactionPipeline({
          fieldRules: [{ path: rule, category: 'private', strategy }],
        }).asInterceptor(),
      ],
    });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    const before = recorder.getEvents(run);
    // An optional value must not bypass the delete guard either.
    for (const extra of [{}, { value: 'review-only-secret' }]) {
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: { operation: 'delete', path, ...extra },
        }),
        (error: unknown) =>
          error instanceof RedactionError &&
          (error.code === 'STATE_REDACTION_UNREPRESENTABLE' ||
            error.code === 'STATE_REDACTION_CONTEXT_REQUIRED'),
      );
      assert.deepEqual(recorder.getEvents(run), before);
    }
  }
  for (const path of [undefined, '/profile/password', '/users/*/token']) {
    const recorder = new Recorder({
      interceptors: [
        new RedactionPipeline({
          customRedactors: [
            {
              ...(path === undefined ? {} : { path }),
              category: 'private',
              redact: () => ({ action: 'keep' }),
            },
          ],
        }).asInterceptor(),
      ],
    });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    await assert.rejects(
      recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: {
          operation: 'delete',
          path: path?.startsWith('/users') ? '/users/0' : '/profile/password',
        },
      }),
      (error: unknown) =>
        error instanceof RedactionError && error.code === 'STATE_REDACTION_CONTEXT_REQUIRED',
    );
  }
});

test('preserves safe object, masked-field, and wildcard-array deletes without adding a value', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/profile/password', category: 'private', strategy: 'mask' },
      { path: '/tokens/*', category: 'private', strategy: 'reference' },
      { path: '/removed/password', category: 'private', strategy: 'remove' },
    ],
    customRedactors: [
      { path: '/unrelated', category: 'private', redact: () => ({ action: 'keep' }) },
    ],
  });
  const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
  const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
  for (const [path, value] of [
    ['/profile', { password: 'secret', label: 'public' }],
    ['/tokens', ['first', 'second']],
    ['/removed', { password: 'secret' }],
  ] as const) {
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path, value },
    });
  }
  for (const path of ['/profile/password', '/profile/label', '/tokens/0', '/removed']) {
    const event = await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'delete', path },
    });
    assert.equal(Object.hasOwn(event.payload, 'value'), false);
  }
  const state = { profile: {}, tokens: ['second'] };
  const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
  const restored = await reconstructState(recorder.getEvents(run));
  assert.deepEqual(restored.state, checkpoint.state);
  assert.equal(restored.stateHash, checkpoint.state_hash);
});

test('custom logical control-name rules do not see protocol controls', async () => {
  const seen: unknown[] = [];
  const pipeline = new RedactionPipeline({
    customRedactors: [
      {
        path: '/path',
        category: 'private',
        redact: (value) => {
          seen.push(value);
          return { action: 'replace', value: '[custom]' };
        },
      },
    ],
  });
  const recorded = await pipeline.redactEvent({
    ...event({ operation: 'set', path: '/path', value: 'secret' }),
    type: 'state.changed',
  });
  assert.deepEqual(recorded.payload, { operation: 'set', path: '/path', value: '[custom]' });
  assert.deepEqual(seen, ['secret']);
});

test('state controls remain intact for artifact values and optional delete values', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/path', category: 'private', strategy: 'mask' },
      { path: '/operation', category: 'private', strategy: 'mask' },
      { path: '/value', category: 'private', strategy: 'mask' },
    ],
  });
  const artifact = {
    schema_version: '0.1.0',
    digest: 'a'.repeat(64),
    media_type: 'application/json',
    byte_length: 128,
  };
  const recorded = await pipeline.redactEvent({
    ...event({ operation: 'set', path: '/state', value: artifact }),
    type: 'state.changed',
  });
  assert.deepEqual(recorded.payload, {
    operation: 'set',
    path: '/state',
    value: '[REDACTED:private]',
  });
  const deleted = await pipeline.redactEvent({
    ...event({ operation: 'delete', path: '/path', value: 'secret' }),
    type: 'state.changed',
  });
  assert.deepEqual(deleted.payload, {
    operation: 'delete',
    path: '/path',
    value: '[REDACTED:private]',
  });
});

test('rejects regex-sensitive controls and unrepresentable metadata without committing events', async () => {
  for (const pipeline of [
    new RedactionPipeline({
      regexRules: [{ pattern: /review-only-secret/g, category: 'private', strategy: 'mask' }],
    }),
    new RedactionPipeline({
      customRedactors: [
        {
          category: 'private',
          redact: (_value, context) =>
            context.path === '/payload' && context.eventType === 'state.changed'
              ? { action: 'remove' }
              : { action: 'keep' },
        },
      ],
    }),
  ]) {
    const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    const before = recorder.getEvents(run);
    for (const operation of ['set', 'merge', 'append', 'delete']) {
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: {
            operation,
            path: '/review-only-secret',
            ...(operation === 'delete' ? {} : { value: {} }),
          },
        }),
        (error: unknown) =>
          error instanceof RedactionError &&
          error.code ===
            (pipeline.customRedactors.length > 0
              ? 'STATE_REDACTION_CONTEXT_REQUIRED'
              : 'STATE_REDACTION_UNREPRESENTABLE') &&
          !error.message.includes('review-only-secret'),
      );
      assert.deepEqual(recorder.getEvents(run), before);
    }
  }
});

test('dash object keys are preserved and ambiguous set rules require container context', async () => {
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/byId/-/password', category: 'private', strategy: 'mask' },
      { path: '/byId/-/tokens/*', category: 'private', strategy: 'mask' },
    ],
  });
  await assert.rejects(
    pipeline.redactEvent({
      ...event({ operation: 'set', path: '/byId/-', value: { password: 'secret' } }),
      type: 'state.changed',
    }),
    (error: unknown) =>
      error instanceof RedactionError && error.code === 'STATE_REDACTION_CONTEXT_REQUIRED',
  );
  for (const [operation, path, value, expected] of [
    ['merge', '/byId/-', { password: 'secret' }, { password: '[REDACTED:private]' }],
    ['set', '/byId/-/password', 'secret', '[REDACTED:private]'],
    ['append', '/byId/-/tokens', 'secret', '[REDACTED:private]'],
  ] as const) {
    const result = await pipeline.redactEvent({
      ...event({ operation, path, value }),
      type: 'state.changed',
    });
    assert.deepEqual((result.payload as { value: unknown }).value, expected);
  }
});

test('numeric object keys stay exact and do not allocate space proportional to their value', async () => {
  for (const key of ['4294967295', '9007199254740993', '9'.repeat(80)]) {
    const recorder = new Recorder({ interceptors: [new RedactionPipeline().asInterceptor()] });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/byId', value: {} },
    });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path: `/byId/${key}`, value: { label: 'public' } },
    });
    assert.deepEqual((await reconstructState(recorder.getEvents(run))).state, {
      byId: { [key]: { label: 'public' } },
    });
  }
  // Isolate heap measurement from the test runner and warm the normal append path first.
  const script = `
    import { Recorder, RedactionPipeline } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
    const recorder = new Recorder({ interceptors: [new RedactionPipeline().asInterceptor()] });
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    await recorder.appendEvent(run.context(), { type: 'state.changed', payload: { operation: 'set', path: '/byId', value: {} } });
    await recorder.appendEvent(run.context(), { type: 'state.changed', payload: { operation: 'set', path: '/byId/warm', value: { label: 'public' } } });
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    await recorder.appendEvent(run.context(), { type: 'state.changed', payload: { operation: 'set', path: '/byId/1000000', value: { label: 'public' } } });
    console.log(JSON.stringify({ heapGrowth: process.memoryUsage().heapUsed - before }));
  `;
  const measured = JSON.parse(
    execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10000,
    }),
  ) as { heapGrowth: number };
  assert.ok(
    measured.heapGrowth < 2 * 1024 * 1024,
    `small update allocated ${measured.heapGrowth} bytes`,
  );
});

test('accepted structural redaction increments match independently redacted complete states', async () => {
  const publicValue = { private: false, label: 'old', tags: [] };
  const privateValue = { private: true, label: 'review-only-secret', tags: [] };
  type Change = { operation: string; path: string; value?: JsonValue };
  const suites: { initial: JsonValue; paths: string[]; changes: Change[] }[] = [
    {
      initial: { a: publicValue, b: publicValue },
      paths: ['', '/a', '/b', '/*', '/a/label', '/*/label'],
      changes: [
        { operation: 'merge', path: '/data', value: { a: privateValue } },
        { operation: 'merge', path: '/data', value: { a: { private: true } } },
        { operation: 'set', path: '/data/a', value: privateValue },
        { operation: 'set', path: '/data/a/label', value: 'new' },
        { operation: 'append', path: '/data/a/tags', value: 'new' },
        { operation: 'delete', path: '/data/a' },
        { operation: 'set', path: '/data', value: { a: privateValue, b: publicValue } },
      ],
    },
    {
      initial: [privateValue, publicValue, publicValue],
      paths: ['', '/0', '/1', '/*', '/1/label', '/*/label'],
      changes: [
        { operation: 'set', path: '/data/1', value: privateValue },
        { operation: 'merge', path: '/data/1', value: { label: 'new' } },
        { operation: 'append', path: '/data/1/tags', value: 'new' },
        { operation: 'append', path: '/data', value: publicValue },
        { operation: 'set', path: '/data/-', value: publicValue },
        { operation: 'delete', path: '/data/0' },
        { operation: 'delete', path: '/data/1' },
        { operation: 'set', path: '/data', value: [privateValue, publicValue] },
      ],
    },
    {
      initial: { 'a/b': { items: [privateValue, publicValue] } },
      paths: ['', '/a~1b', '/a~1b/items', '/a~1b/items/0', '/a~1b/items/*', '/a~1b/items/*/label'],
      changes: [
        { operation: 'set', path: '/data/a~1b/items/1', value: publicValue },
        { operation: 'merge', path: '/data/a~1b/items/1', value: { label: 'new' } },
        { operation: 'append', path: '/data/a~1b/items/1/tags', value: 'new' },
        { operation: 'delete', path: '/data/a~1b/items/0' },
        { operation: 'set', path: '/data/a~1b/items', value: [publicValue] },
        { operation: 'set', path: '/data/a~1b', value: { items: [publicValue] } },
      ],
    },
  ];
  let accepted = 0;
  let rejected = 0;
  for (const suite of suites) {
    const configurations: RedactionPipelineOptions[] = suite.paths.flatMap((path) => [
      ...(['mask', 'reference', 'remove'] as const).map((strategy) => ({
        fieldRules: [{ path: `/data${path}`, strategy, category: 'private' }],
      })),
      {
        customRedactors: [
          {
            path: `/data${path}`,
            category: 'private',
            redact: (value) =>
              value !== null &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              value.private === true
                ? { action: 'remove' }
                : { action: 'keep' },
          },
        ],
      },
    ]);
    configurations.push({
      fieldRules: [
        { path: '/data/0', category: 'private', strategy: 'remove' },
        { path: '/data/1/label', category: 'private', strategy: 'mask' },
      ],
    });
    for (const [configIndex, options] of configurations.entries()) {
      for (const change of suite.changes) {
        const raw = new Recorder();
        const run = await raw.startRun({ runtime: { name: 'test', version: '1' } });
        const seed = await raw.appendEvent(run.context(), {
          type: 'state.changed',
          payload: { operation: 'set', path: '/data', value: suite.initial },
        });
        const delta = await raw.appendEvent(run.context(), {
          type: 'state.changed',
          payload: change,
        });
        const complete = await reconstructState(raw.getEvents(run));
        const checkpoint = await raw.checkpoint(run, {
          state: complete.state,
          stateHash: complete.stateHash,
        });
        const pipeline = new RedactionPipeline(options);
        let seedRedacted: EventEnvelope<string, unknown>;
        let deltaRedacted: EventEnvelope<string, unknown>;
        try {
          seedRedacted = await pipeline.redactEvent(seed);
          deltaRedacted = await pipeline.redactEvent(delta);
        } catch (error) {
          assert.ok(
            error instanceof RedactionError &&
              (error.code === 'STATE_REDACTION_CONTEXT_REQUIRED' ||
                error.code === 'STATE_REDACTION_UNREPRESENTABLE'),
          );
          rejected += 1;
          continue;
        }
        const message = JSON.stringify({
          array: Array.isArray(suite.initial),
          configIndex,
          change,
        });
        const restored = await reconstructState([
          raw.getEvents(run)[0]!,
          seedRedacted,
          deltaRedacted,
        ]);
        const expected = await pipeline.redactCheckpoint(checkpoint);
        assert.deepEqual(restored.state, expected.state, message);
        assert.equal(restored.stateHash, expected.state_hash, message);
        accepted += 1;
      }
    }
  }
  // Assert that this matrix exercises both useful updates and fail-closed paths.
  assert.ok(accepted > 100, `only ${accepted} accepted updates`);
  assert.ok(rejected > 100, `only ${rejected} rejected updates`);
});

test('leaves artifact-backed checkpoint state at the artifact redaction boundary', async () => {
  const pipeline = new RedactionPipeline({
    customRedactors: [
      {
        category: 'remove-checkpoint-values',
        redact: (_value, context) =>
          context.source === 'checkpoint' ? { action: 'remove' } : { action: 'keep' },
      },
    ],
  });
  const recorder = new Recorder({ interceptors: [pipeline.asInterceptor()] });
  const artifactState: ArtifactReference = {
    schema_version: '0.1.0',
    digest: 'a'.repeat(64),
    media_type: 'application/json',
    byte_length: 128,
  };
  const run = await recorder.startRun({
    runtime: { name: 'test-runtime', version: '0.1.0' },
  });
  const checkpoint = await recorder.checkpoint(run, {
    state: artifactState,
    stateHash: 'b'.repeat(64),
  });
  const checkpointEvent = recorder
    .getEvents(run)
    .find((recorded) => recorded.type === 'checkpoint.created');

  assert.deepEqual(checkpoint.state, artifactState);
  assert.equal(checkpoint.state_hash, 'b'.repeat(64));
  assert.equal((checkpointEvent?.payload as { state_hash?: string }).state_hash, 'b'.repeat(64));
});
