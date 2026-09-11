import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { EventEnvelope } from '@agent-loop-snapshot/schema';

import {
  createOtlpHttpClient,
  openOtlpPersistentQueue,
  OtlpQueueError,
  dryRunOtlpExport,
  isExportEndpointConfigured,
  mapSnapshotToOtlp,
  otelExportContractVersion,
} from './index.js';

const emptyRequest = { resourceSpans: [] };
type ServerHandler = (request: IncomingMessage, response: ServerResponse) => void;

function acceptedClient(calls: { count: number }) {
  return {
    async send(_: typeof emptyRequest, spanCount: number) {
      calls.count += 1;
      return {
        state: 'accepted' as const,
        targetAlias: 'ignored',
        attempted: true,
        acceptedSpanCount: spanCount,
        rejectedSpanCount: 0,
        attempts: 1,
      };
    },
  };
}

async function withServer<T>(
  handler: ServerHandler,
  operation: (endpoint: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  try {
    return await operation(`http://127.0.0.1:${String(address.port)}/v1/traces`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function event(
  sequence: number,
  type: string,
  payload: unknown,
  parentIds: string[] = sequence === 1 ? [] : ['evt_root'],
): EventEnvelope<string, unknown> {
  return {
    schema_version: '0.2.0',
    run_id: 'run_test',
    event_id: sequence === 1 ? 'evt_root' : `evt_${String(sequence)}`,
    parent_ids: parentIds as `evt_${string}`[],
    sequence,
    type,
    timestamp: `2026-09-11T00:00:0${String(sequence)}.000Z`,
    monotonic_offset_ms: sequence * 1000,
    actor: 'test',
    payload,
    security: { side_effect: 'read_only', redactions: [] },
  };
}

test('exports a stable contract version', () => {
  assert.equal(otelExportContractVersion, 'otel-export-1.0');
});

test('requires exactly one endpoint source', () => {
  assert.equal(
    isExportEndpointConfigured({
      targetAlias: 'local',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      serviceName: 'test',
    }),
    true,
  );
  assert.equal(
    isExportEndpointConfigured({
      targetAlias: 'local',
      endpointEnv: 'OTEL_ENDPOINT',
      serviceName: 'test',
    }),
    true,
  );
  assert.equal(isExportEndpointConfigured({ targetAlias: 'local', serviceName: 'test' }), false);
  assert.equal(
    isExportEndpointConfigured({
      targetAlias: 'local',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      endpointEnv: 'OTEL_ENDPOINT',
      serviceName: 'test',
    }),
    false,
  );
});

test('maps paired native calls without leaking metadata-only content', () => {
  const mapping = mapSnapshotToOtlp({
    manifest: {
      run_id: 'run_test',
      source: 'native',
      completeness: 'complete',
      terminal_status: 'completed',
    },
    events: [
      event(1, 'run.started', { input: { goal: 'do not export this' } }),
      event(2, 'model.requested', {
        correlation_key: 'model:1',
        model: 'private-model-name',
        input: { prompt: 'never-send-this' },
      }),
      event(
        3,
        'model.completed',
        { correlation_key: 'model:1', output: { answer: 'never-send-this-either' } },
        ['evt_2'],
      ),
      event(4, 'run.completed', { final_state_hash: 'a'.repeat(64) }, ['evt_3']),
    ],
  });

  assert.equal(mapping.report.spanCount, 2);
  assert.equal(mapping.spans[0]?.name, 'agent.run');
  assert.equal(mapping.spans[1]?.name, 'model.call');
  assert.equal(mapping.spans[1]?.status, 'OK');
  const body = JSON.stringify(mapping.request);
  assert.doesNotMatch(body, /never-send-this|private-model-name/);
  assert.ok(mapping.report.losses.some((item) => item.code === 'content_filtered'));
});

test('redacted-content applies out-bound redaction before constructing OTLP JSON', () => {
  const mapping = mapSnapshotToOtlp(
    {
      manifest: {
        run_id: 'run_test',
        source: 'sdk',
        completeness: 'complete',
        terminal_status: 'completed',
      },
      events: [
        event(1, 'run.started', {}),
        event(2, 'tool.requested', {
          correlation_key: 'tool:1',
          tool: 'lookup',
          arguments: { api_key: 'top-secret', authorization: 'Bearer abcdefghijklmnop' },
        }),
        event(3, 'tool.completed', { correlation_key: 'tool:1', output: { ok: true } }, ['evt_2']),
      ],
    },
    { contentPolicy: 'redacted-content' },
  );

  const body = JSON.stringify(mapping.request);
  assert.doesNotMatch(body, /top-secret|abcdefghijklmnop/);
  assert.match(body, /REDACTED/);
});

test('converts additional snapshot parents into OTLP links without serializing siblings', () => {
  const mapping = mapSnapshotToOtlp({
    manifest: {
      run_id: 'run_test',
      source: 'native',
      completeness: 'complete',
      terminal_status: 'completed',
    },
    events: [
      event(1, 'run.started', {}),
      event(2, 'tool.requested', { correlation_key: 'a', tool: 'a', arguments: {} }),
      event(3, 'tool.requested', { correlation_key: 'b', tool: 'b', arguments: {} }),
      event(4, 'tool.requested', { correlation_key: 'join', tool: 'join', arguments: {} }, [
        'evt_2',
        'evt_3',
      ]),
      event(5, 'tool.completed', { correlation_key: 'join', output: {} }, ['evt_4']),
    ],
  });

  const join = mapping.spans.find(
    (span) => span.attributes['agent_loop_snapshot.correlation_key'] === 'join',
  );
  assert.equal(join?.links.length, 1);
  assert.ok(mapping.report.losses.some((item) => item.code === 'multiple_parents_collapsed'));
  assert.ok(mapping.report.losses.some((item) => item.code === 'unpaired_call'));
});

test('preserves legal imported IDs and remains observation-only', () => {
  const mapping = dryRunOtlpExport({
    manifest: {
      run_id: 'run_import',
      source: 'otel-import',
      completeness: 'unknown',
      terminal_status: 'unknown',
    },
    events: [
      event(1, 'otel.span', {
        trace_id: '11111111111111111111111111111111',
        span_id: '2222222222222222',
        name: 'private upstream name',
        status: 'unset',
        start_time_unix_nano: '1000000000',
        end_time_unix_nano: '2000000000',
        resource: { attributes: { 'service.name': 'upstream' } },
        scope: { name: 'upstream-sdk', version: '1.0.0' },
        attributes: { api_key: 'not-exported' },
        events: [],
        links: [],
      }),
    ],
  });

  assert.equal(mapping.delivery.state, 'dry_run');
  assert.equal(mapping.delivery.attempted, false);
  assert.equal(mapping.mapping.report.observationOnly, true);
  assert.equal(mapping.mapping.report.traceId, '11111111111111111111111111111111');
  assert.doesNotMatch(
    JSON.stringify(mapping.mapping.request),
    /not-exported|private upstream name/,
  );
  assert.ok(
    mapping.mapping.report.losses.some((item) => item.code === 'observation_only_preserved'),
  );
});

test('sends OTLP JSON with headers resolved only at send time', async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(request.headers.authorization, 'Bearer test-token');
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    },
    async (endpoint) => {
      const client = createOtlpHttpClient(
        {
          targetAlias: 'fixture',
          endpoint,
          headersEnv: { Authorization: 'OTLP_AUTHORIZATION' },
          serviceName: 'test',
        },
        { environment: { OTLP_AUTHORIZATION: 'Bearer test-token' } },
      );
      const result = await client.send(emptyRequest, 2);
      assert.equal(result.state, 'accepted');
      assert.equal(result.acceptedSpanCount, 2);
      assert.equal(result.attempts, 1);
    },
  );
});

test('does not retry OTLP partial_success responses', async () => {
  let requests = 0;
  await withServer(
    (_, response) => {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          partialSuccess: { rejectedSpans: '1', errorMessage: 'details are not reported' },
        }),
      );
    },
    async (endpoint) => {
      const client = createOtlpHttpClient({
        targetAlias: 'fixture',
        endpoint,
        serviceName: 'test',
        retryMaxAttempts: 3,
      });
      const result = await client.send(emptyRequest, 3);
      assert.equal(result.state, 'rejected');
      assert.equal(result.acceptedSpanCount, 2);
      assert.equal(result.rejectedSpanCount, 1);
      assert.equal(requests, 1);
    },
  );
});

