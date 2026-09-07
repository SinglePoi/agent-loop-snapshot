import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTraceSnapshot } from '@agent-loop-snapshot/trace';
import { Recorder } from '@agent-loop-snapshot/recorder';

import {
  MockReplayRunner,
  RecorderReplayPolicyAuditSink,
  ReplayAdapterRegistry,
  ReplayPolicyEngine,
  VerifiedReplayRunner,
  compareVerifiedReplayValues,
  createRecordedReplayAdapterSet,
  createReplayPolicyAction,
  createReplayCorrelationKey,
  selectReplayResumePoint,
} from './index.js';

test('creates deterministic correlation keys and keeps retries on the same logical call', () => {
  const identity = { kind: 'tool' as const, target: 'read/file name', ordinal: 2 };
  assert.equal(createReplayCorrelationKey(identity), 'replay/v1/tool/read%2Ffile%20name/2');
  assert.equal(createReplayCorrelationKey(identity), createReplayCorrelationKey({ ...identity }));
  assert.throws(
    () => createReplayCorrelationKey({ kind: 'model', target: '', ordinal: 0 }),
    /target/u,
  );
  assert.throws(
    () => createReplayCorrelationKey({ kind: 'model', target: 'answer', ordinal: -1 }),
    /ordinal/u,
  );
});

test('returns structured diagnostics for unavailable and incapable adapters', () => {
  const registry = new ReplayAdapterRegistry({
    live: {
      model: {
        descriptor: {
          name: 'incomplete-model',
          version: 'test',
          capabilities: [],
          sideEffect: 'read_only',
        },
        async complete() {
          return { status: 'completed', output: 'unused' };
        },
      },
    },
  });

  assert.equal(registry.resolveTool('live', 'missing').diagnostics[0]?.code, 'MISSING_ADAPTER');
  assert.equal(registry.resolveModel('live').diagnostics[0]?.code, 'ADAPTER_CAPABILITY_MISSING');
  assert.equal(registry.resolveClock('recorded').diagnostics[0]?.code, 'MISSING_ADAPTER');
});

test('switches to recorded adapters built from the example snapshot', async () => {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const trace = await loadTraceSnapshot(fixture);
  assert.equal(trace.valid, true, JSON.stringify(trace.diagnostics));

  const recorded = createRecordedReplayAdapterSet(trace);
  assert.deepEqual(recorded.diagnostics, []);
  const registry = new ReplayAdapterRegistry({ recorded: recorded.adapters });

  const model = registry.resolveModel('recorded').adapter;
  assert.ok(model);
  assert.deepEqual(
    await model.complete({
      correlationKey: 'model:fixture',
      attempt: 1,
      model: 'fake-model',
      input: 'summarize fixture',
    }),
    { status: 'completed', output: 'example answer' },
  );

  const tool = registry.resolveTool('recorded', 'read_goal_metadata').adapter;
  assert.ok(tool);
  assert.deepEqual(
    await tool.call({
      correlationKey: 'tool:read_goal_metadata:0:fixture',
      attempt: 1,
      tool: 'read_goal_metadata',
      arguments: { goal: 'summarize fixture' },
    }),
    {
      status: 'failed',
      error: {
        code: 'TEMPORARY_TOOL_FAILURE',
        message: 'Temporary tool failure.',
        retryable: true,
        kind: 'tool',
      },
    },
  );
  assert.deepEqual(
    await tool.call({
      correlationKey: 'tool:read_goal_metadata:0:fixture',
      attempt: 2,
      tool: 'read_goal_metadata',
      arguments: { goal: 'summarize fixture' },
    }),
    { status: 'completed', output: { character_count: 17, word_count: 2 } },
  );
  assert.equal(
    (
      await tool.call({
        correlationKey: 'tool:does-not-exist',
        attempt: 1,
        tool: 'read_goal_metadata',
        arguments: {},
      })
    ).status,
    'failed',
  );
});

test('defaults to recorded results and live read-only calls while blocking live writes', async () => {
  const policy = new ReplayPolicyEngine();
  let invocations = 0;

  const liveWrite = await policy.execute(
    createReplayPolicyAction({
      mode: 'live',
      adapterKind: 'tool',
      target: 'publish',
      sideEffect: 'external_write',
      correlationKey: 'tool:publish:0',
      attempt: 1,
    }),
    () => {
      invocations += 1;
      return 'should not run';
    },
  );
  assert.equal(liveWrite.decision.decision, 'deny');
  assert.equal(liveWrite.executed, false);
  assert.equal(invocations, 0);

  const liveRead = await policy.execute(
    createReplayPolicyAction({
      mode: 'live',
      adapterKind: 'tool',
      target: 'inspect',
      sideEffect: 'read_only',
      correlationKey: 'tool:inspect:0',
      attempt: 1,
    }),
    () => {
      invocations += 1;
      return 'read result';
    },
  );
  assert.equal(liveRead.decision.decision, 'allow');
  assert.equal(liveRead.value, 'read result');

  const recordedResult = await policy.execute(
    createReplayPolicyAction({
      mode: 'recorded',
      adapterKind: 'tool',
      target: 'historical-publish',
      sideEffect: 'external_write',
      correlationKey: 'tool:historical-publish:0',
      attempt: 1,
    }),
    () => {
      invocations += 1;
      return 'recorded result';
    },
  );
  assert.equal(recordedResult.decision.decision, 'allow');
  assert.equal(recordedResult.value, 'recorded result');
  assert.equal(invocations, 2);
});

