import assert from 'node:assert/strict';
import test from 'node:test';

import { assessSnapshotExecution, validateSnapshot } from '@agent-loop-snapshot/schema';

import { importOtlpTraces, otelGenAiProfileVersion, toObservationSnapshot } from './index.js';

const traceId = '11111111111111111111111111111111';
const rootId = '2222222222222222';
const childId = '3333333333333333';

function attribute(key: string, value: unknown): unknown {
  return { key, value };
}

test('normalizes OTLP resource/scope data, 64-bit timestamps, and stable parent order', () => {
  const result = importOtlpTraces({
    resourceSpans: [
      {
        resource: { attributes: [attribute('service.name', { stringValue: 'search-api' })] },
        scopeSpans: [
          {
            scope: { name: 'fixture-sdk', version: '1.2.3', schemaUrl: 'https://schema.test' },
            spans: [
              {
                traceId,
                spanId: childId,
                parentSpanId: rootId,
                name: 'child',
                startTimeUnixNano: '1700000000000000123',
                endTimeUnixNano: '1700000001000000123',
                status: { code: 2 },
                attributes: [attribute('answer', { intValue: '9007199254740993' })],
                links: [{ traceId, spanId: rootId }],
              },
              {
                traceId,
                spanId: rootId,
                name: 'root',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000002000000000',
                status: {},
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.report.importedSpanCount, 2);
  assert.equal(result.traces.length, 1);
  const trace = result.traces[0]!;
  assert.equal(trace.completeness, 'unknown');
  assert.deepEqual(
    trace.spans.map((span) => span.spanId),
    [rootId, childId],
  );
  assert.equal(trace.spans[1]!.startTimeUnixNano, '1700000000000000123');
  assert.equal(trace.spans[1]!.attributes.answer, '9007199254740993');
  assert.deepEqual(trace.spans[0]!.resource.attributes, { 'service.name': 'search-api' });
  assert.equal(trace.spans[0]!.scope.name, 'fixture-sdk');

  const snapshot = toObservationSnapshot(trace);
  const validation = validateSnapshot({
    manifest: snapshot.manifest,
    events: [...snapshot.events],
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.equal(snapshot.events[2]!.parent_ids[0], snapshot.events[1]!.event_id);
  assert.equal(
    assessSnapshotExecution({ source: 'otel-import', completeness: 'unknown', limitations: [] })
      .eligibility,
    'observation_only',
  );
});

test('reports missing parents, conflicts, cycles, drops, and invalid time deterministically', () => {
  const result = importOtlpTraces({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: rootId,
                parentSpanId: childId,
                name: 'a',
                startTimeUnixNano: '20',
              },
              {
                traceId,
                spanId: childId,
                parentSpanId: rootId,
                name: 'b',
                startTimeUnixNano: '10',
                droppedEventsCount: 1,
              },
              {
                traceId,
                spanId: '4444444444444444',
                parentSpanId: '5555555555555555',
                name: 'missing',
                startTimeUnixNano: '30',
              },
              {
                traceId,
                spanId: '6666666666666666',
                name: 'bad time',
                startTimeUnixNano: '10',
                endTimeUnixNano: '9',
              },
              { traceId, spanId: '7777777777777777', name: 'first', startTimeUnixNano: '40' },
              { traceId, spanId: '7777777777777777', name: 'conflict', startTimeUnixNano: '41' },
            ],
          },
        ],
      },
    ],
  });
  const trace = result.traces[0]!;
  assert.equal(trace.completeness, 'partial');
  assert.ok(trace.limitations.some((entry) => entry.code === 'missing_root'));
  assert.ok(trace.limitations.some((entry) => entry.code === 'missing_parent'));
  assert.ok(trace.limitations.some((entry) => entry.code === 'sampled_or_dropped'));
  assert.ok(trace.limitations.some((entry) => entry.code === 'invalid_source_data'));
  assert.ok(result.report.diagnostics.some((entry) => entry.code === 'PARENT_CYCLE'));
  assert.ok(result.report.diagnostics.some((entry) => entry.code === 'CONFLICTING_SPAN'));
  assert.ok(result.report.diagnostics.some((entry) => entry.code === 'NEGATIVE_DURATION'));
  assert.equal(
    trace.spans.some((span) => span.spanId === '7777777777777777'),
    false,
  );
});

test('uses the fixed GenAI profile without promoting a tool span to an executable tool call', () => {
  const result = importOtlpTraces(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: rootId,
                  name: 'execute tool',
                  startTimeUnixNano: '1',
                  attributes: [attribute('gen_ai.operation.name', { stringValue: 'execute_tool' })],
                },
              ],
            },
          ],
        },
      ],
    },
    { profile: otelGenAiProfileVersion },
  );
  const trace = result.traces[0]!;
  assert.equal(trace.spans[0]!.semantic, 'gen_ai_tool');
  assert.ok(trace.limitations.some((entry) => entry.code === 'unknown_side_effect'));
  const snapshot = toObservationSnapshot(trace);
  assert.equal(snapshot.events.filter((event) => event.type.startsWith('tool.')).length, 0);
  assert.equal(snapshot.events.filter((event) => event.type === 'otel.span').length, 1);
});
