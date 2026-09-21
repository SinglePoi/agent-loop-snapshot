import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { importOtlpTraces, toObservationSnapshot } from '@agent-loop-snapshot/otel-import';

import { startViewer } from './index.js';

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../example-runtime/fixtures/example-run',
);
const invalidFixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../schema/fixtures/unknown-version',
);
const otlpFixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../examples/otel-import/trace.json',
);

function apiUrl(viewerUrl: string, path: string, parameters: Record<string, string> = {}): string {
  const url = new URL(viewerUrl);
  url.pathname = path;
  Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

test('serves a read-only loopback Viewer with bounded metadata and event detail', async () => {
  const viewer = await startViewer({ snapshotDirectory: fixtureDirectory, maxPageSize: 2 });
  try {
    assert.match(viewer.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/u);
    const summaryResponse = await fetch(apiUrl(viewer.url, '/api/summary'));
    assert.equal(summaryResponse.status, 200);
    const summary = (await summaryResponse.json()) as { eventCount: number; artifactCount: number };
    assert.ok(summary.eventCount > 0);
    assert.equal(summary.artifactCount, 0);

    const page = (await fetch(apiUrl(viewer.url, '/api/events', { limit: '500' })).then(
      (response) => response.json(),
    )) as { limit: number; events: Array<{ sequence: number }> };
    assert.equal(page.limit, 2);
    assert.equal(page.events.length, 2);
    const detail = (await fetch(
      apiUrl(viewer.url, '/api/event', { sequence: String(page.events[0]!.sequence) }),
    ).then((response) => response.json())) as { content: { availability: string; text?: string } };
    assert.equal(detail.content.availability, 'recorded');
    assert.match(detail.content.text ?? '', /runtime/u);

    assert.equal((await fetch(apiUrl(viewer.url, '/api/summary'), { method: 'POST' })).status, 405);
    assert.equal(
      (
        await fetch(apiUrl(viewer.url, '/api/summary'), {
          headers: { origin: 'http://example.test' },
        })
      ).status,
      403,
    );
    const denied = new URL(apiUrl(viewer.url, '/api/summary'));
    denied.searchParams.set('token', 'wrong');
    assert.equal((await fetch(denied)).status, 404);
  } finally {
    await viewer.close();
  }
});

test('keeps invalid and imported partial observations viewable without enabling execution', async () => {
  const invalidViewer = await startViewer({ snapshotDirectory: invalidFixtureDirectory });
  try {
    const summary = (await fetch(apiUrl(invalidViewer.url, '/api/summary')).then((response) =>
      response.json(),
    )) as { valid: boolean; diagnostics: unknown[] };
    assert.equal(summary.valid, false);
    assert.ok(summary.diagnostics.length > 0);
  } finally {
    await invalidViewer.close();
  }

  const temporary = await mkdtemp(join(tmpdir(), 'alsnap-viewer-otlp-'));
  try {
    const input = JSON.parse(await readFile(otlpFixture, 'utf8')) as unknown;
    const imported = importOtlpTraces(input);
    const trace = imported.traces[0];
    assert.ok(trace !== undefined);
    const observation = toObservationSnapshot(trace);
    await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(observation.manifest)}\n`);
    await writeFile(
      join(temporary, 'events.jsonl'),
      `${observation.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    const viewer = await startViewer({ snapshotDirectory: temporary });
    try {
      const summary = (await fetch(apiUrl(viewer.url, '/api/summary')).then((response) =>
        response.json(),
      )) as { manifest: { source?: string; completeness?: string; terminal_status?: string } };
      assert.equal(summary.manifest.source, 'otel-import');
      assert.equal(summary.manifest.terminal_status, 'unknown');
      assert.ok(
        summary.manifest.completeness === 'partial' || summary.manifest.completeness === 'unknown',
      );
    } finally {
      await viewer.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
