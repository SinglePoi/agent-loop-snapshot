import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSnapshotDirectory } from '@agent-loop-snapshot/schema';
import {
  Recorder,
  SnapshotWriter,
  createDefaultRedactionPipeline,
  hashState,
} from '@agent-loop-snapshot/recorder';

import { ExampleAgentRuntime } from './example-agent.js';
import { RuntimeAdapterError } from './errors.js';
import type { ModelAdapter, ToolAdapter } from './types.js';

test('runs a model plus parallel read-only tools and writes a valid snapshot', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'alsnap-example-'));
  const writer = await SnapshotWriter.open(root);
  let transientCalls = 0;
  const model: ModelAdapter = {
    name: 'fake-model',
    version: 'test',
    async complete() {
      return { output: 'example answer' };
    },
  };
  const retryingTool: ToolAdapter = {
    name: 'retrying-read',
    version: 'test',
    sideEffect: 'read_only',
    async call() {
      transientCalls += 1;
      if (transientCalls === 1) {
        throw new RuntimeAdapterError(
          'TEMPORARY_TOOL_FAILURE',
          'Temporary tool failure.',
          true,
          'tool',
        );
      }
      return { value: 'ok' };
    },
  };
  const parallelTool: ToolAdapter = {
    name: 'parallel-read',
    version: 'test',
    sideEffect: 'read_only',
    async call() {
      return { value: 'context' };
    },
  };

  try {
    const redaction = createDefaultRedactionPipeline();
    const recorder = new Recorder({
      interceptors: [redaction.asInterceptor(), writer.asInterceptor()],
    });
    const runtime = new ExampleAgentRuntime({
      recorder,
      model,
      tools: [retryingTool, parallelTool],
    });
    const result = await runtime.run({ goal: 'summarize fixture' });
    await writer.commit(result.manifest);
    await writer.close();

    assert.equal(result.status, 'completed');
    assert.equal(result.finalStateHash, hashState(result.finalState));
    assert.equal(transientCalls, 2);

    const validation = await validateSnapshotDirectory(root);
    assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));

    const events = (await readFile(join(root, 'events.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/u)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            event_id: string;
            parent_ids: string[];
            payload: Record<string, unknown>;
          },
      );
    const types = events.map((event) => event.type);
    assert.ok(types.includes('model.requested'));
    assert.ok(types.includes('model.completed'));
    assert.ok(types.includes('tool.failed'));
    assert.ok(types.includes('tool.completed'));
    assert.ok(types.includes('state.changed'));
    assert.ok(types.includes('checkpoint.created'));
    assert.ok(types.includes('run.completed'));

    const modelCompleted = events.find((event) => event.type === 'model.completed');
    assert.ok(modelCompleted);
    const toolRequests = events.filter((event) => event.type === 'tool.requested');
    assert.equal(toolRequests.length, 3);
    assert.ok(
      toolRequests.every(
        (event) =>
          event.parent_ids.includes(modelCompleted.event_id) ||
          events.some(
            (candidate) =>
              candidate.event_id === event.parent_ids[0] && candidate.type === 'tool.failed',
          ),
      ),
    );

    const checkpoints = await readdir(join(root, 'checkpoints'));
    assert.equal(checkpoints.length, 1);
    assert.match(checkpoints[0]!, /^\d{6}\.json$/u);
  } finally {
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ships a sanitized example snapshot that passes the schema validator', async () => {
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/example-run');
  const validation = await validateSnapshotDirectory(fixture);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));

  const events = await readFile(join(fixture, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /(?:sk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9])/u);
  assert.match(events, /"type":"tool.failed"/u);
  assert.match(events, /"type":"checkpoint.created"/u);
});
