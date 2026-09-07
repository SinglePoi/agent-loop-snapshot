/* global console, process */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(tmpdir(), 'alsnap-release-smoke-'));
const pnpmEntry = process.env.npm_execpath;
const pnpmCommand =
  pnpmEntry === undefined
    ? process.platform === 'win32'
      ? join(dirname(process.execPath), 'node_modules', 'pnpm', 'pnpm.exe')
      : 'pnpm'
    : process.execPath;

function runPnpm(args, cwd) {
  return run(pnpmCommand, [...(pnpmEntry === undefined ? [] : [pnpmEntry]), ...args], cwd);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}.`));
      }
    });
  });
}

try {
  const tarballs = join(output, 'tarballs');
  const consumer = join(output, 'consumer');
  await mkdir(tarballs, { recursive: true });
  await mkdir(consumer, { recursive: true });
  await runPnpm(['-r', '--filter', './packages/*', 'pack', '--pack-destination', tarballs], root);
  const packageFile = (name) => `file:../tarballs/${name}-0.1.0.tgz`;
  const localPackages = {
    '@agent-loop-snapshot/cli': packageFile('agent-loop-snapshot-cli'),
    '@agent-loop-snapshot/example-runtime': packageFile('agent-loop-snapshot-example-runtime'),
    '@agent-loop-snapshot/graph': packageFile('agent-loop-snapshot-graph'),
    '@agent-loop-snapshot/recorder': packageFile('agent-loop-snapshot-recorder'),
    '@agent-loop-snapshot/replay': packageFile('agent-loop-snapshot-replay'),
    '@agent-loop-snapshot/schema': packageFile('agent-loop-snapshot-schema'),
    '@agent-loop-snapshot/trace': packageFile('agent-loop-snapshot-trace'),
  };
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify(
      {
        name: 'alsnap-release-smoke',
        private: true,
        type: 'module',
        dependencies: localPackages,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(consumer, 'pnpm-workspace.yaml'),
    `overrides:\n${Object.entries(localPackages)
      .map(([name, source]) => `  '${name}': ${source}`)
      .join('\n')}\n`,
  );
  await runPnpm(['install', '--ignore-scripts'], consumer);

  await writeFile(
    join(consumer, 'smoke.mjs'),
    `import { runCli } from '@agent-loop-snapshot/cli';\n
const [fixture, output] = process.argv.slice(2);\n
if (fixture === undefined || output === undefined) {\n  throw new Error('Fixture and output paths are required.');\n}\n
const io = { stdout: () => undefined, stderr: () => undefined };\n
const results = await Promise.all([\n  runCli(['validate', fixture], io),\n  runCli(['graph', fixture, '--format', 'mermaid'], io),\n  runCli(['replay', fixture, '--mode', 'mock', '--output', output], io),\n]);\n
if (results.some((result) => result !== 0)) {\n  throw new Error(\`Installed CLI smoke failed: \${results.join(', ')}.\`);\n}\n`,
  );

  const fixture = join(
    consumer,
    'node_modules',
    '@agent-loop-snapshot',
    'example-runtime',
    'fixtures',
    'example-run',
  );
  await run(
    process.execPath,
    [join(consumer, 'smoke.mjs'), fixture, join(consumer, 'mock-replay')],
    consumer,
  );
  console.log(
    'Release smoke passed: packed packages installed cleanly, then validate, graph, and Mock Replay completed.',
  );
} finally {
  await rm(output, { recursive: true, force: true });
}
