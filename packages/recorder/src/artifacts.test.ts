import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ArtifactReference } from '@agent-loop-snapshot/schema';

import { ArtifactStore, ArtifactStoreError } from './artifacts.js';

async function withStore(
  callback: (store: ArtifactStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-artifacts-'));
  try {
    const store = await ArtifactStore.open(root);
    await callback(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('deduplicates concurrent writes of identical content', async () => {
  await withStore(async (store) => {
    const [first, second, third] = await Promise.all([
      store.put('same content', { mediaType: 'text/plain' }),
      store.put('same content', { mediaType: 'application/octet-stream' }),
      store.put('same content', { mediaType: 'application/x-unknown' }),
    ]);

    assert.equal(first.digest, second.digest);
    assert.equal(second.digest, third.digest);
    assert.equal(first.byte_length, Buffer.byteLength('same content'));
    assert.deepEqual(await store.listArtifacts(), [`sha256-${first.digest}`]);
  });
});

test('cleans up a failed artifact write and returns a structured diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-artifact-write-failure-'));
  const store = await ArtifactStore.open(root, {
    faultInjector: {
      beforeWrite() {
        throw new Error('simulated disk full');
      },
    },
  });

  try {
    await assert.rejects(
      store.put('cannot persist', { mediaType: 'text/plain' }),
      (error: unknown) =>
        error instanceof ArtifactStoreError &&
        error.code === 'ARTIFACT_WRITE_FAILED' &&
        error.message.includes('simulated disk full'),
    );
    assert.deepEqual(await store.listArtifacts(), []);
    assert.equal(
      (await readdir(root)).some((entry) => entry.endsWith('.tmp')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans up a failed artifact commit and returns a structured diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-artifact-commit-failure-'));
  const store = await ArtifactStore.open(root, {
    faultInjector: {
      beforeCommit() {
        throw new Error('simulated atomic rename failure');
      },
    },
  });

  try {
    await assert.rejects(
      store.put('cannot commit', { mediaType: 'text/plain' }),
      (error: unknown) =>
        error instanceof ArtifactStoreError &&
        error.code === 'ARTIFACT_WRITE_FAILED' &&
        error.message.includes('simulated atomic rename failure'),
    );
    assert.deepEqual(await store.listArtifacts(), []);
    assert.equal(
      (await readdir(root)).some((entry) => entry.endsWith('.tmp')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('round-trips binary artifacts without decoding their media type', async () => {
  await withStore(async (store) => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    const reference = await store.put(bytes, {
      mediaType: 'application/x-unknown-binary',
      preview: '[binary]',
    });

    assert.deepEqual([...(await store.get(reference))], [...bytes]);
    assert.deepEqual(await store.verify(reference), {
      valid: true,
      digest: reference.digest,
      code: 'VALID',
      message: 'Artifact is present and matches its declared digest and byte length.',
    });
  });
});

test('reports tampered artifacts and refuses to read them', async () => {
  await withStore(async (store) => {
    const reference = await store.put('original', { mediaType: 'text/plain' });
    await writeFile(store.pathFor(reference), 'tampered');

    const report = await store.verify(reference);
    assert.equal(report.valid, false);
    assert.equal(report.code, 'ARTIFACT_DIGEST_MISMATCH');
    await assert.rejects(
      store.get(reference),
      (error: unknown) =>
        error instanceof ArtifactStoreError && error.code === 'ARTIFACT_DIGEST_MISMATCH',
    );
  });
});

test('returns a missing-reference report when an artifact is absent', async () => {
  await withStore(async (store) => {
    const reference = await store.put('will be removed', { mediaType: 'text/plain' });
    await rm(store.pathFor(reference));

    const [diagnostic] = await store.verifyReferences([reference]);
    assert.ok(diagnostic);
    assert.equal(diagnostic.reference.digest, reference.digest);
    assert.equal(diagnostic.report.valid, false);
    assert.equal(diagnostic.report.code, 'MISSING_ARTIFACT');
  });
});

test('rejects invalid references before constructing a filesystem path', async () => {
  await withStore(async (store) => {
    const invalid = {
      schema_version: '0.1.0',
      digest: '../outside',
      media_type: 'text/plain',
      byte_length: 1,
    } as unknown as ArtifactReference;

    const report = await store.verify(invalid);
    assert.equal(report.code, 'INVALID_ARTIFACT_REFERENCE');
    assert.throws(
      () => store.pathFor(invalid),
      (error: unknown) =>
        error instanceof ArtifactStoreError && error.code === 'INVALID_ARTIFACT_REFERENCE',
    );
  });
});
