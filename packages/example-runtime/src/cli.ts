#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  Recorder,
  SnapshotWriter,
  createDefaultRedactionPipeline,
} from '@agent-loop-snapshot/recorder';

import { createDefaultExampleTools, ExampleAgentRuntime } from './example-agent.js';
import { OpenAICompatibleModelAdapter } from './openai-compatible.js';

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The example runtime failed.';
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(' ').trim();
  if (!goal) {
    console.error('Usage: alsnap-example "your agent goal"');
    process.exitCode = 1;
    return;
  }

  const writer = await SnapshotWriter.open(
    resolve(process.env.ALS_SNAPSHOT_DIR ?? 'runs/example-run'),
  );
  try {
    const redaction = createDefaultRedactionPipeline();
    const recorder = new Recorder({
      interceptors: [redaction.asInterceptor(), writer.asInterceptor()],
    });
    const runtime = new ExampleAgentRuntime({
      recorder,
      model: OpenAICompatibleModelAdapter.fromEnv(),
      tools: createDefaultExampleTools(),
    });
    const result = await runtime.run({ goal });
    await writer.commit(result.manifest);
    console.log(
      JSON.stringify({
        run_id: result.run.runId,
        status: result.status,
        final_state_hash: result.finalStateHash,
        snapshot_directory: writer.snapshotDirectory,
      }),
    );
    if (result.status !== 'completed') {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(safeMessage(error));
    process.exitCode = 1;
  } finally {
    await writer.close();
  }
}

await main();
