/* global console, fetch, process, setTimeout */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../packages/cli/dist/index.js';
import { initInstrumentation, instrument } from '../packages/instrumentation/dist/index.js';
import { createOtlpExporter, dryRunOtlpExport } from '../packages/otel-export/dist/index.js';
import { loadTraceSnapshot } from '../packages/trace/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Linux amd64 manifest for the 0.114.0 release. Overrides must also be digest-pinned.
const defaultCollectorImage =
  'otel/opentelemetry-collector-contrib:0.114.0@sha256:43168fa5acb6989f40e8a2493275e30a62df8ee3f3dde1ba15c906cb8c9f3fb9';
const collectorImage = process.env.OTEL_COLLECTOR_IMAGE ?? defaultCollectorImage;

function dockerAvailable() {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
  return address.port;
}

function runDocker(args) {
  const child = spawn('docker', args, { stdio: 'inherit' });
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docker ${args.join(' ')} exited with ${String(code)}.`));
    });
  });
}

async function waitForCollector(endpoint) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { method: 'POST', body: '{}' });
      if (response.status >= 400) return;
    } catch {
      // The OTLP receiver has not bound its port yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error('Timed out waiting for the OpenTelemetry Collector HTTP receiver.');
}

function receivedSpans(contents) {
  return contents
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => JSON.parse(line).resourceSpans)
    .flatMap((resourceSpans) => resourceSpans.scopeSpans)
    .flatMap((scopeSpans) => scopeSpans.spans);
}

async function waitForDecodedOutput(traceFile, expectedSpanCount) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const spans = receivedSpans(await readFile(traceFile, 'utf8'));
      if (spans.length >= expectedSpanCount) return spans;
    } catch {
      // The file exporter may still be flushing, or has not completed a JSON line.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Collector file exporter did not persist ${String(expectedSpanCount)} spans.`);
}

async function exportInput(directory) {
  const snapshot = await loadTraceSnapshot(directory);
  assert.equal(snapshot.valid, true, `Sanitized fixture ${directory} must be valid.`);
  assert.ok(snapshot.manifest !== undefined);
  return { manifest: snapshot.manifest, events: snapshot.events };
}

