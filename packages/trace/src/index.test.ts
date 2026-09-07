import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadTraceSnapshot } from './index.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaFixtures = resolve(packageDirectory, '../schema/fixtures');
const exampleFixture = resolve(packageDirectory, '../example-runtime/fixtures/example-run');

test('loads a complete snapshot and builds query indexes', async () => {
  const snapshot = await loadTraceSnapshot(exampleFixture);

  assert.equal(snapshot.valid, true);
  assert.equal(snapshot.manifestSource, 'final');
  assert.equal(snapshot.manifest?.run_id, 'run_00000000-0000-4000-8000-000000000106');
  assert.equal(snapshot.events.length, 15);
  assert.equal(snapshot.checkpoints.length, 1);
  assert.equal(snapshot.query.getRootEvents().length, 1);
  assert.equal(snapshot.query.getEventsByType('tool.requested').length, 3);
  assert.equal(snapshot.query.getEventsByActor('agent.main').length, 15);

  const parallelRequests = snapshot.query.findEvents({
    type: 'tool.requested',
    minSequence: 6,
    maxSequence: 7,
  });
  assert.deepEqual(
    parallelRequests.map((event) => event.payload),
    [
      {
        correlation_key: 'tool:read_goal_metadata:0:fixture',
        tool: 'read_goal_metadata',
        arguments: { goal: 'summarize fixture' },
      },
      {
        correlation_key: 'tool:read_runtime_context:1:fixture',
        tool: 'read_runtime_context',
        arguments: { goal: 'summarize fixture' },
      },
    ],
  );

  const root = snapshot.query.getRootEvents()[0];
  assert.ok(root);
  assert.equal(snapshot.query.getChildren(root.event_id).length, 1);
  assert.equal(snapshot.query.getEvent(root.event_id), root);
});

test('loads artifact metadata and reports a mismatched artifact size', async () => {
  const snapshot = await loadTraceSnapshot(resolve(schemaFixtures, 'corrupted-reference'));
  const digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const metadata = snapshot.artifacts.get(digest);

  assert.equal(snapshot.valid, false);
  assert.ok(metadata);
  assert.equal(metadata.exists, true);
  assert.equal(metadata.byte_length, 16);
  assert.notEqual(metadata.actual_byte_length, metadata.byte_length);
  assert.equal(metadata.media_types[0], 'application/json');
  assert.ok(
    snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'ARTIFACT_SIZE_MISMATCH'),
  );
  assert.equal((await snapshot.readArtifact(digest)).byteLength, metadata.actual_byte_length);
});

test('retains unknown-version events and reports schema diagnostics', async () => {
  const snapshot = await loadTraceSnapshot(resolve(schemaFixtures, 'unknown-version'));

  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.query.getEventsByType('run.started').length, 1);
  assert.equal(snapshot.valid, false);
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'SCHEMA_CONST'));
});

test('reports malformed JSONL tails while keeping complete preceding events', async () => {
  const source = resolve(schemaFixtures, 'minimal-success');
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-trace-'));
  try {
    await writeFile(
      join(directory, 'manifest.json'),
      await readFile(join(source, 'manifest.json')),
    );
    const events = await readFile(join(source, 'events.jsonl'), 'utf8');
    await writeFile(join(directory, 'events.jsonl'), `${events}{"event_id":"partial`);

    const snapshot = await loadTraceSnapshot(directory);
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.valid, false);
    assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'PARTIAL_JSONL_TAIL'));
    assert.equal(
      snapshot.diagnostics.find((diagnostic) => diagnostic.code === 'PARTIAL_JSONL_TAIL')?.line,
      4,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('detects causal cycles and broken parent references', async () => {
  const source = resolve(schemaFixtures, 'minimal-success');
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-trace-'));
  try {
    await writeFile(
      join(directory, 'manifest.json'),
      await readFile(join(source, 'manifest.json')),
    );
    const events = (await readFile(join(source, 'events.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const first = events[0];
    const second = events[1];
    const third = events[2];
    assert.ok(first && second && third);
    const missingParentId = 'evt_00000000-0000-4000-8000-000000000099';
    first.parent_ids = [third.event_id];
    second.parent_ids = [first.event_id, missingParentId];
    third.parent_ids = [second.event_id];
    await writeFile(
      join(directory, 'events.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );

    const snapshot = await loadTraceSnapshot(directory);
    assert.equal(snapshot.valid, false);
    assert.equal(snapshot.query.getRootEvents().length, 1);
    assert.equal(
      snapshot.diagnostics.filter((diagnostic) => diagnostic.code === 'EVENT_CYCLE').length,
      3,
    );
    assert.ok(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'BROKEN_PARENT_REFERENCE'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
