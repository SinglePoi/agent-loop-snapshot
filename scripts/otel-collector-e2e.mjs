/* global console, fetch, process, setTimeout */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../packages/cli/dist/index.js';
import { initInstrumentation } from '../packages/instrumentation/dist/index.js';
import { createOtlpExporter } from '../packages/otel-export/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const collectorImage =
  process.env.OTEL_COLLECTOR_IMAGE ?? 'otel/opentelemetry-collector-contrib:0.114.0';

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return result.status === 0;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const { port } = address;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
  return port;
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

async function run() {
  if (!dockerAvailable()) {
    throw new Error(
      'Docker daemon is required for Collector verification. Start Docker Desktop, then run pnpm run collector:verify.',
    );
  }

  const temporary = await mkdtemp(join(tmpdir(), 'alsnap-collector-e2e-'));
  const container = `alsnap-collector-${process.pid}-${Date.now()}`;
  const port = await unusedPort();
  const endpoint = `http://127.0.0.1:${String(port)}/v1/traces`;
  const config = join(temporary, 'export.json');
  const queueDir = join(temporary, 'queue');
  const outputDir = join(temporary, 'collector-output');
  const collectorConfig = resolve(root, 'examples/otel-export/collector-config.yaml');
  try {
    await mkdir(outputDir);
    await writeFile(
      config,
      `${JSON.stringify(
        {
          targetAlias: 'collector-e2e',
          endpoint,
          serviceName: 'collector-e2e-cli',
          queueDir,
          timeoutMs: 200,
          retryMaxAttempts: 1,
          retryBudgetMs: 200,
        },
        null,
        2,
      )}\n`,
    );

    // First queue a CLI export while no receiver exists. This proves --resume
    // sends the persisted filtered request, rather than rerunning any business work.
    const queuedExit = await runCli(
      [
        'export-otel',
        resolve(root, 'packages/example-runtime/fixtures/example-run'),
        '--config',
        config,
        '--json',
      ],
      { stdout: () => undefined, stderr: () => undefined },
    );
    assert.equal(queuedExit, 2);

    await runDocker([
      'run',
      '--detach',
      '--rm',
      '--name',
      container,
      '--publish',
      `127.0.0.1:${String(port)}:4318`,
      '--mount',
      `type=bind,source=${collectorConfig},target=/etc/otelcol-contrib/config.yaml,readonly`,
      '--mount',
      `type=bind,source=${outputDir},target=/output`,
      collectorImage,
      '--config=/etc/otelcol-contrib/config.yaml',
    ]);
    await waitForCollector(endpoint);

    const resumedOutput = [];
    const resumedExit = await runCli(['export-otel', '--resume', '--config', config, '--json'], {
      stdout: (text) => resumedOutput.push(text),
      stderr: (text) => resumedOutput.push(text),
    });
    assert.equal(resumedExit, 0, resumedOutput.join(''));

    const sdkExporter = createOtlpExporter({
      targetAlias: 'collector-e2e-sdk',
      endpoint,
      serviceName: 'collector-e2e-sdk',
      queueDir: join(temporary, 'sdk-queue'),
      retryMaxAttempts: 1,
      retryBudgetMs: 1_000,
    });
    const telemetry = initInstrumentation({
      snapshotDir: join(temporary, 'sdk-runs'),
      exporters: [sdkExporter],
    });
    try {
      assert.equal(await telemetry.run({}, () => 'business result'), 'business result');
    } finally {
      await telemetry.shutdown();
    }

    // The file exporter flushes asynchronously after the receiver accepted
    // the request, so allow it a short bounded window to write both traces.
    const traceFile = join(outputDir, 'traces.json');
    let contents = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        contents = await readFile(traceFile, 'utf8');
        if (contents.includes('collector-e2e-cli') && contents.includes('collector-e2e-sdk')) break;
      } catch {
        // The file exporter has not created its output yet.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    assert.match(contents, /collector-e2e-cli/u);
    assert.match(contents, /collector-e2e-sdk/u);
  } finally {
    await runDocker(['rm', '--force', container]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

await run();
console.log(`Collector E2E passed with ${collectorImage}: CLI resume and SDK automatic export were received.`);
