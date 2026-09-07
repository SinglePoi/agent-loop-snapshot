import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { composePnpmInvocation, resolvePnpmInvocation } from './release-smoke.js';

test('uses Node for a JavaScript pnpm launcher without splitting paths containing spaces', () => {
  const pnpmEntry = String.raw`C:\Program Files\pnpm\pnpm.cjs`;
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;

  assert.deepEqual(resolvePnpmInvocation({ pnpmEntry, nodeExecutable }), {
    command: nodeExecutable,
    argsPrefix: [pnpmEntry],
  });
});

test('executes a native pnpm binary directly without using Node as a launcher', () => {
  const pnpmEntry = String.raw`C:\Program Files\pnpm\pnpm.exe`;

  assert.deepEqual(resolvePnpmInvocation({ pnpmEntry }), {
    command: pnpmEntry,
    argsPrefix: [],
  });
});

test('falls back to the platform pnpm command when npm_execpath is absent or empty', () => {
  assert.deepEqual(resolvePnpmInvocation({ pnpmEntry: undefined, platform: 'linux' }), {
    command: 'pnpm',
    argsPrefix: [],
  });
  assert.deepEqual(
    resolvePnpmInvocation({
      pnpmEntry: '',
      platform: 'win32',
      commandShell: String.raw`C:\Windows\System32\cmd.exe`,
    }),
    {
      command: String.raw`C:\Windows\System32\cmd.exe`,
      argsPrefix: ['/d', '/s', '/c'],
      commandLauncher: 'pnpm.cmd',
      windowsVerbatimArguments: true,
    },
  );
});

test('uses the Windows command processor for a pnpm command launcher', () => {
  const pnpmEntry = String.raw`C:\Program Files\nodejs\pnpm.cmd`;

  assert.deepEqual(resolvePnpmInvocation({ pnpmEntry, commandShell: 'cmd.exe' }), {
    command: 'cmd.exe',
    argsPrefix: ['/d', '/s', '/c'],
    commandLauncher: pnpmEntry,
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(
    composePnpmInvocation(resolvePnpmInvocation({ pnpmEntry, commandShell: 'cmd.exe' }), [
      '--version',
    ]),
    {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `""${pnpmEntry}" "--version""`],
      windowsVerbatimArguments: true,
    },
  );
});

test(
  'executes a command launcher from a path with spaces and preserves arguments with spaces',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'alsnap command launcher '));
    const launcher = join(directory, 'pnpm test launcher.cmd');
    const receivedArguments = join(directory, 'received arguments.txt');
    try {
      await writeFile(
        launcher,
        '@echo off\r\nsetlocal DisableDelayedExpansion\r\n(\r\necho %~1\r\necho %~2\r\n) > "%~dp0received arguments.txt"\r\n',
      );
      const invocation = composePnpmInvocation(
        resolvePnpmInvocation({ pnpmEntry: launcher, commandShell: 'cmd.exe' }),
        ['--workspace', join(directory, 'consumer with spaces')],
      );
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: directory,
        encoding: 'utf8',
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        await readFile(receivedArguments, 'utf8'),
        `--workspace\r\n${join(directory, 'consumer with spaces')}\r\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
