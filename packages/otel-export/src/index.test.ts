import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { EventEnvelope } from '@agent-loop-snapshot/schema';

import {
  createOtlpHttpClient,
  createOtlpExporter,
  createOtelExportConfigFingerprint,
  openOtlpPersistentQueue,
  OtlpQueueError,
  dryRunOtlpExport,
  isExportEndpointConfigured,
  mapSnapshotToOtlp,
  otelExportContractVersion,
} from './index.js';

const emptyRequest = { resourceSpans: [] };
const schemaFixtures = resolve(import.meta.dirname, '../../schema/fixtures');
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

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

test('queues committed snapshots and splits their OTLP spans before automatic delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-exporter-'));
  let requests = 0;
  try {
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      },
      async (endpoint) => {
        const exporter = createOtlpExporter({
          targetAlias: 'fixture',
          endpoint,
          serviceName: 'test',
          queueDir: root,
          batchSpanLimit: 1,
        });
        const queued = await exporter.exportSnapshot({
          manifest: {
            run_id: 'run_test',
            source: 'native',
            completeness: 'complete',
            terminal_status: 'completed',
          },
          events: [
            event(1, 'run.started', {}),
            event(2, 'model.requested', { correlation_key: 'one', model: 'test', input: {} }),
            event(3, 'model.completed', { correlation_key: 'one', output: {} }, ['evt_2']),
          ],
        });
        assert.equal(queued.state, 'queued');
        const flush = await exporter.shutdown();
        assert.equal(flush.pendingCount, 0);
        assert.equal(flush.deliveries.length, 2);
        assert.ok(flush.deliveries.every((delivery) => delivery.state === 'accepted'));
      },
    );
    assert.equal(requests, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('flushes already queued batches when a later split batch cannot enter the queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-exporter-capacity-'));
  let requests = 0;
  try {
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        response.end();
      },
      async (endpoint) => {
        const exporter = createOtlpExporter({
          targetAlias: 'fixture',
          endpoint,
          serviceName: 'test',
          queueDir: root,
          batchSpanLimit: 1,
          queueMaxEntries: 1,
        });
        const delivery = await exporter.exportSnapshot({
          manifest: {
            run_id: 'run_test',
            source: 'native',
            completeness: 'complete',
            terminal_status: 'completed',
          },
          events: [
            event(1, 'run.started', {}),
            event(2, 'model.requested', { correlation_key: 'one', model: 'test', input: {} }),
            event(3, 'model.completed', { correlation_key: 'one', output: {} }, ['evt_2']),
          ],
        });
        assert.equal(delivery.state, 'not_queued');

        const flushed = await exporter.shutdown();
        assert.equal(flushed.pendingCount, 0);
        assert.ok(flushed.deliveries.some((item) => item.state === 'accepted'));
      },
    );
    assert.equal(requests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps bounded background delivery history for long-running exporters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-exporter-history-'));
  let requests = 0;
  try {
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        response.end();
      },
      async (endpoint) => {
        const config = {
          targetAlias: 'fixture',
          endpoint,
          serviceName: 'test',
          queueDir: root,
        };
        const exporter = createOtlpExporter(config);
        const inspector = await openOtlpPersistentQueue({
          queueDir: root,
          targetAlias: config.targetAlias,
          configFingerprint: createOtelExportConfigFingerprint(config),
        });
        for (let index = 0; index < 129; index += 1) {
          const delivery = await exporter.exportSnapshot({
            manifest: {
              run_id: 'run_test',
              source: 'otel-import',
              completeness: 'unknown',
              terminal_status: 'unknown',
            },
            events: [
              event(1, 'otel.span', {
                trace_id: '11111111111111111111111111111111',
                span_id: '2222222222222222',
                name: 'background-history',
                status: 'unset',
                start_time_unix_nano: '1000000000',
                end_time_unix_nano: '2000000000',
                resource: { attributes: {} },
                scope: { name: 'fixture', version: '1.0.0' },
                attributes: {},
                events: [],
                links: [],
              }),
            ],
          });
          assert.equal(delivery.state, 'queued', delivery.message);
          await waitFor(
            async () =>
              (await inspector.inspect()).pendingCount === 0 &&
              !(await pathExists(join(root, 'consumer.lock'))),
            'The background exporter did not finish delivering the fixture batch.',
          );
        }

        const flushed = await exporter.shutdown();
        assert.equal(flushed.pendingCount, 0);
        assert.ok(flushed.deliveries.length <= 128);
      },
    );
    assert.ok(requests > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('exports every retry attempt with correct OTLP wire status codes', async () => {
  const directory = join(schemaFixtures, 'tool-failure-retry');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    run_id: `run_${string}`;
    terminal_status: 'completed';
  };
  const events = (await readFile(join(directory, 'events.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as EventEnvelope<string, unknown>);

  const mapping = mapSnapshotToOtlp({
    manifest: {
      run_id: manifest.run_id,
      source: 'native',
      completeness: 'complete',
      terminal_status: manifest.terminal_status,
    },
    events,
  });
  const attempts = mapping.spans.filter((span) => span.name === 'tool.call');
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((span) => span.status),
    ['ERROR', 'OK'],
  );
  assert.notEqual(attempts[0]?.spanId, attempts[1]?.spanId);
  assert.equal(attempts[0]?.startTimeUnixNano, '1788660060500000000');
  assert.equal(attempts[1]?.startTimeUnixNano, '1788660061500000000');

  const encodedAttempts = mapping.request.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans.filter((span) => span.name === 'tool.call')),
  );
  assert.deepEqual(
    encodedAttempts.map((span) => span.status.code),
    [2, 1],
  );
  assert.deepEqual(
    mapping,
    mapSnapshotToOtlp({
      manifest: {
        run_id: manifest.run_id,
        source: 'native',
        completeness: 'complete',
        terminal_status: manifest.terminal_status,
      },
      events,
    }),
  );
});

