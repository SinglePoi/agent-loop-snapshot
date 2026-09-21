import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateSnapshotDirectory } from '@agent-loop-snapshot/schema';
import type { OtlpExporter } from '@agent-loop-snapshot/otel-export';

import { instrument } from './index.js';

async function withAgent(testOperation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-generic-instrumentation-'));
  try {
    await testOperation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function onlySnapshotDirectory(directory: string): Promise<string> {
  const children = await readdir(directory);
  assert.equal(children.length, 1);
  return join(directory, children[0]!);
}

test('queues a committed generic snapshot asynchronously and flushes it on shutdown', async () => {
  await withAgent(async (directory) => {
    const exported: string[] = [];
    const exporter: OtlpExporter = {
      contractVersion: 'otel-export-1.0',
      async exportSnapshot(snapshot) {
        exported.push(snapshot.manifest.run_id);
        return {
          state: 'queued',
          targetAlias: 'fixture',
          attempted: false,
          acceptedSpanCount: 0,
          rejectedSpanCount: 0,
          attempts: 0,
        };
      },
      async flush() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
      async shutdown() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
    };
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: { name: 'fixture-model', call: async () => 'ok' },
      tools: {},
      exporters: [exporter],
    });
    assert.equal(await agent.run({ input: { goal: 'export' } }, ({ model }) => model.call()), 'ok');
    await agent.shutdown();
    assert.equal(exported.length, 1);
  });
});

test('waits for durable exporter registration but preserves the business result', async () => {
  await withAgent(async (directory) => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const registered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exporter: OtlpExporter = {
      contractVersion: 'otel-export-1.0',
      async exportSnapshot() {
        markStarted?.();
        await registered;
        return {
          state: 'queued',
          targetAlias: 'fixture',
          attempted: false,
          acceptedSpanCount: 0,
          rejectedSpanCount: 0,
          attempts: 0,
        };
      },
      async flush() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
      async shutdown() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
    };
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: { name: 'fixture-model', call: async () => 'ok' },
      tools: {},
      exporters: [exporter],
    });
    const running = agent.run({ input: {} }, ({ model }) => model.call());
    await started;
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release?.();
    assert.equal(await running, 'ok');
    await agent.shutdown();
  });
});

test('does not shut down a shared generic exporter', async () => {
  await withAgent(async (directory) => {
    let shutdowns = 0;
    const exporter: OtlpExporter = {
      contractVersion: 'otel-export-1.0',
      async exportSnapshot() {
        return {
          state: 'queued',
          targetAlias: 'fixture',
          attempted: false,
          acceptedSpanCount: 0,
          rejectedSpanCount: 0,
          attempts: 0,
        };
      },
      async flush() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
      async shutdown() {
        shutdowns += 1;
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
    };
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: { name: 'fixture-model', call: async () => 'ok' },
      tools: {},
      exporters: [exporter],
      exporterOwnership: 'shared',
    });
    await agent.run({ input: {} }, ({ model }) => model.call());
    await agent.shutdown();
    assert.equal(shutdowns, 0);
  });
});

test('reports incomplete generic exporter flushes without altering business results', async () => {
  await withAgent(async (directory) => {
    const diagnostics: string[] = [];
    const exporter: OtlpExporter = {
      contractVersion: 'otel-export-1.0',
      async exportSnapshot() {
        return {
          state: 'queued',
          targetAlias: 'fixture',
          attempted: false,
          acceptedSpanCount: 0,
          rejectedSpanCount: 0,
          attempts: 0,
        };
      },
      async flush() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [
            {
              state: 'rejected',
              targetAlias: 'fixture',
              attempted: true,
              acceptedSpanCount: 0,
              rejectedSpanCount: 1,
              attempts: 1,
              message: 'Fixture target rejected the batch.',
            },
          ],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
      async shutdown() {
        return {
          contractVersion: 'otel-export-1.0',
          deliveries: [],
          pendingCount: 0,
          deadlineExceeded: false,
        };
      },
    };
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: { name: 'fixture-model', call: async () => 'ok' },
      tools: {},
      exporters: [exporter],
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    assert.equal(await agent.run({ input: { goal: 'export' } }, ({ model }) => model.call()), 'ok');
    await agent.flushExporters();
    assert.deepEqual(diagnostics, ['EXPORT_FAILED']);
    await agent.shutdown();
  });
});

test('records paired model and parallel tool calls without changing business values', async () => {
  await withAgent(async (directory) => {
    let modelCalls = 0;
    const snapshots: string[] = [];
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: {
        name: 'fixture-model',
        call: async (prompt: string) => {
          modelCalls += 1;
          return { prompt, answer: 'ok' };
        },
      },
      tools: {
        search: {
          sideEffect: 'read_only',
          call: async (query: string) => ({ query, documents: ['a'] }),
        },
        write: {
          sideEffect: 'workspace_write',
          call: async (value: number) => value * 2,
        },
      },
      onSnapshot: ({ directory: snapshotDirectory }) => {
        snapshots.push(snapshotDirectory);
      },
    });

    const result = await agent.run(
      { input: { goal: 'test' } },
      async ({ model, tools, checkpoint }) => {
        const response = await model.call('find documents');
        const [search, write] = await Promise.all([tools.search('find'), tools.write(2)]);
        await checkpoint({ response, search, write });
        return { response, search, write };
      },
    );

    assert.equal(modelCalls, 1);
    assert.deepEqual(result, {
      response: { prompt: 'find documents', answer: 'ok' },
      search: { query: 'find', documents: ['a'] },
      write: 4,
    });
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    assert.deepEqual(snapshots, [snapshotDirectory]);
    const events = (await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            payload: Record<string, unknown>;
            security: { side_effect: string };
          },
      );
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'run.started',
        'model.requested',
        'model.completed',
        'tool.requested',
        'tool.requested',
        'tool.completed',
        'tool.completed',
        'checkpoint.created',
        'run.completed',
      ],
    );
    assert.equal(events[3]!.security.side_effect, 'read_only');
    assert.equal(events[4]!.security.side_effect, 'workspace_write');
    assert.equal((await validateSnapshotDirectory(snapshotDirectory)).valid, true);
  });
});