test('retries 429 with Retry-After before accepting', async () => {
  let requests = 0;
  const delays: number[] = [];
  await withServer(
    (_, response) => {
      requests += 1;
      if (requests === 1) {
        response.statusCode = 429;
        response.setHeader('retry-after', '0');
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    },
    async (endpoint) => {
      const client = createOtlpHttpClient(
        { targetAlias: 'fixture', endpoint, serviceName: 'test', retryMaxAttempts: 2 },
        { sleep: async (delay) => void delays.push(delay) },
      );
      const result = await client.send(emptyRequest, 1);
      assert.equal(result.state, 'accepted');
      assert.equal(result.attempts, 2);
      assert.deepEqual(delays, [0]);
    },
  );
  assert.equal(requests, 2);
});

test('reports a timeout as unknown delivery after retry budget exhaustion', async () => {
  await withServer(
    (request) => {
      request.resume();
    },
    async (endpoint) => {
      const client = createOtlpHttpClient({
        targetAlias: 'fixture',
        endpoint,
        serviceName: 'test',
        timeoutMs: 10,
        retryMaxAttempts: 1,
      });
      const result = await client.send(emptyRequest, 1);
      assert.equal(result.state, 'unknown_delivery');
      assert.equal(result.attempts, 1);
    },
  );
});

test('rejects non-retryable authentication failures and redirect responses', async () => {
  await withServer(
    (_, response) => {
      response.statusCode = 401;
      response.end();
    },
    async (endpoint) => {
      const result = await createOtlpHttpClient({
        targetAlias: 'fixture',
        endpoint,
        serviceName: 'test',
      }).send(emptyRequest, 1);
      assert.equal(result.state, 'rejected');
      assert.equal(result.attempts, 1);
    },
  );
  await withServer(
    (_, response) => {
      response.statusCode = 302;
      response.setHeader('location', 'https://example.invalid/redirected');
      response.end();
    },
    async (endpoint) => {
      const result = await createOtlpHttpClient({
        targetAlias: 'fixture',
        endpoint,
        serviceName: 'test',
      }).send(emptyRequest, 1);
      assert.equal(result.state, 'rejected');
    },
  );
});

test('recovers an atomically persisted queue batch and removes it only after acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-queue-'));
  try {
    const first = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
    });
    const queued = await first.enqueue({
      batchId: 'batch-recover',
      request: emptyRequest,
      spanCount: 2,
    });
    assert.equal(queued.state, 'queued');

    const recovered = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
    });
    assert.equal((await recovered.inspect()).pendingCount, 1);
    const calls = { count: 0 };
    const result = await recovered.shutdown(acceptedClient(calls));
    assert.equal(calls.count, 1);
    assert.equal(result.deliveries[0]?.batchId, 'batch-recover');
    assert.equal(result.pendingCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enforces queue capacity and does not send entries for a changed configuration fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-queue-'));
  try {
    const queue = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
      maxEntries: 1,
    });
    assert.equal((await queue.enqueue({ request: emptyRequest, spanCount: 1 })).state, 'queued');
    assert.equal(
      (await queue.enqueue({ request: emptyRequest, spanCount: 1 })).state,
      'not_queued',
    );

    const changed = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-b',
    });
    assert.equal((await changed.inspect()).foreignConfigCount, 1);
    const calls = { count: 0 };
    const result = await changed.flush(acceptedClient(calls));
    assert.equal(calls.count, 0);
    assert.equal(result.pendingCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expires old batches and leaves a deadline-interrupted delivery persisted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-queue-'));
  let clock = 0;
  try {
    const queue = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
      retentionMs: 10,
      now: () => clock,
    });
    await queue.enqueue({ batchId: 'expired', request: emptyRequest, spanCount: 1 });
    clock = 11;
    const calls = { count: 0 };
    assert.equal((await queue.flush(acceptedClient(calls))).pendingCount, 0);
    assert.equal(calls.count, 0);

    await queue.enqueue({ batchId: 'deadline', request: emptyRequest, spanCount: 1 });
    const result = await queue.flush(
      {
        async send(_, __, options) {
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener(
              'abort',
              () => {
                clock = 17;
                resolve();
              },
              { once: true },
            ),
          );
          return {
            state: 'unknown_delivery',
            targetAlias: 'ignored',
            attempted: true,
            acceptedSpanCount: 0,
            rejectedSpanCount: 0,
            attempts: 1,
          };
        },
      },
      { deadlineMs: 5 },
    );
    assert.equal(result.deadlineExceeded, true);
    assert.equal(result.pendingCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('permits only one queue consumer at a time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-queue-'));
  try {
    const first = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
    });
    const second = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
    });
    await first.enqueue({ request: emptyRequest, spanCount: 1 });
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flushing = first.flush({
      async send(_, spanCount) {
        markStarted?.();
        await blocked;
        return {
          state: 'accepted',
          targetAlias: 'ignored',
          attempted: true,
          acceptedSpanCount: spanCount,
          rejectedSpanCount: 0,
          attempts: 1,
        };
      },
    });
    await started;
    await assert.rejects(second.flush(acceptedClient({ count: 0 })), (error: unknown) =>
      error instanceof OtlpQueueError ? error.code === 'QUEUE_LOCKED' : false,
    );
    release?.();
    await flushing;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a stale consumer lock left by an interrupted process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-queue-'));
  try {
    const queue = await openOtlpPersistentQueue({
      queueDir: root,
      targetAlias: 'fixture',
      configFingerprint: 'config-a',
      lockStaleMs: 1,
    });
    await queue.enqueue({ request: emptyRequest, spanCount: 1 });
    const lock = join(root, 'consumer.lock');
    await writeFile(lock, '{"pid":0}\n');
    await utimes(lock, new Date(0), new Date(0));
    const calls = { count: 0 };
    const result = await queue.flush(acceptedClient(calls));
    assert.equal(calls.count, 1);
    assert.equal(result.pendingCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