test('keeps calls with a shared correlation key separate across call types', () => {
  const mapping = mapSnapshotToOtlp({
    manifest: {
      run_id: 'run_test',
      source: 'native',
      completeness: 'complete',
      terminal_status: 'completed',
    },
    events: [
      event(1, 'run.started', {}),
      event(2, 'model.requested', {
        correlation_key: 'shared',
        model: 'model',
        input: {},
      }),
      event(3, 'tool.requested', {
        correlation_key: 'shared',
        tool: 'tool',
        arguments: {},
      }),
      event(4, 'model.completed', { correlation_key: 'shared', output: {} }, ['evt_2']),
      event(5, 'tool.completed', { correlation_key: 'shared', output: {} }, ['evt_3']),
    ],
  });

  const calls = mapping.spans.filter((span) => span.name.endsWith('.call'));
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((span) => [span.name, span.status]),
    [
      ['model.call', 'OK'],
      ['tool.call', 'OK'],
    ],
  );
  assert.notEqual(calls[0]?.spanId, calls[1]?.spanId);
});

test('records an explicit diagnostic when a legacy finish has ambiguous call pairing', () => {
  const mapping = mapSnapshotToOtlp({
    manifest: {
      run_id: 'run_test',
      source: 'native',
      completeness: 'complete',
      terminal_status: 'completed',
    },
    events: [
      event(1, 'run.started', {}),
      event(2, 'tool.requested', {
        correlation_key: 'shared',
        tool: 'first',
        arguments: {},
      }),
      event(3, 'tool.requested', {
        correlation_key: 'shared',
        tool: 'second',
        arguments: {},
      }),
      event(4, 'tool.completed', { correlation_key: 'shared', output: {} }, []),
    ],
  });

  assert.ok(mapping.report.losses.some((item) => item.code === 'ambiguous_call_finish'));
  assert.deepEqual(
    mapping.spans.filter((span) => span.name === 'tool.call').map((span) => span.status),
    ['OK', 'UNSET'],
  );
});

