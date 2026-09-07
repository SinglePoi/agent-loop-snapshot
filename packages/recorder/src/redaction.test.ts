import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  ArtifactReference,
  Checkpoint,
  EventEnvelope,
  RunId,
} from '@agent-loop-snapshot/schema';

import { Recorder, hashState, reconstructState } from './index.js';
import { CheckpointStore } from './checkpoints.js';
import {
  RedactionPipeline,
  createDefaultRedactionPipeline,
  type FieldRedactionRule,
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
      { path: '/value/api_key', category: 'api_key', strategy: 'mask' },
      { path: '/value/nested/token', category: 'token', strategy: 'mask' },
      { path: '/value/users/*/token', category: 'token', strategy: 'mask' },
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
      {
        path: '/value/profile/email',
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
