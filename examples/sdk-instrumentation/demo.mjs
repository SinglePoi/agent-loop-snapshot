/* global console, process */

import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initInstrumentation } from '@agent-loop-snapshot/instrumentation';
import { openAIIntegration } from '@agent-loop-snapshot/instrumentation-openai';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function run(snapshotDirOverride) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        id: 'offline-chat',
        object: 'chat.completion',
        model: 'offline-fixture-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Local fixture did not bind a TCP port.');
  const snapshotDir =
    snapshotDirOverride ??
    process.env.ALS_SNAPSHOT_DIR ??
    (await mkdtemp(join(tmpdir(), 'alsnap-sdk-')));
  const telemetry = initInstrumentation({
    snapshotDir,
    integrations: [openAIIntegration({ recording: 'metadata-only' })],
  });
  try {
    // Initialization occurs before dynamically loading the business module.
    const { runBusiness } = await import('./app.mjs');
    const result = await telemetry.run({ input: { goal: 'offline SDK request' } }, () =>
      runBusiness(`http://127.0.0.1:${String(address.port)}/v1`),
    );
    return { result, snapshotDir };
  } finally {
    await telemetry.shutdown();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'));
if (isMain) {
  const result = await run();
  console.log(`Result: ${result.result}`);
  console.log(`Snapshots: ${result.snapshotDir}`);
}