test('requires a fresh approval and never executes denied or dry-run actions', async () => {
  const action = createReplayPolicyAction({
    mode: 'live',
    adapterKind: 'tool',
    target: 'write-workspace-file',
    sideEffect: 'workspace_write',
    correlationKey: 'tool:write-workspace-file:0',
    attempt: 1,
  });
  const policy = new ReplayPolicyEngine({
    rules: [
      {
        mode: 'live',
        sideEffect: 'workspace_write',
        decision: 'require_approval',
      },
    ],
  });
  let invocations = 0;

  const unapproved = await policy.execute(action, () => ++invocations);
  assert.equal(unapproved.decision.decision, 'require_approval');
  assert.equal(unapproved.executed, false);

  const historicalApproval = await policy.execute(action, () => ++invocations, {
    approval: {
      actionId: 'historical-run-policy-approval',
      approvedBy: 'source trace',
      approvedAt: '2026-09-06T00:00:00.000Z',
    },
  });
  assert.equal(historicalApproval.decision.decision, 'require_approval');
  assert.equal(historicalApproval.executed, false);

  const approved = await policy.execute(action, () => ++invocations, {
    approval: {
      actionId: action.id,
      approvedBy: 'current user',
      approvedAt: '2026-09-07T00:00:00.000Z',
    },
  });
  assert.equal(approved.decision.decision, 'allow');
  assert.equal(approved.executed, true);
  assert.equal(invocations, 1);

  const dryRun = new ReplayPolicyEngine({ rules: [{ decision: 'dry_run' }] });
  const dryResult = await dryRun.execute(action, () => ++invocations);
  assert.equal(dryResult.decision.decision, 'dry_run');
  assert.equal(dryResult.executed, false);
  assert.equal(invocations, 1);
});

test('records each policy decision in the new replay trace before executing', async () => {
  const recorder = new Recorder();
  const run = await recorder.startRun({
    runtime: { name: 'replay', version: '0.1.0', adapter: '@agent-loop-snapshot/replay' },
    input: { source_run_id: 'run_source' },
  });
  const policy = new ReplayPolicyEngine({
    auditSink: new RecorderReplayPolicyAuditSink(recorder, run),
  });
  let executed = false;

  const result = await policy.execute(
    createReplayPolicyAction({
      mode: 'recorded',
      adapterKind: 'model',
      target: 'fake-model',
      sideEffect: 'read_only',
      correlationKey: 'model:fixture',
      attempt: 1,
    }),
    () => {
      executed = true;
      return 'example answer';
    },
  );

  assert.equal(result.executed, true);
  assert.equal(executed, true);
  const audit = recorder.getEvents(run).find((event) => event.type === 'decision.recorded');
  assert.ok(audit);
  assert.equal(audit.actor, 'replay.policy');
  assert.equal(audit.security.side_effect, 'read_only');
  assert.deepEqual(audit.payload, {
    decision: 'policy.allow',
    basis_summary:
      'Recorded result adapters are permitted because they do not invoke a live dependency.',
    success_conditions: ['policy decision recorded before adapter execution'],
    policy: {
      action_id: result.decision.action.id,
      mode: 'recorded',
      adapter_kind: 'model',
      target: 'fake-model',
      side_effect: 'read_only',
      correlation_key: 'model:fixture',
      attempt: 1,
      approved: false,
    },
  });
});

test('mock replay reproduces the fixture state in a new audited replay trace', async () => {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const source = await loadTraceSnapshot(fixture);
  const recorder = new Recorder();
  const result = await new MockReplayRunner({ source, recorder }).run();

  assert.equal(result.run.status, 'completed');
  assert.equal(result.manifest.terminal_status, 'completed');
  assert.equal(result.sourceRunId, source.manifest?.run_id);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(
    result.finalStateHash,
    '9a01e3ac2a32cf60aa6a35ca59e413ba888f759e2e2850bd041bbc866fc9432f',
  );
  assert.deepEqual(result.finalState, {
    goal: 'summarize fixture',
    answer: 'example answer',
    tool_results: {
      read_goal_metadata: { character_count: 17, word_count: 2 },
      read_runtime_context: { runtime: 'example-runtime', side_effect: 'read_only' },
    },
  });

  const events = recorder.getEvents(result.run);
  assert.equal(events.filter((event) => event.type === 'decision.recorded').length, 4);
  assert.equal(events.filter((event) => event.type === 'tool.failed').length, 1);
  assert.equal(events.filter((event) => event.type === 'checkpoint.created').length, 1);
  assert.equal(events.at(-1)?.type, 'run.completed');
});

