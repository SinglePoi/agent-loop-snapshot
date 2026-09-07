import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateSnapshotDirectory } from '@agent-loop-snapshot/schema';

import { ArtifactReadError, loadTraceSnapshot } from './index.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaFixtures = resolve(packageDirectory, '../schema/fixtures');
const exampleFixture = resolve(packageDirectory, '../example-runtime/fixtures/example-run');

interface ArtifactSnapshotFixture {
  readonly source: string;
  readonly external: string;
  readonly digest: string;
  readonly artifactPath: string;
}

async function createArtifactSnapshot(root: string): Promise<ArtifactSnapshotFixture> {
  const source = join(root, 'source');
  const external = join(root, 'external');
  const contents = Buffer.from('good', 'utf8');
  const digest = createHash('sha256').update(contents).digest('hex');
  const events = (await readFile(join(schemaFixtures, 'minimal-success', 'events.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const firstEvent = events[0];
  assert.ok(firstEvent);
  firstEvent.payload = {
    ...(firstEvent.payload as Record<string, unknown>),
    input: {
      schema_version: '0.1.0',
      digest,
      media_type: 'application/octet-stream',
      byte_length: contents.byteLength,
    },
  };

  const artifactPath = join(source, 'artifacts', `sha256-${digest}`);
  await mkdir(join(source, 'artifacts'), { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(
    join(source, 'manifest.json'),
    await readFile(join(schemaFixtures, 'minimal-success', 'manifest.json')),
  );
  await writeFile(
    join(source, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  await writeFile(artifactPath, contents);

  return { source, external, digest, artifactPath };
}

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
  await assert.rejects(
    snapshot.readArtifact(digest),
    (error: unknown) =>
      error instanceof ArtifactReadError && error.code === 'ARTIFACT_SIZE_MISMATCH',
  );
});

test('limits untrusted event and artifact reads', async () => {
  const eventLimited = await loadTraceSnapshot(resolve(schemaFixtures, 'minimal-success'), {
    maxEventFileBytes: 1,
  });
  assert.equal(eventLimited.events.length, 0);
  assert.ok(
    eventLimited.diagnostics.some((diagnostic) => diagnostic.code === 'EVENT_FILE_TOO_LARGE'),
  );

  const digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const artifactLimited = await loadTraceSnapshot(resolve(schemaFixtures, 'corrupted-reference'), {
    maxArtifactBytes: 1,
  });
  assert.ok(
    artifactLimited.diagnostics.some((diagnostic) => diagnostic.code === 'ARTIFACT_TOO_LARGE'),
  );
  await assert.rejects(artifactLimited.readArtifact(digest), /exceeds the configured read limit/);
});

test('verifies artifact byte length and digest at every lazy materialization', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-artifact-integrity-'));
  try {
    const fixture = await createArtifactSnapshot(root);
    const snapshot = await loadTraceSnapshot(fixture.source);
    assert.equal(snapshot.valid, true, JSON.stringify(snapshot.diagnostics));
    assert.equal(Buffer.from(await snapshot.readArtifact(fixture.digest)).toString(), 'good');

    await writeFile(fixture.artifactPath, 'evil');
    assert.equal(snapshot.valid, true, 'loading remains lazy until the artifact is materialized');
    await assert.rejects(
      snapshot.readArtifact(fixture.digest),
      (error: unknown) =>
        error instanceof ArtifactReadError && error.code === 'ARTIFACT_DIGEST_MISMATCH',
    );

    await writeFile(fixture.artifactPath, 'grown');
    await assert.rejects(
      snapshot.readArtifact(fixture.digest),
      (error: unknown) =>
        error instanceof ArtifactReadError && error.code === 'ARTIFACT_SIZE_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects artifact directory links outside the snapshot and rechecks delayed reads', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-link-boundary-'));
  try {
    const fixture = await createArtifactSnapshot(root);
    const initialValidation = await validateSnapshotDirectory(fixture.source);
    const initialSnapshot = await loadTraceSnapshot(fixture.source);
    assert.equal(initialValidation.valid, true, JSON.stringify(initialValidation.diagnostics));
    assert.equal(initialSnapshot.valid, true, JSON.stringify(initialSnapshot.diagnostics));
    assert.equal(
      Buffer.from(await initialSnapshot.readArtifact(fixture.digest)).toString(),
      'good',
    );

    await writeFile(join(fixture.external, `sha256-${fixture.digest}`), 'good');
    await rm(join(fixture.source, 'artifacts'), { recursive: true, force: true });
    await symlink(
      fixture.external,
      join(fixture.source, 'artifacts'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const validation = await validateSnapshotDirectory(fixture.source);
    const snapshot = await loadTraceSnapshot(fixture.source);
    assert.equal(validation.valid, false);
    assert.equal(snapshot.valid, false);
    assert.ok(
      validation.diagnostics.some((diagnostic) => diagnostic.code === 'UNTRUSTED_ARTIFACT_ENTRY'),
    );
    assert.ok(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'UNTRUSTED_ARTIFACT_DIRECTORY'),
    );
    await assert.rejects(
      initialSnapshot.readArtifact(fixture.digest),
      /not a trusted snapshot file/u,
    );
    await assert.rejects(snapshot.readArtifact(fixture.digest), /missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects checkpoint directory links outside the snapshot boundary', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-checkpoint-link-'));
  try {
    const fixture = await createArtifactSnapshot(root);
    await writeFile(
      join(fixture.external, '000001.json'),
      JSON.stringify({
        schema_version: '0.1.0',
        checkpoint_id: 'cp_00000000-0000-4000-8000-000000000001',
        run_id: 'run_00000000-0000-4000-8000-000000000001',
        created_at: '2026-09-06T02:00:00.000Z',
        last_event_id: 'evt_00000000-0000-4000-8000-000000000001',
        sequence: 1,
        state_hash: 'a'.repeat(64),
        state: {},
      }),
    );
    await symlink(
      fixture.external,
      join(fixture.source, 'checkpoints'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const validation = await validateSnapshotDirectory(fixture.source);
    const snapshot = await loadTraceSnapshot(fixture.source);
    assert.equal(validation.valid, false);
    assert.equal(snapshot.valid, false);
    assert.ok(
      validation.diagnostics.some(
        (diagnostic) => diagnostic.code === 'UNTRUSTED_CHECKPOINT_DIRECTORY',
      ),
    );
    assert.ok(
      snapshot.diagnostics.some(
        (diagnostic) => diagnostic.code === 'UNTRUSTED_CHECKPOINT_DIRECTORY',
      ),
    );
    assert.deepEqual(snapshot.checkpoints, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects final artifact links and non-regular artifact entries', async (t) => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-artifact-entry-'));
  try {
    const fixture = await createArtifactSnapshot(root);
    const initialSnapshot = await loadTraceSnapshot(fixture.source);
    const externalArtifact = join(fixture.external, `sha256-${fixture.digest}`);
    await writeFile(externalArtifact, 'good');
    await rm(fixture.artifactPath, { force: true });

    try {
      await symlink(externalArtifact, fixture.artifactPath, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('The current Windows configuration does not permit file symlinks.');
        return;
      }
      throw error;
    }

    const validation = await validateSnapshotDirectory(fixture.source);
    const snapshot = await loadTraceSnapshot(fixture.source);
    assert.equal(validation.valid, false);
    assert.equal(snapshot.valid, false);
    assert.ok(
      validation.diagnostics.some((diagnostic) => diagnostic.code === 'UNTRUSTED_ARTIFACT_ENTRY'),
    );
    assert.ok(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'UNTRUSTED_ARTIFACT_ENTRY'),
    );
    await assert.rejects(
      initialSnapshot.readArtifact(fixture.digest),
      /not a trusted snapshot file/u,
    );
    await assert.rejects(snapshot.readArtifact(fixture.digest), /missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects non-regular artifact entries', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-special-artifact-'));
  try {
    const fixture = await createArtifactSnapshot(root);
    await rm(fixture.artifactPath, { force: true });
    await mkdir(fixture.artifactPath);

    const validation = await validateSnapshotDirectory(fixture.source);
    const snapshot = await loadTraceSnapshot(fixture.source);
    assert.equal(validation.valid, false);
    assert.equal(snapshot.valid, false);
    assert.ok(
      validation.diagnostics.some((diagnostic) => diagnostic.code === 'UNTRUSTED_ARTIFACT_ENTRY'),
    );
    assert.ok(
      snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'UNTRUSTED_ARTIFACT_ENTRY'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