async function run() {
  if (!dockerAvailable()) {
    throw new Error(
      'Docker daemon is required for Collector verification. Start Docker Desktop, then run pnpm run collector:verify. This local fault/recovery check is intentionally separate from offline tests.',
    );
  }
  if (!collectorImage.includes('@sha256:')) {
    throw new Error('OTEL_COLLECTOR_IMAGE must be a digest-pinned image reference.');
  }

  const temporary = await mkdtemp(join(tmpdir(), 'alsnap-collector-e2e-'));
  const container = `alsnap-collector-${process.pid}-${Date.now()}`;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${String(port)}/v1/traces`;
  const config = join(temporary, 'export.json');
  const queueDir = join(temporary, 'queue');
  const outputDir = join(temporary, 'collector-output');
  const collectorConfig = resolve(root, 'examples/otel-export/collector-config.yaml');
  const fixtureDirectories = [
    resolve(root, 'packages/example-runtime/fixtures/example-run'),
    resolve(root, 'packages/schema/fixtures/tool-failure-retry'),
    resolve(root, 'packages/schema/fixtures/parallel-calls'),
  ];
  try {
    await mkdir(outputDir);
    const queuedConfig = {
      targetAlias: 'collector-e2e',
      endpoint,
      serviceName: 'collector-e2e-cli',
      queueDir,
      // Force an intentional local capacity fault before any transport attempt.
      queueMaxBytes: 1,
      timeoutMs: 200,
      retryMaxAttempts: 1,
      retryBudgetMs: 200,
    };
    await writeFile(config, `${JSON.stringify(queuedConfig, null, 2)}\n`);
    for (const fixture of fixtureDirectories) {
      const queuedExit = await runCli(['export-otel', fixture, '--config', config, '--json'], {
        stdout: () => undefined,
        stderr: () => undefined,
      });
      assert.equal(queuedExit, 1, 'Blocked delivery must be a runtime failure, not accepted data.');
    }

    await runDocker([
      'run', '--detach', '--rm', '--name', container,
      '--publish', `127.0.0.1:${String(port)}:4318`,
      '--mount', `type=bind,source=${collectorConfig},target=/etc/otelcol-contrib/config.yaml,readonly`,
      '--mount', `type=bind,source=${outputDir},target=/output`,
      collectorImage, '--config=/etc/otelcol-contrib/config.yaml',
    ]);
    await waitForCollector(endpoint);
    await writeFile(
      config,
      `${JSON.stringify({ ...queuedConfig, queueMaxBytes: 5 * 1024 * 1024 }, null, 2)}\n`,
    );
    const resumedOutput = [];
    const resumedExit = await runCli(['export-otel', '--resume', '--config', config, '--json'], {
      stdout: (text) => resumedOutput.push(text),
      stderr: (text) => resumedOutput.push(text),
    });
    assert.equal(resumedExit, 0, resumedOutput.join(''));

    const telemetry = initInstrumentation({
      snapshotDir: join(temporary, 'sdk-runs'),
      exporters: [
        createOtlpExporter({
          targetAlias: 'collector-e2e-sdk', endpoint, serviceName: 'collector-e2e-sdk',
          queueDir: join(temporary, 'sdk-queue'), retryMaxAttempts: 1, retryBudgetMs: 1_000,
        }),
      ],
    });
    try {
      assert.equal(await telemetry.run({}, () => 'business result'), 'business result');
    } finally {
      await telemetry.shutdown();
    }
    const failedAgent = instrument({
      snapshotDir: join(temporary, 'failed-runs'),
      runtime: { name: 'collector-e2e', version: '1.0.0' },
      model: {
        name: 'sanitized-failure-model',
        call: async () => {
          throw new Error('Sanitized model failure for Collector verification.');
        },
      },
      tools: {},
      exporters: [
        createOtlpExporter({
          targetAlias: 'collector-e2e-model-failure',
          endpoint,
          serviceName: 'collector-e2e-model-failure',
          queueDir: join(temporary, 'model-failure-queue'),
          retryMaxAttempts: 1,
          retryBudgetMs: 1_000,
        }),
      ],
    });
    try {
      await assert.rejects(
        failedAgent.run({}, ({ model }) => model.call({ goal: 'sanitized failure fixture' })),
        /Sanitized model failure/u,
      );
    } finally {
      await failedAgent.shutdown();
    }

    const expectedSpans = (await Promise.all(fixtureDirectories.map(exportInput))).flatMap((input) =>
      dryRunOtlpExport(input, { serviceName: 'collector-e2e-cli' }).mapping.spans,
    );
    const spans = await waitForDecodedOutput(join(outputDir, 'traces.json'), expectedSpans.length + 3);
    const byId = new Map(spans.map((span) => [`${span.traceId}:${span.spanId}`, span]));
    for (const span of expectedSpans) {
      const received = byId.get(`${span.traceId}:${span.spanId}`);
      assert.ok(received, `Collector missed expected span ${span.name}.`);
      assert.equal(received.name, span.name);
      assert.equal(received.startTimeUnixNano, span.startTimeUnixNano);
      assert.equal(received.endTimeUnixNano, span.endTimeUnixNano);
      assert.equal(received.status.code, span.status === 'OK' ? 1 : span.status === 'ERROR' ? 2 : 0);
      assert.deepEqual(received.links ?? [], span.links);
    }
    const attributes = spans.flatMap((span) => span.attributes ?? []).map((attribute) => attribute.key);
    assert.ok(spans.some((span) => span.name === 'agent.run'));
    assert.ok(spans.some((span) => span.name === 'model.call'));
    assert.ok(spans.some((span) => span.name === 'model.call' && span.status.code === 2));
    assert.ok(spans.some((span) => span.name === 'tool.call' && span.status.code === 2));
    assert.ok(spans.some((span) => (span.links?.length ?? 0) > 0));
    assert.ok(attributes.includes('agent_loop_snapshot.source'));
    assert.ok(attributes.includes('agent_loop_snapshot.completeness'));
  } finally {
    await runDocker(['rm', '--force', container]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

await run();
console.log(`Collector E2E passed with ${collectorImage}: decoded CLI recovery, retry/parallel/link fidelity, and SDK delivery.`);