test('mock replay returns structured diffs before any recorded adapter is invoked', async () => {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const source = await loadTraceSnapshot(fixture);
  const recorder = new Recorder();
  const result = await new MockReplayRunner({ source, recorder }).run({
    calls: [
      {
        kind: 'model',
        model: 'fake-model',
        correlationKey: 'model:fixture',
        attempt: 1,
        input: 'different goal',
      },
    ],
  });

  assert.equal(result.run.status, 'failed');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CALL_COUNT_MISMATCH'));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CALL_INPUT_MISMATCH'));
  const events = recorder.getEvents(result.run);
  assert.equal(events.filter((event) => event.type === 'decision.recorded').length, 0);
  assert.equal(events.at(-1)?.type, 'run.failed');
});

function createVerifiedAdapters(modelOutput = 'example answer'): ReplayAdapterRegistry {
  return new ReplayAdapterRegistry({
    live: {
      model: {
        descriptor: {
          name: 'fake-model',
          version: 'test',
          capabilities: ['model.complete'],
          sideEffect: 'read_only',
        },
        async complete() {
          return { status: 'completed', output: modelOutput };
        },
      },
      tools: [
        {
          descriptor: {
            name: 'read_goal_metadata',
            version: 'test',
            capabilities: ['tool.call'],
            sideEffect: 'read_only',
          },
          async call(request) {
            if (request.attempt === 1) {
              return {
                status: 'failed',
                error: {
                  code: 'TEMPORARY_TOOL_FAILURE',
                  message: 'Temporary tool failure.',
                  retryable: true,
                  kind: 'tool',
                },
              };
            }
            return { status: 'completed', output: { character_count: 17, word_count: 2 } };
          },
        },
        {
          descriptor: {
            name: 'read_runtime_context',
            version: 'test',
            capabilities: ['tool.call'],
            sideEffect: 'read_only',
          },
          async call() {
            return {
              status: 'completed',
              output: { runtime: 'example-runtime', side_effect: 'read_only' },
            };
          },
        },
      ],
    },
  });
}

test('verified replay invokes permitted live adapters and reports no differences for matching results', async () => {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const source = await loadTraceSnapshot(fixture);
  const recorder = new Recorder();
  const result = await new VerifiedReplayRunner({
    source,
    recorder,
    adapters: createVerifiedAdapters(),
  }).run();

  assert.equal(result.run.status, 'completed');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.differences, []);
  assert.equal(
    result.recordedStateHash,
    '9a01e3ac2a32cf60aa6a35ca59e413ba888f759e2e2850bd041bbc866fc9432f',
  );
  assert.equal(
    recorder.getEvents(result.run).filter((event) => event.type === 'decision.recorded').length,
    4,
  );
});

test('verified replay supports checkpoint selection and declarative output verification', async () => {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const source = await loadTraceSnapshot(fixture);
  const checkpoint = source.checkpoints[0];
  assert.ok(checkpoint);
  const resumePoint = await selectReplayResumePoint(source, checkpoint.checkpoint_id);
  assert.equal(resumePoint.checkpoint?.checkpoint_id, checkpoint.checkpoint_id);
  assert.equal(resumePoint.stateHash, checkpoint.state_hash);

  const resumed = await new VerifiedReplayRunner({
    source,
    recorder: new Recorder(),
    adapters: createVerifiedAdapters(),
  }).run({ checkpointId: checkpoint.checkpoint_id });
  assert.equal(resumed.run.status, 'completed');
  assert.equal(resumed.resumePoint.sourceSequence, checkpoint.sequence);
  assert.deepEqual(resumed.differences, []);

  assert.deepEqual(
    compareVerifiedReplayValues(
      {
        text: 'one   two',
        volatile: 'old-id',
        artifact_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        text: 'one two',
        volatile: 'new-id',
        artifact_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      [
        { kind: 'text', path: '/text', normalizeWhitespace: true },
        { kind: 'ignore', path: '/volatile' },
        { kind: 'file_hash', path: '/artifact_sha256' },
      ],
    ),
    [],
  );
});

test('verified replay reports output and custom assertion differences without blocking read-only calls', async () => {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const source = await loadTraceSnapshot(fixture);
  const result = await new VerifiedReplayRunner({
    source,
    recorder: new Recorder(),
    adapters: createVerifiedAdapters('different answer'),
  }).run({
    assertions: [
      {
        name: 'fixture assertion',
        async verify() {
          return { passed: false, message: 'Expected fixture contract was not met.' };
        },
      },
    ],
  });

  assert.equal(result.run.status, 'completed');
  assert.ok(result.differences.some((difference) => difference.kind === 'value'));
  assert.ok(
    result.differences.some(
      (difference) =>
        difference.kind === 'assertion' &&
        difference.message === 'Expected fixture contract was not met.',
    ),
  );
});
