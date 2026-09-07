/* global console, process */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function quoteWindowsCommandArgument(argument) {
  if (argument.includes('\0') || argument.includes('\r') || argument.includes('\n')) {
    throw new Error('Windows command arguments cannot contain NUL or line-break characters.');
  }
  return `"${argument.replaceAll(/(\\*)"/gu, '$1$1\\"').replaceAll(/(\\+)$/gu, '$1$1')}"`;
}

function windowsCommandLine(command, args) {
  return `"${[quoteWindowsCommandArgument(command), ...args.map(quoteWindowsCommandArgument)].join(' ')}"`;
}

/** Builds a pnpm invocation for npm's JS launcher, a native binary, or a Windows command launcher. */
export function resolvePnpmInvocation(options = {}) {
  const pnpmEntry = Object.hasOwn(options, 'pnpmEntry')
    ? options.pnpmEntry
    : process.env.npm_execpath;
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const commandShell = options.commandShell ?? process.env.ComSpec ?? 'cmd.exe';
  if (pnpmEntry !== undefined && pnpmEntry !== '') {
    const extension = extname(pnpmEntry).toLowerCase();
    if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
      return { command: nodeExecutable, argsPrefix: [pnpmEntry] };
    }
    if (extension === '.cmd' || extension === '.bat' || extension === '.ps1') {
      const command =
        extension === '.ps1'
          ? join(dirname(pnpmEntry), `${basename(pnpmEntry, extension)}.cmd`)
          : pnpmEntry;
      return {
        command: commandShell,
        argsPrefix: ['/d', '/s', '/c'],
        commandLauncher: command,
        windowsVerbatimArguments: true,
      };
    }
    return { command: pnpmEntry, argsPrefix: [] };
  }
  return platform === 'win32'
    ? {
        command: commandShell,
        argsPrefix: ['/d', '/s', '/c'],
        commandLauncher: 'pnpm.cmd',
        windowsVerbatimArguments: true,
      }
    : { command: 'pnpm', argsPrefix: [] };
}

export function composePnpmInvocation(invocation, args) {
  if (invocation.commandLauncher !== undefined) {
    return {
      command: invocation.command,
      args: [...invocation.argsPrefix, windowsCommandLine(invocation.commandLauncher, args)],
      windowsVerbatimArguments: true,
    };
  }
  return { command: invocation.command, args: [...invocation.argsPrefix, ...args] };
}

function runPnpm(args, cwd) {
  const invocation = composePnpmInvocation(resolvePnpmInvocation(), args);
  return run(invocation.command, invocation.args, cwd, {
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

function run(command, args, cwd, spawnOptions = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      ...spawnOptions,
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

export async function runReleaseSmoke() {
  const output = await mkdtemp(join(tmpdir(), 'alsnap-release-smoke-'));
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
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runReleaseSmoke();
}
