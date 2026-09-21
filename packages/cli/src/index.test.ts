import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { cliExitCodes, runCli, type CliIo } from './index.js';

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../example-runtime/fixtures/example-run',
);
const invalidFixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../schema/fixtures/unknown-version',
);
const mermaidGolden = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../golden/parallel-calls.causal-dag.mmd',
);

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

test('CLI executes through the workspace symlink', async () => {
  const missingDirectory = await mkdtemp(join(tmpdir(), 'alsnap-missing-'));
  await rm(missingDirectory, { recursive: true, force: true });
  const cliEntry = resolve(
    process.cwd(),
    'node_modules',
    '@agent-loop-snapshot',
    'cli',
    'dist',
    'index.js',
  );

  assert.equal(existsSync(cliEntry), true);
  const result = spawnSync(process.execPath, [cliEntry, 'validate', missingDirectory, '--json'], {
    encoding: 'utf8',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, cliExitCodes.validationFailed);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout) as {
    command: string;
    directory: string;
    valid: boolean;
    diagnostics: unknown[];
  };
  assert.equal(output.command, 'validate');
  assert.equal(output.directory, missingDirectory);
  assert.equal(output.valid, false);
  assert.ok(output.diagnostics.length > 0);
});

test('validate emits stable JSON and succeeds for the golden snapshot', async () => {
  const captured = captureIo();
  const exitCode = await runCli(['validate', fixtureDirectory, '--json'], captured.io);

  assert.equal(exitCode, cliExitCodes.success);
  assert.equal(captured.stderr.length, 0);
  const output = JSON.parse(captured.stdout.join('')) as {
    command: string;
    valid: boolean;
    diagnostics: unknown[];
  };
  assert.deepEqual(output, {
    command: 'validate',
    directory: fixtureDirectory,
    valid: true,
    diagnostics: [],
  });
});

