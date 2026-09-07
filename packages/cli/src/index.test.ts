import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      { code: 'SCHEMA_CONST', path: '/manifest/schema_version' },
      { code: 'SCHEMA_CONST', path: '/events/0/schema_version' },
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
