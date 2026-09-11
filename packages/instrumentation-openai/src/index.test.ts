import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initInstrumentation } from '@agent-loop-snapshot/instrumentation';
import OpenAI from 'openai';

import { openAIIntegration } from './index.js';

async function startFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ readonly server: Server; readonly baseURL: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not create fixture listener.');
  }
  return { server, baseURL: `http://127.0.0.1:${address.port}/v1` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test('records real OpenAI Chat Completions and Responses SDK calls through a local HTTP fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-openai-'));
  const fixture = await startFixture((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/chat/completions') {
      response.end(
        JSON.stringify({
          id: 'chat_1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-fixture',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'chat answer' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
      return;
    }
    assert.equal(request.url, '/v1/responses');
    response.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-fixture',
        output: [],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }),
    );
  });
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [openAIIntegration({ recording: 'metadata-only' })],
  });
  const client = new OpenAI({ apiKey: 'test-key', baseURL: fixture.baseURL });

  try {
    await telemetry.run({ input: { goal: 'fixture' } }, async () => {
      const chatPromise = client.chat.completions.create({
        model: 'gpt-fixture',
        messages: [{ role: 'user', content: 'secret prompt' }],
      });
      assert.equal(typeof chatPromise.withResponse, 'function');
      const chat = await chatPromise;
      assert.equal(chat.choices[0]?.message.content, 'chat answer');
      const response = await client.responses.create({
        model: 'gpt-fixture',
        input: 'another prompt',
      });
      assert.equal(response.id, 'resp_1');
    });
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const serialized = await readFile(join(runDirectory, 'events.jsonl'), 'utf8');
    const events = serialized
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    assert.equal(events.filter((event) => event.type === 'model.requested').length, 2);
    assert.equal(events.filter((event) => event.type === 'model.completed').length, 2);
    assert.equal(events.at(-1)?.type, 'run.observed');
    assert.equal(serialized.includes('secret prompt'), false);
    const endpoints = events
      .filter((event) => event.type === 'model.requested')
      .map((event) => (event.payload.input as Record<string, unknown>).endpoint)
      .sort();
    assert.deepEqual(endpoints, ['chat.completions.create', 'responses.create']);
  } finally {
    await telemetry.shutdown();
    await close(fixture.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('observes an OpenAI stream only while its caller consumes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-openai-stream-'));
  const fixture = await startFixture((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    response.setHeader('content-type', 'text/event-stream');
    response.end(
      `data: ${JSON.stringify({ id: 'chat_stream', object: 'chat.completion.chunk', created: 1, model: 'gpt-fixture', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [openAIIntegration({ recording: 'metadata-only' })],
  });
  const client = new OpenAI({ apiKey: 'test-key', baseURL: fixture.baseURL });
  try {
    await telemetry.run({}, async () => {
      const stream = await client.chat.completions.create({
        model: 'gpt-fixture',
        messages: [{ role: 'user', content: 'stream' }],
        stream: true,
      });
      const chunks: unknown[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(chunks.length, 1);
    });
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const events = (await readFile(join(runDirectory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const completed = events.find((event) => event.type === 'model.completed');
    assert.deepEqual(completed?.payload.output, {
      endpoint: 'chat.completions.create',
      stream: true,
      event_count: 1,
    });
  } finally {
    await telemetry.shutdown();
    await close(fixture.server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('marks an OpenAI stream partial when its consumer ends early', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alsnap-openai-break-'));
  const fixture = await startFixture((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    response.setHeader('content-type', 'text/event-stream');
    response.end(
      `data: ${JSON.stringify({ id: 'chat_break', object: 'chat.completion.chunk', created: 1, model: 'gpt-fixture', choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'chat_break', object: 'chat.completion.chunk', created: 1, model: 'gpt-fixture', choices: [{ index: 0, delta: { content: 'second' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  const telemetry = initInstrumentation({
    snapshotDir: directory,
    integrations: [openAIIntegration()],
  });
  const client = new OpenAI({ apiKey: 'test-key', baseURL: fixture.baseURL });
  try {
    await telemetry.run({}, async () => {
      const stream = await client.chat.completions.create({
        model: 'gpt-fixture',
        messages: [{ role: 'user', content: 'break' }],
        stream: true,
      });
      for await (const _event of stream) break;
    });
    const runDirectory = join(directory, (await readdir(directory))[0]!);
    const manifest = JSON.parse(await readFile(join(runDirectory, 'manifest.json'), 'utf8')) as {
      completeness: string;
      limitations: Array<{ code: string }>;
    };
    assert.equal(manifest.completeness, 'partial');
    assert.equal(
      manifest.limitations.some((limitation) => limitation.code === 'stream_ended_early'),
      true,
    );
  } finally {
    await telemetry.shutdown();
    await close(fixture.server);
    await rm(directory, { recursive: true, force: true });
  }
});
