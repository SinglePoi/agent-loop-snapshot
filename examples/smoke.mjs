/* global console */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runCli } from '@agent-loop-snapshot/cli';

import { run as runFunctionInstrumentation } from './function-instrumentation/demo.mjs';
import { run as runSdkInstrumentation } from './sdk-instrumentation/demo.mjs';

const output = await mkdtemp(join(tmpdir(), 'alsnap-examples-'));
try {
  await runFunctionInstrumentation(join(output, 'function-instrumentation'));
  await runSdkInstrumentation(join(output, 'sdk-instrumentation'));
  const exitCode = await runCli(
    [
      'import-otel',
      resolve('examples/otel-import/trace.json'),
      '--output',
      join(output, 'otel-import'),
    ],
    { stdout: () => undefined, stderr: () => undefined },
  );
  if (exitCode !== 0) throw new Error(`OTLP import example exited with ${String(exitCode)}.`);
} finally {
  await rm(output, { recursive: true, force: true });
}

console.log(
  'Offline examples passed: generic instrumentation, SDK instrumentation, and OTLP import.',
);