test('pairs a terminal event through a deep causal history without recursion', () => {
  const depth = 4_000;
  const chain = Array.from({ length: depth }, (_, index) => ({
    ...event(index + 3, 'checkpoint.created', {}, [
      index === 0 ? 'evt_2' : `chain_${String(index - 1)}`,
    ]),
    event_id: `chain_${String(index)}` as `evt_${string}`,
  }));
  const mapping = mapSnapshotToOtlp({
    manifest: {
      run_id: 'run_test',
      source: 'native',
      completeness: 'complete',
      terminal_status: 'completed',
    },
    events: [
      event(1, 'run.started', {}),
      event(2, 'tool.requested', { correlation_key: 'deep', tool: 'lookup', arguments: {} }),
      ...chain,
      event(depth + 3, 'tool.completed', { correlation_key: 'deep', output: {} }, [
        `chain_${String(depth - 1)}`,
      ]),
    ],
  });

  const call = mapping.spans.find((span) => span.name === 'tool.call');
  assert.equal(call?.status, 'OK');
  assert.ok(call?.endTimeUnixNano !== undefined);
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

test('filters free-text metadata before the dry-run request and report', () => {
  const secret = 'Bearer test-secret-token-123456789';
  const mapping = dryRunOtlpExport(
    {
      manifest: {
        run_id: 'run_import',
        source: 'otel-import',
        completeness: 'complete',
        terminal_status: 'completed',
      },
      events: [
        event(1, 'otel.span', {
          trace_id: '11111111111111111111111111111111',
          span_id: '2222222222222222',
          status: 'error',
          resource: { attributes: { 'service.name': secret } },
          scope: { name: secret, version: secret },
          attributes: { api_key: secret, correlation_key: secret },
          events: [],
          links: [],
        }),
      ],
    },
    { contentPolicy: 'redacted-content', serviceName: secret },
  );

  const outbound = JSON.stringify(mapping);
  assert.doesNotMatch(outbound, /test-secret-token-123456789/);
  assert.doesNotMatch(outbound, /"correlation_key":/u);
  assert.ok(mapping.mapping.report.losses.some((item) => item.code === 'metadata_filtered'));
  assert.match(outbound, /agent-loop-snapshot-[0-9a-f]{16}/u);
});

test('applies bounded content, span, and request limits before returning OTLP JSON', () => {
  const circular: Record<string, unknown> = { text: '😀'.repeat(100), items: [1, 2, 3, 4] };
  circular.self = circular;
  const mapping = mapSnapshotToOtlp(
    {
      manifest: {
        run_id: 'run_test',
        source: 'native',
        completeness: 'complete',
        terminal_status: 'completed',
      },
      events: [
        event(1, 'run.started', {}),
        event(2, 'tool.requested', {
          correlation_key: 'capacity-test',
          tool: 'lookup',
          arguments: circular,
        }),
        event(3, 'checkpoint.created', { first: circular }),
        event(4, 'checkpoint.created', { second: circular }),
        event(5, 'tool.completed', { correlation_key: 'capacity-test', output: circular }, [
          'evt_2',
        ]),
      ],
    },
    {
      contentPolicy: 'redacted-content',
      limits: {
        maxStringBytes: 12,
        maxCollectionItems: 2,
        maxContentDepth: 3,
        maxAttributesPerSpan: 2,
        maxEventsPerSpan: 1,
        maxLinksPerSpan: 1,
        maxSpanBytes: 800,
        maxRequestBytes: 1_200,
      },
    },
  );

  assert.ok(Buffer.byteLength(JSON.stringify(mapping.request), 'utf8') <= 1_200);
  assert.ok(mapping.spans.every((span) => Buffer.byteLength(JSON.stringify(span), 'utf8') <= 800));
  assert.ok(mapping.report.losses.some((item) => item.code === 'value_truncated'));
  assert.ok(mapping.report.losses.some((item) => item.code === 'limit_exceeded'));
});

test('uses the same mapping limits before queueing an exporter request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alsnap-otlp-filtered-queue-'));
  const secret = 'do-not-persist-or-send-this-secret';
  let received = '';
  try {
    await withServer(
      (request, response) => {
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          received += chunk;
        });
        request.on('end', () => response.end('{}'));
      },
      async (endpoint) => {
        const exporter = createOtlpExporter({
          targetAlias: 'fixture',
          endpoint,
          serviceName: secret,
          contentPolicy: 'redacted-content',
          mappingLimits: { maxStringBytes: 12, maxRequestBytes: 1_200 },
          queueDir: root,
        });
        assert.equal(
          (
            await exporter.exportSnapshot({
              manifest: {
                run_id: 'run_test',
                source: 'native',
                completeness: 'complete',
                terminal_status: 'completed',
              },
              events: [
                event(1, 'run.started', {}),
                event(2, 'tool.requested', {
                  correlation_key: secret,
                  tool: 'lookup',
                  arguments: { api_key: secret, content: 'x'.repeat(100) },
                }),
                event(3, 'tool.completed', { correlation_key: secret, output: {} }, ['evt_2']),
              ],
            })
          ).state,
          'queued',
        );
        await exporter.shutdown();
      },
    );
    assert.notEqual(received, '');
    assert.doesNotMatch(received, /do-not-persist-or-send-this-secret/);
    assert.ok(Buffer.byteLength(received, 'utf8') <= 1_200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

  const join = mapping.spans.filter((span) => span.name === 'tool.call').at(-1);
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

test('accepts an empty successful OTLP response from a Collector', async () => {
  await withServer(
    (_, response) => {
      response.statusCode = 200;
      response.end();
    },
    async (endpoint) => {
      const result = await createOtlpHttpClient({
        targetAlias: 'fixture',
        endpoint,
        serviceName: 'test',
      }).send(emptyRequest, 2);
      assert.equal(result.state, 'accepted');
      assert.equal(result.acceptedSpanCount, 2);
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

test('accepts an OTLP partialSuccess response when it rejects zero spans', async () => {
  await withServer(
    (_, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ partialSuccess: {} }));
    },
    async (endpoint) => {
      const result = await createOtlpHttpClient({
        targetAlias: 'fixture',
        endpoint,
        serviceName: 'test',
      }).send(emptyRequest, 2);
      assert.equal(result.state, 'accepted');
      assert.equal(result.acceptedSpanCount, 2);
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
