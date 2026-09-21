import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { validateSnapshotDirectory } from '@agent-loop-snapshot/schema';
import type { OtlpExporter } from '@agent-loop-snapshot/otel-export';

import {
  initInstrumentation,
  instrument,
  patchMethod,
  type InstrumentationIntegrationApi,
} from './index.js';

test('patchMethod preserves receiver and does not overwrite a later wrapper on restore', () => {
  const client = {
    prefix: 'before',
    create(this: { prefix: string }, request: string) {
      return `${this.prefix}:${request}`;
    },
  };
  const restore = patchMethod(client, 'create', ({ original, thisArg, args }) => {
    return original.apply(thisArg, [`recorded-${String(args[0])}`]);
  });

  assert.equal(client.create('request'), 'before:recorded-request');
  const thirdPartyWrapper = () => 'third-party';
  client.create = thirdPartyWrapper as typeof client.create;
  assert.equal(restore(), false);
  assert.equal(client.create('request'), 'third-party');
});

test('queues a committed SDK snapshot without changing the business result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-export-'));
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
  const telemetry = initInstrumentation({ snapshotDir: directory, exporters: [exporter] });
  try {
    assert.equal(await telemetry.run({}, () => 'business result'), 'business result');
    await telemetry.shutdown();
    assert.equal(exported.length, 1);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('registers a failed SDK run without replacing its business error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-export-failed-run-'));
  const exported: string[] = [];
  const exporter: OtlpExporter = {
    contractVersion: 'otel-export-1.0',
    async exportSnapshot(snapshot) {
      exported.push(snapshot.manifest.terminal_status ?? 'unknown');
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
  const telemetry = initInstrumentation({ snapshotDir: directory, exporters: [exporter] });
  try {
    await assert.rejects(
      telemetry.run({}, () => {
        throw new Error('business failed');
      }),
      /business failed/u,
    );
    assert.deepEqual(exported, ['failed']);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports incomplete SDK exporter shutdowns without changing business results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-export-failure-'));
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
        deliveries: [],
        pendingCount: 0,
        deadlineExceeded: false,
      };
    },
    async shutdown() {
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
  };
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    exporters: [exporter],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
  });
  try {
    assert.equal(await telemetry.run({}, () => 'business result'), 'business result');
    await telemetry.shutdown();
    assert.deepEqual(diagnostics, ['EXPORT_FAILED']);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('suppresses SDK capture for a generic model wrapper but preserves a nested SDK call in a tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const client = {
    calls: 0,
    async create(prompt: string): Promise<string> {
      this.calls += 1;
      return `sdk:${prompt}`;
    },
  };
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [
      {
        name: 'fixture-sdk',
        install(api) {
          return patchMethod(client, 'create', ({ original, thisArg, args }) => {
            const active = api.currentRun();
            if (active === undefined) {
              return original.apply(thisArg, [...args]);
            }
            return (async () => {
              const requested = await active.recorder.appendEvent(active.run.context(), {
                type: 'model.requested',
                payload: {
                  correlation_key: `fixture:${String(args[0])}`,
                  model: 'fixture-sdk',
                  input: { prompt: String(args[0]) },
                },
              });
              try {
                const output = await original.apply(thisArg, [...args]);
                await active.recorder.appendEvent(active.run.context([requested.event_id]), {
                  type: 'model.completed',
                  payload: { correlation_key: `fixture:${String(args[0])}`, output },
                });
                return output;
              } catch (error) {
                await active.recorder.appendEvent(active.run.context([requested.event_id]), {
                  type: 'model.failed',
                  payload: {
                    correlation_key: `fixture:${String(args[0])}`,
                    error: {
                      code: 'FIXTURE_SDK_FAILED',
                      message: error instanceof Error ? error.message : 'fixture failed',
                      retryable: false,
                      kind: 'model',
                    },
                    attempt: 1,
                  },
                });
                throw error;
              }
            })();
          });
        },
      },
    ],
  });
  const agent = instrument({
    snapshotDir: directory,
    runtime: { name: 'generic-fixture', version: '1.0.0' },
    model: { name: 'generic-client', call: (prompt: string) => client.create(prompt) },
    tools: {
      delegated: {
        sideEffect: 'read_only',
        call: (prompt: string) => client.create(prompt),
      },
    },
  });

  try {
    const result = await agent.run(
      { input: { goal: 'deduplicate' } },
      async ({ model, tools, checkpoint }) => {
        const modelResult = await model.call('model');
        const delegated = await tools.delegated('tool');
        await checkpoint({ modelResult, delegated });
        return { model: modelResult, delegated };
      },
    );
    assert.deepEqual(result, { model: 'sdk:model', delegated: 'sdk:tool' });
    assert.equal(client.calls, 2);

    const directories = await readdir(directory);
    assert.equal(directories.length, 1);
    const events = (await readFile(join(directory, directories[0]!, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const requestedModels = events.filter((event) => event.type === 'model.requested');
    assert.equal(requestedModels.length, 2);
    assert.deepEqual(
      requestedModels.map((event) => event.payload.model),
      ['generic-client', 'fixture-sdk'],
    );
    assert.equal(events.filter((event) => event.type === 'tool.requested').length, 1);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('drains tracked SDK work started but not awaited inside a generic tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const client = {
    async create(): Promise<string> {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return 'sdk result';
    },
  };
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    drainTimeoutMs: 100,
    integrations: [
      {
        name: 'tracked-generic-tool-sdk',
        install(api) {
          return patchMethod(client, 'create', ({ original, thisArg, args }) => {
            const active = api.currentRun();
            if (active === undefined) {
              return original.apply(thisArg, [...args]);
            }
            return api.track(
              (async () => {
                const requested = await active.recorder.appendEvent(active.run.context(), {
                  type: 'model.requested',
                  payload: {
                    correlation_key: 'tracked-generic-tool-sdk',
                    model: 'tracked-generic-tool-sdk',
                    input: {},
                  },
                });
                const output = await original.apply(thisArg, [...args]);
                await active.recorder.appendEvent(active.run.context([requested.event_id]), {
                  type: 'model.completed',
                  payload: { correlation_key: 'tracked-generic-tool-sdk', output },
                });
                return output;
              })(),
            );
          });
        },
      },
    ],
  });
  const agent = instrument({
    snapshotDir: directory,
    runtime: { name: 'generic-fixture', version: '1.0.0' },
    model: { name: 'unused-model', call: async () => 'unused' },
    tools: {
      startsSdk: {
        sideEffect: 'read_only',
        call: async () => {
          void client.create();
          return 'tool result';
        },
      },
    },
  });

  try {
    assert.equal(
      await agent.run({ input: { goal: 'drain nested SDK work' } }, ({ tools }) =>
        tools.startsSdk(),
      ),
      'tool result',
    );
    const snapshotDirectory = join(directory, (await readdir(directory))[0]!);
    const eventTypes = (await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.ok(eventTypes.includes('model.completed'));
    assert.ok(eventTypes.indexOf('model.completed') < eventTypes.indexOf('run.observed'));
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('joins generic wrappers to an existing telemetry run without creating a nested snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const telemetry = initInstrumentation({ snapshotDir: directory });
  const agent = instrument({
    snapshotDir: directory,
    runtime: { name: 'generic-fixture', version: '1.0.0' },
    model: { name: 'generic-model', call: async (prompt: string) => `model:${prompt}` },
    tools: {
      search: { sideEffect: 'read_only', call: async (query: string) => `tool:${query}` },
    },
  });

  try {
    const result = await telemetry.run({ input: { goal: 'join' } }, () =>
      agent.run({ input: { ignoredByJoinedRun: true } }, async ({ model, tools, checkpoint }) => {
        const answer = await model.call('join');
        const documents = await tools.search('join');
        await checkpoint({ answer, documents });
        return { answer, documents };
      }),
    );
    assert.deepEqual(result, { answer: 'model:join', documents: 'tool:join' });
    const directories = await readdir(directory);
    assert.equal(directories.length, 1);
    const events = (await readFile(join(directory, directories[0]!, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.deepEqual(events, [
      'run.started',
      'model.requested',
      'model.completed',
      'tool.requested',
      'tool.completed',
      'checkpoint.created',
      'run.observed',
    ]);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps an integration scoped to the controller that acquired it', async () => {
  const firstDirectory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-first-'));
  const secondDirectory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-second-'));
  let api: InstrumentationIntegrationApi | undefined;
  const integration = {
    name: 'controller-affinity-fixture',
    install(installedApi: InstrumentationIntegrationApi) {
      api = installedApi;
    },
  };
  const first = initInstrumentation({ snapshotDir: firstDirectory, integrations: [integration] });
  const second = initInstrumentation({ snapshotDir: secondDirectory });

  try {
    await second.run({}, () => {
      assert.equal(api?.currentRun(), undefined);
    });
    const snapshotDirectory = join(secondDirectory, (await readdir(secondDirectory))[0]!);
    const events = (await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.deepEqual(events, ['run.started', 'run.observed']);
  } finally {
    await first.shutdown();
    await second.shutdown();
    await rm(firstDirectory, { recursive: true, force: true });
    await rm(secondDirectory, { recursive: true, force: true });
  }
});

test('redacts generic event data when it joins an SDK run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const secret = 'sk-joined-run-secret-1234567890';
  const telemetry = initInstrumentation({ snapshotDir: directory });
  const agent = instrument({
    snapshotDir: directory,
    runtime: { name: 'generic-fixture', version: '1.0.0' },
    model: { name: 'generic-model', call: async (value: string) => value },
    tools: {},
  });

  try {
    await telemetry.run({}, () =>
      agent.run({ input: { goal: 'joined-redaction' } }, async ({ model, checkpoint }) => {
        const output = await model.call(secret);
        await checkpoint({ secret: output });
        return output;
      }),
    );
    const snapshotDirectory = join(directory, (await readdir(directory))[0]!);
    const events = await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8');
    assert.equal(events.includes(secret), false);
    assert.match(events, /REDACTED:api_key/u);
    const checkpointDirectory = join(snapshotDirectory, 'checkpoints');
    const checkpoint = await readFile(
      join(checkpointDirectory, (await readdir(checkpointDirectory))[0]!),
      'utf8',
    );
    assert.equal(checkpoint.includes(secret), false);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('drains tracked SDK calls that the telemetry callback does not await', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const client = {
    async create(): Promise<string> {
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      return 'late result';
    },
  };
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    drainTimeoutMs: 100,
    integrations: [
      {
        name: 'tracked-sdk-fixture',
        install(api) {
          return patchMethod(client, 'create', ({ original, thisArg, args }) => {
            const active = api.currentRun();
            if (active === undefined) {
              return original.apply(thisArg, [...args]);
            }
            return api.track(
              (async () => {
                const requested = await active.recorder.appendEvent(active.run.context(), {
                  type: 'model.requested',
                  payload: {
                    correlation_key: 'tracked-sdk-fixture',
                    model: 'tracked-sdk-fixture',
                    input: {},
                  },
                });
                const output = await original.apply(thisArg, [...args]);
                await active.recorder.appendEvent(active.run.context([requested.event_id]), {
                  type: 'model.completed',
                  payload: { correlation_key: 'tracked-sdk-fixture', output },
                });
                return output;
              })(),
            );
          });
        },
      },
    ],
  });

  try {
    await telemetry.run({}, () => {
      void client.create();
      return 'callback result';
    });
    const snapshotDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.deepEqual(events, ['run.started', 'model.requested', 'model.completed', 'run.observed']);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('drains a joined generic run that the telemetry callback does not await', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const telemetry = initInstrumentation({ snapshotDir: directory, drainTimeoutMs: 100 });
  const agent = instrument({
    snapshotDir: directory,
    runtime: { name: 'generic-fixture', version: '1.0.0' },
    model: {
      name: 'generic-model',
      call: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        return 'late result';
      },
    },
    tools: {},
  });

  try {
    await telemetry.run({}, () => {
      void agent.run({ input: { goal: 'joined-drain' } }, ({ model }) => model.call());
      return 'callback result';
    });
    const snapshotDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.deepEqual(events, ['run.started', 'model.requested', 'model.completed', 'run.observed']);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the run scope when ESM and CommonJS business modules load after initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const commonJsPath = join(directory, 'app.cjs');
  const esmPath = join(directory, 'app.mjs');
  await writeFile(commonJsPath, 'exports.call = (callback) => callback("cjs");\n');
  await writeFile(esmPath, 'export const call = (callback) => callback("esm");\n');

  let api: InstrumentationIntegrationApi | undefined;
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [
      {
        name: 'module-format-fixture',
        install(installedApi) {
          api = installedApi;
        },
      },
    ],
  });

  try {
    const require = createRequire(import.meta.url);
    const commonJs = require(commonJsPath) as {
      call(callback: (format: string) => string): string;
    };
    const esm = (await import(pathToFileURL(esmPath).href)) as {
      call(callback: (format: string) => string): string;
    };

    const formats = await telemetry.run({}, () => [
      commonJs.call((format) => `${format}:${api?.currentRun()?.run.runId !== undefined}`),
      esm.call((format) => `${format}:${api?.currentRun()?.run.runId !== undefined}`),
    ]);
    assert.deepEqual(formats, ['cjs:true', 'esm:true']);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('creates a partial SDK observation in an isolated async run scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  let api: InstrumentationIntegrationApi | undefined;
  const integration = {
    name: 'fixture-sdk',
    install(installedApi: InstrumentationIntegrationApi) {
      api = installedApi;
    },
  };
  const telemetry = initInstrumentation({ snapshotDir: directory, integrations: [integration] });

  try {
    const value = await telemetry.run({ input: { goal: 'record fixture' } }, async () => {
      const activeRun = api?.currentRun();
      assert.notEqual(activeRun, undefined);
      await activeRun!.recorder.appendEvent(activeRun!.run.context(), {
        type: 'model.requested',
        payload: {
          correlation_key: 'fixture-call',
          model: 'fixture-model',
          input: { goal: 'record fixture' },
        },
      });
      return 'business result';
    });

    assert.equal(value, 'business result');
    const children = await readdir(directory);
    assert.equal(children.length, 1);
    const snapshotDirectory = join(directory, children[0]!);
    const manifest = JSON.parse(
      await readFile(join(snapshotDirectory, 'manifest.json'), 'utf8'),
    ) as {
      source: string;
      completeness: string;
      terminal_status: string;
    };
    assert.equal(manifest.source, 'sdk');
    assert.equal(manifest.completeness, 'partial');
    assert.equal(manifest.terminal_status, 'unknown');
    const validation = await validateSnapshotDirectory(snapshotDirectory);
    assert.equal(validation.valid, true);
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('installs an integration once, suppresses duplicate capture, and restores it after shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  let installs = 0;
  let teardowns = 0;
  let api: InstrumentationIntegrationApi | undefined;
  const integration = {
    name: 'shared-fixture-sdk',
    install(installedApi: InstrumentationIntegrationApi) {
      installs += 1;
      api = installedApi;
      return () => {
        teardowns += 1;
      };
    },
  };
  const first = initInstrumentation({ snapshotDir: directory, integrations: [integration] });
  const second = initInstrumentation({ snapshotDir: directory, integrations: [integration] });

  try {
    assert.equal(installs, 1);
    await first.run({}, () => {
      assert.notEqual(api?.currentRun(), undefined);
      api?.withSuppression(() => {
        assert.equal(api?.isSuppressed(), true);
        assert.equal(api?.currentRun(), undefined);
      });
      assert.notEqual(api?.currentRun(), undefined);
    });
    await first.shutdown();
    assert.equal(teardowns, 0);
    await second.shutdown();
    assert.equal(teardowns, 1);
  } finally {
    await first.shutdown();
    await second.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('routes shared-integration diagnostics to live controllers instead of the first installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  let api: InstrumentationIntegrationApi | undefined;
  const integration = {
    name: 'shared-diagnostic-fixture',
    install(installedApi: InstrumentationIntegrationApi) {
      api = installedApi;
    },
  };
  const firstDiagnostics: string[] = [];
  const secondDiagnostics: string[] = [];
  const first = initInstrumentation({
    snapshotDir: directory,
    integrations: [integration],
    onDiagnostic: (diagnostic) => firstDiagnostics.push(diagnostic.code),
  });
  const second = initInstrumentation({
    snapshotDir: directory,
    integrations: [integration],
    onDiagnostic: (diagnostic) => secondDiagnostics.push(diagnostic.code),
  });

  try {
    assert.equal(api?.currentRun(), undefined);
    assert.deepEqual(firstDiagnostics, ['INTEGRATION_OUTSIDE_RUN']);
    assert.deepEqual(secondDiagnostics, ['INTEGRATION_OUTSIDE_RUN']);
    await first.shutdown();
    api?.reportDiagnostic({ code: 'RECORDING_SETUP_FAILED', message: 'fixture diagnostic' });
    assert.deepEqual(firstDiagnostics, ['INTEGRATION_OUTSIDE_RUN']);
    assert.deepEqual(secondDiagnostics, ['INTEGRATION_OUTSIDE_RUN', 'RECORDING_SETUP_FAILED']);
  } finally {
    await first.shutdown();
    await second.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports only one out-of-scope call per integration and preserves business failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-instrumentation-'));
  const diagnostics: string[] = [];
  let api: InstrumentationIntegrationApi | undefined;
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    integrations: [
      {
        name: 'scope-fixture-sdk',
        install(installedApi) {
          api = installedApi;
        },
      },
    ],
  });

  try {
    assert.equal(api?.currentRun(), undefined);
    assert.equal(api?.currentRun(), undefined);
    assert.deepEqual(diagnostics, ['INTEGRATION_OUTSIDE_RUN']);
    await assert.rejects(
      telemetry.run({}, () => {
        throw new Error('business error');
      }),
      /business error/u,
    );
  } finally {
    await telemetry.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
