/* global console, process */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { instrument } from '@agent-loop-snapshot/instrumentation';

export async function run(snapshotDirOverride) {
  const snapshotDir =
    snapshotDirOverride ??
    process.env.ALS_SNAPSHOT_DIR ??
    (await mkdtemp(join(tmpdir(), 'alsnap-generic-')));
  const agent = instrument({
    snapshotDir,
    runtime: { name: 'offline-function-example', version: '1.0.0' },
    model: {
      name: 'offline-model',
      call: async (prompt) => `model:${prompt}`,
    },
    tools: {
      lookup: {
        sideEffect: 'read_only',
        call: async (query) => [`document for ${query}`],
      },
    },
  });
  const result = await agent.run({ input: { goal: 'summarize local data' } }, async (context) => {
    const query = await context.model.call('find the local document');
    const documents = await context.tools.lookup(query);
    await context.checkpoint({ query, documents });
    return context.model.call(documents.join('\n'));
  });
  return { result, snapshotDir };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));
if (isMain) {
  const result = await run();
  console.log(`Result: ${result.result}`);
  console.log(`Snapshots: ${result.snapshotDir}`);
}