test('export-otel dry-run maps a valid snapshot without queueing or contacting a target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-export-config-'));
  const config = join(root, 'export.json');
  try {
    await writeFile(
      config,
      JSON.stringify({
        targetAlias: 'fixture',
        endpoint: 'http://127.0.0.1:4318/v1/traces',
        serviceName: 'cli-fixture',
      }),
    );
    const captured = captureIo();
    const exitCode = await runCli(
      ['export-otel', fixtureDirectory, '--config', config, '--dry-run', '--json'],
      captured.io,
    );
    assert.equal(exitCode, cliExitCodes.success);
    const output = JSON.parse(captured.stdout.join('')) as {
      command: string;
      dry_run: boolean;
      target_alias: string;
      delivery: { state: string; attempted: boolean };
    };
    assert.equal(output.command, 'export-otel');
    assert.equal(output.dry_run, true);
    assert.equal(output.target_alias, 'fixture');
    assert.equal(output.delivery.state, 'dry_run');
    assert.equal(output.delivery.attempted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('export-otel sends a local snapshot through its configured queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-export-cli-'));
  const server = createServer((request, response) => {
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  try {
    const config = join(root, 'export.json');
    await writeFile(
      config,
      JSON.stringify({
        targetAlias: 'fixture',
        endpoint: `http://127.0.0.1:${String(address.port)}/v1/traces`,
        serviceName: 'cli-fixture',
        queueDir: join(root, 'queue'),
      }),
    );
    const captured = captureIo();
    const exitCode = await runCli(
      ['export-otel', fixtureDirectory, '--config', config, '--json'],
      captured.io,
    );
    assert.equal(exitCode, cliExitCodes.success);
    const output = JSON.parse(captured.stdout.join('')) as {
      valid: boolean;
      queued: { state: string };
      flush: { pendingCount: number; deliveries: Array<{ state: string }> };
    };
    assert.equal(output.valid, true);
    assert.equal(output.queued.state, 'pending');
    assert.equal(output.flush.pendingCount, 0);
    assert.ok(output.flush.deliveries.length > 0);
    assert.ok(output.flush.deliveries.every((delivery) => delivery.state === 'accepted'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('export-otel resume only recovers intent from its configured queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-export-resume-cli-'));
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  try {
    const config = join(root, 'export.json');
    const base = {
      targetAlias: 'fixture',
      endpoint: `http://127.0.0.1:${String(address.port)}/v1/traces`,
      serviceName: 'cli-fixture',
      queueDir: join(root, 'queue'),
    };
    await writeFile(config, JSON.stringify({ ...base, queueMaxBytes: 1 }));
    assert.equal(
      await runCli(['export-otel', fixtureDirectory, '--config', config, '--json'], captureIo().io),
      cliExitCodes.runtimeError,
    );
    assert.equal(requests, 0);

    await writeFile(config, JSON.stringify(base));
    const captured = captureIo();
    const exitCode = await runCli(
      ['export-otel', '--resume', '--config', config, '--json'],
      captured.io,
    );
    assert.equal(exitCode, cliExitCodes.success);
    const output = JSON.parse(captured.stdout.join('')) as {
      resumed: boolean;
      deliveries: Array<{ batches: unknown[] }>;
      valid: boolean;
    };
    assert.equal(output.resumed, true);
    assert.equal(output.valid, true);
    assert.equal(output.deliveries.length, 1);
    assert.ok((output.deliveries[0]?.batches.length ?? 0) > 0);
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('validate returns exit code 2 and structured diagnostics for an invalid snapshot', async () => {
  const captured = captureIo();
  const exitCode = await runCli(['validate', invalidFixtureDirectory, '--json'], captured.io);

  assert.equal(exitCode, cliExitCodes.validationFailed);
  const output = JSON.parse(captured.stdout.join('')) as {
    valid: boolean;
    diagnostics: Array<{ code: string; path: string }>;
  };
  assert.equal(output.valid, false);
  assert.deepEqual(
    output.diagnostics.map(({ code, path }) => ({ code, path })),
    [
      { code: 'SCHEMA_ENUM', path: '/manifest/schema_version' },
      { code: 'SCHEMA_ENUM', path: '/events/0/schema_version' },
    ],
  );
});

test('inspect reports metadata and does not print event payload values', async () => {
  const captured = captureIo();
  const exitCode = await runCli(['inspect', fixtureDirectory], captured.io);
  const output = captured.stdout.join('');

  assert.equal(exitCode, cliExitCodes.success);
  assert.match(output, /Events: 15/);
  assert.match(output, /Model calls: 1/);
  assert.match(output, /Tool calls: 3/);
  assert.match(output, /Failures: 1/);
  assert.match(output, /Duration: 15000 ms/);
  assert.match(output, /TEMPORARY_TOOL_FAILURE/);
  assert.doesNotMatch(output, /summarize fixture|example answer/);
});

test('graph supports Mermaid and machine-readable filtered output', async () => {
  const mermaid = captureIo();
  const mermaidExitCode = await runCli(['graph', fixtureDirectory], mermaid.io);

  assert.equal(mermaidExitCode, cliExitCodes.success);
  assert.equal(mermaid.stderr.length, 0);
  assert.match(mermaid.stdout.join(''), /^flowchart TD\n/);
  assert.match(mermaid.stdout.join(''), /node_1\["run\.started \[/);
  assert.doesNotMatch(mermaid.stdout.join(''), /summarize fixture|example answer/);

  const json = captureIo();
  const jsonExitCode = await runCli(
    ['graph', fixtureDirectory, '--format', 'json', '--type', 'tool.completed'],
    json.io,
  );
  const output = JSON.parse(json.stdout.join('')) as {
    valid: boolean;
    projection: string;
    graph: { nodes: Array<{ type: string }> };
  };

  assert.equal(jsonExitCode, cliExitCodes.success);
  assert.equal(output.valid, true);
  assert.equal(output.projection, 'causal-dag');
  assert.deepEqual(
    output.graph.nodes.map((node) => node.type),
    ['tool.completed', 'tool.completed'],
  );
});

test('graph Mermaid output matches the stable golden document', async () => {
  const captured = captureIo();
  const expected = await readFile(mermaidGolden, 'utf8');
  const exitCode = await runCli(
    ['graph', resolve(dirname(fixtureDirectory), '../../schema/fixtures/parallel-calls')],
    captured.io,
  );

  assert.equal(exitCode, cliExitCodes.success);
  assert.equal(
    captured.stdout.join('').replaceAll('\r\n', '\n'),
    expected.replaceAll('\r\n', '\n'),
  );
  assert.equal(captured.stderr.length, 0);
});

test('replay creates a valid mock replay snapshot', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'alsnap-cli-replay-'));
  await rm(outputDirectory, { recursive: true, force: true });
  const captured = captureIo();

  try {
    const exitCode = await runCli(
      ['replay', fixtureDirectory, '--mode', 'mock', '--output', outputDirectory, '--json'],
      captured.io,
    );
    const output = JSON.parse(captured.stdout.join('')) as {
      command: string;
      valid: boolean;
      terminal_status: string;
      output_directory: string;
    };

    assert.equal(exitCode, cliExitCodes.success);
    assert.equal(captured.stderr.length, 0);
    assert.deepEqual(output, {
      command: 'replay',
      valid: true,
      terminal_status: 'completed',
      output_directory: outputDirectory,
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('CLI replay refuses a valid observation-only snapshot before creating output', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'alsnap-observation-cli-'));
  const source = join(temporaryRoot, 'source');
  const output = join(temporaryRoot, 'output');
  try {
    await mkdir(source);
    const manifest = JSON.parse(
      await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const events = (await readFile(join(fixtureDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => ({ ...JSON.parse(line), schema_version: '0.2.0' }));
    await writeFile(
      join(source, 'manifest.json'),
      `${JSON.stringify(
        {
          ...manifest,
          schema_version: '0.2.0',
          source: 'otel-import',
          completeness: 'complete',
          limitations: [],
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(source, 'events.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );

    const captured = captureIo();
    const exitCode = await runCli(
      ['replay', source, '--mode', 'mock', '--output', output, '--json'],
      captured.io,
    );
    const response = JSON.parse(captured.stdout.join('')) as {
      diagnostics: Array<{ code: string }>;
    };

    assert.equal(exitCode, cliExitCodes.validationFailed);
    assert.equal(response.diagnostics[0]?.code, 'SOURCE_TRACE_OBSERVATION_ONLY');
    assert.equal(existsSync(output), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('import-otel merges files into redacted observation-only snapshots that can be viewed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-import-otel-'));
  const firstInput = join(root, 'first.json');
  const secondInput = join(root, 'second.json');
  const outputDirectory = join(root, 'imported');
  const traceId = '11111111111111111111111111111111';
  const rootSpanId = '2222222222222222';
  const childSpanId = '3333333333333333';
  try {
    await writeFile(
      firstInput,
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: 'service.name', value: { stringValue: 'fixture-service' } }],
            },
            scopeSpans: [
              {
                scope: { name: 'first-fixture' },
                spans: [
                  {
                    traceId,
                    spanId: rootSpanId,
                    name: 'root',
                    startTimeUnixNano: '1700000000000000000',
                    endTimeUnixNano: '1700000001000000000',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    await writeFile(
      secondInput,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                scope: { name: 'second-fixture' },
                spans: [
                  {
                    traceId,
                    spanId: childSpanId,
                    parentSpanId: rootSpanId,
                    name: 'child',
                    startTimeUnixNano: '1700000000100000000',
                    attributes: [
                      { key: 'api_key', value: { stringValue: 'plain-fixture-secret' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const captured = captureIo();
    const exitCode = await runCli(
      ['import-otel', firstInput, secondInput, '--output', outputDirectory, '--json'],
      captured.io,
    );
    const response = JSON.parse(captured.stdout.join('')) as {
      valid: boolean;
      snapshots: Array<{ directory: string; source_trace_id: string; imported_span_count: number }>;
    };
    assert.equal(exitCode, cliExitCodes.success);
    assert.equal(response.valid, true);
    assert.deepEqual(
      response.snapshots.map((snapshot) => snapshot.source_trace_id),
      [traceId],
    );
    assert.equal(response.snapshots[0]?.imported_span_count, 2);
    const snapshotDirectory = response.snapshots[0]!.directory;
    const persisted = await readFile(join(snapshotDirectory, 'events.jsonl'), 'utf8');
    assert.doesNotMatch(persisted, /plain-fixture-secret/);
    assert.match(persisted, /REDACTED:secret:ref_/);

    const inspect = captureIo();
    const inspectExitCode = await runCli(['inspect', snapshotDirectory, '--json'], inspect.io);
    const inspection = JSON.parse(inspect.stdout.join('')) as {
      valid: boolean;
      summary: { source: string; execution_eligibility: string; event_count: number };
    };
    assert.equal(inspectExitCode, cliExitCodes.success);
    assert.equal(inspection.valid, true);
    assert.equal(inspection.summary.source, 'otel-import');
    assert.equal(inspection.summary.execution_eligibility, 'observation_only');
    assert.equal(inspection.summary.event_count, 4);

    const replay = captureIo();
    const replayOutput = join(root, 'replay');
    const replayExitCode = await runCli(
      ['replay', snapshotDirectory, '--mode', 'mock', '--output', replayOutput, '--json'],
      replay.io,
    );
    assert.equal(replayExitCode, cliExitCodes.validationFailed);
    assert.equal(
      (JSON.parse(replay.stdout.join('')) as { diagnostics: Array<{ code: string }> })
        .diagnostics[0]?.code,
      'SOURCE_TRACE_OBSERVATION_ONLY',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('import-otel requires input files and never overwrites an imported trace directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-import-otel-existing-'));
  const input = join(root, 'trace.json');
  const output = join(root, 'output');
  try {
    const missing = captureIo();
    const missingExitCode = await runCli(['import-otel', '--output', output, '--json'], missing.io);
    assert.equal(missingExitCode, cliExitCodes.runtimeError);
    assert.equal(
      (JSON.parse(missing.stdout.join('')) as { error: { code: string } }).error.code,
      'CLI_USAGE_ERROR',
    );

    await writeFile(
      input,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    spanId: 'bbbbbbbbbbbbbbbb',
                    name: 'first',
                    startTimeUnixNano: '1',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.equal(
      await runCli(['import-otel', input, '--output', output], captureIo().io),
      cliExitCodes.success,
    );
    const duplicate = captureIo();
    assert.equal(
      await runCli(['import-otel', input, '--output', output, '--json'], duplicate.io),
      cliExitCodes.runtimeError,
    );
    assert.match(duplicate.stdout.join(''), /Refusing to overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI usage errors use exit code 1 and JSON error output', async () => {
  const captured = captureIo();
  const exitCode = await runCli(
    ['graph', fixtureDirectory, '--min-sequence', '8', '--max-sequence', '2', '--json'],
    captured.io,
  );

  assert.equal(exitCode, cliExitCodes.runtimeError);
  assert.deepEqual(JSON.parse(captured.stdout.join('')), {
    command: 'graph',
    error: {
      code: 'CLI_USAGE_ERROR',
      message: '--min-sequence cannot be greater than --max-sequence.',
    },
  });
});
