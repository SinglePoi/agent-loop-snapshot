import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import { initInstrumentation } from '@agent-loop-snapshot/instrumentation';

import { anthropicIntegration } from './index.js';

test('records a real Anthropic Messages SDK call through a local HTTP fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-anthropic-'));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/messages');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-fixture',
        content: [{ type: 'text', text: 'answer' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not create fixture listener.');
  }
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [anthropicIntegration({ recording: 'metadata-only' })],
  });
  const client = new Anthropic({
    apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${address.port}`,
  });

  try {
    const result = await telemetry.run({}, () =>
      client.messages.create({
        model: 'claude-fixture',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'secret prompt' }],
      }),
    );
    assert.equal(result.id, 'msg_1');
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const serialized = await readFile(join(runDirectory, 'events.jsonl'), 'utf8');
    const events = serialized
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    assert.deepEqual(
      events.map((event) => event.type),
      ['run.started', 'model.requested', 'model.completed', 'run.observed'],
    );
    assert.equal(serialized.includes('secret prompt'), false);
  } finally {
    await telemetry.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test('observes an Anthropic stream only while its caller consumes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-anthropic-stream-'));
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/messages');
    response.setHeader('content-type', 'text/event-stream');
    response.end(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Could not create fixture listener.');
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [anthropicIntegration({ recording: 'metadata-only' })],
  });
  const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}` });
  try {
    await telemetry.run({}, async () => {
      const stream = await client.messages.create({
        model: 'claude-fixture',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'stream' }],
        stream: true,
      });
      const events: unknown[] = [];
      for await (const event of stream) events.push(event);
      assert.equal(events.length, 2);
    });
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const completed = events.find((event) => event.type === 'model.completed');
    assert.deepEqual(completed?.payload.output, {
      endpoint: 'messages.create',
      stream: true,
      event_count: 2,
    });
  } finally {
    await telemetry.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