test('drains started calls and refuses to claim a final checkpoint after later activity', async () => {
  await withAgent(async (directory) => {
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: {
        name: 'fixture-model',
        call: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return 'slow';
        },
      },
      tools: {},
    });

    const startedAt = Date.now();
    await agent.run({ input: { goal: 'drain' } }, async ({ model, checkpoint }) => {
      void model.call();
      await checkpoint({ before: 'slow call completes' });
      return 'returned first';
    });
    assert.ok(Date.now() - startedAt >= 15);
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    const manifest = JSON.parse(
      await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'),
    ) as {
      completeness: string;
      terminal_status: string;
      limitations: Array<{ code: string }>;
    };
    assert.equal(manifest.completeness, 'complete');
    assert.equal(manifest.terminal_status, 'unknown');
    assert.equal(manifest.limitations[0]!.code, 'final_state_unavailable');
  });
});

test('marks a run partial when started calls exceed the drain deadline', async () => {
  await withAgent(async (directory) => {
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      drainTimeoutMs: 0,
      model: {
        name: 'fixture-model',
        call: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 15));
          return 'late';
        },
      },
      tools: {},
    });

    await agent.run({ input: { goal: 'timeout' } }, ({ model }) => {
      void model.call();
      return 'returned';
    });
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    const manifest = JSON.parse(
      await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'),
    ) as { completeness: string; limitations: Array<{ code: string }> };
    assert.equal(manifest.completeness, 'partial');
    assert.equal(manifest.limitations[0]!.code, 'drain_timed_out');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  });
});

test('uses an observation terminal when a run has no final explicit checkpoint', async () => {
  await withAgent(async (directory) => {
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: { name: 'fixture-model', call: async () => 'ok' },
      tools: {},
    });

    assert.equal(
      await agent.run({ input: { goal: 'no checkpoint' } }, ({ model }) => model.call()),
      'ok',
    );
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    const manifest = JSON.parse(
      await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'),
    ) as {
      completeness: string;
      terminal_status: string;
      limitations: Array<{ code: string }>;
    };
    assert.equal(manifest.completeness, 'complete');
    assert.equal(manifest.terminal_status, 'unknown');
    assert.deepEqual(manifest.limitations, [
      { code: 'final_state_unavailable', message: 'No final explicit checkpoint was recorded.' },
    ]);
  });
});

test('preserves a wrapped business error and records its model failure', async () => {
  await withAgent(async (directory) => {
    const original = new Error('model unavailable');
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: {
        name: 'fixture-model',
        call: async () => {
          throw original;
        },
      },
      tools: {},
    });

    await assert.rejects(
      agent.run({ input: { goal: 'failure' } }, ({ model }) => model.call()),
      (error: unknown) => error === original,
    );
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    const types = (await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.deepEqual(types, ['run.started', 'model.requested', 'model.failed', 'run.failed']);
    const manifest = JSON.parse(
      await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'),
    ) as { completeness: string; limitations: Array<{ code: string }> };
    assert.equal(manifest.completeness, 'partial');
    assert.equal(manifest.limitations[0]!.code, 'final_state_unavailable');
  });
});

test('rejects getters and cyclic values before a wrapped function executes', async () => {
  await withAgent(async (directory) => {
    let calls = 0;
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: {
        name: 'fixture-model',
        call: async (input: object) => {
          void input;
          calls += 1;
          return 'not reached';
        },
      },
      tools: {},
    });
    const withGetter = {} as { secret: string };
    Object.defineProperty(withGetter, 'secret', { enumerable: true, get: () => 'never read' });

    await assert.rejects(
      agent.run({ input: { goal: 'serializer' } }, ({ model }) => model.call(withGetter)),
      /Getter "secret"/u,
    );
    assert.equal(calls, 0);
  });
});

test('redacts default credential patterns from independently serialized call copies', async () => {
  await withAgent(async (directory) => {
    const secret = 'sk-this-is-a-test-key-1234567890';
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: { name: 'fixture-model', call: async (value: string) => value },
      tools: {},
    });

    assert.equal(
      await agent.run({ input: { goal: 'redact' } }, ({ model }) => model.call(secret)),
      secret,
    );
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    const serialized = await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8');
    assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /REDACTED:api_key/u);
  });
});

test('uses explicit serializers for BigInt input and output without changing the business value', async () => {
  await withAgent(async (directory) => {
    const agent = instrument({
      snapshotDir: directory,
      runtime: { name: 'generic-fixture', version: '1.0.0' },
      model: {
        name: 'fixture-model',
        call: async (value: bigint) => value + 1n,
        serializeInput: (value) => ({ value: value.toString() }),
        serializeOutput: (value) => ({ value: value.toString() }),
      },
      tools: {},
    });

    assert.equal(
      await agent.run({ input: { goal: 'serialize' } }, ({ model }) => model.call(9n)),
      10n,
    );
    const snapshotDirectory = await onlySnapshotDirectory(directory);
    const events = await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8');
    assert.match(events, /"value":"9"/u);
    assert.match(events, /"value":"10"/u);
  });
});
