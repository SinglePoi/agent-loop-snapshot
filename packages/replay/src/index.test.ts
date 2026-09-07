import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTraceSnapshot } from '@agent-loop-snapshot/trace';
import { Recorder } from '@agent-loop-snapshot/recorder';
import type { WorkflowDocument } from '@agent-loop-snapshot/schema';

import {
  MockReplayRunner,
  RecorderReplayPolicyAuditSink,
  ReplayAdapterRegistry,
  ReplayPolicyEngine,
  SemanticReplayRunner,
  ScriptedSemanticRuntimeAdapter,
  VerifiedReplayRunner,
  compareVerifiedReplayValues,
  compileTraceToWorkflow,
  createRecordedReplayAdapterSet,
  createReplayPolicyAction,
  createReplayCorrelationKey,
  inspectSemanticAgentCompatibility,
  selectReplayResumePoint,
} from './index.js';

async function loadExampleTrace() {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const trace = await loadTraceSnapshot(fixture);
  assert.equal(trace.valid, true, JSON.stringify(trace.diagnostics));
  return trace;
}

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
  const trace = await loadExampleTrace();

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

test('compiles the example Trace into a stable editable Workflow IR with provenance', async () => {
  const trace = await loadExampleTrace();
  const first = compileTraceToWorkflow(trace);
  const second = compileTraceToWorkflow(trace);

  assert.deepEqual(first.diagnostics, []);
  assert.deepEqual(first, second);
  assert.ok(first.workflow);
  assert.deepEqual(
    first.workflow.nodes.map((node) => ({
      id: node.node_id,
      kind: node.kind,
      dependsOn: node.depends_on,
    })),
    [
      { id: 'node_model_1', kind: 'agent_task', dependsOn: [] },
      {
        id: 'node_tool_2',
        kind: 'tool_call',
        dependsOn: [{ node_id: 'node_model_1', on: 'success' }],
      },
      {
        id: 'node_tool_3',
        kind: 'tool_call',
        dependsOn: [{ node_id: 'node_model_1', on: 'success' }],
      },
    ],
  );
  assert.deepEqual(first.report.parameterCandidates, [
    {
      name: 'goal',
      schema: { type: 'string' },
      sourceEventIds: ['evt_00000000-0000-4000-8000-000000000101'],
      reason: 'run_input',
    },
  ]);
  assert.deepEqual(first.report.removedFailureSteps, [
    {
      kind: 'tool',
      correlationKey: 'tool:read_goal_metadata:0:fixture',
      eventIds: ['evt_00000000-0000-4000-8000-000000000108'],
      errorCodes: ['TEMPORARY_TOOL_FAILURE'],
      reason: 'retry_merged',
    },
  ]);
  assert.deepEqual(first.sourceMap[1], {
    nodeId: 'node_tool_2',
    eventIds: [
      'evt_00000000-0000-4000-8000-000000000106',
      'evt_00000000-0000-4000-8000-000000000108',
      'evt_00000000-0000-4000-8000-000000000110',
      'evt_00000000-0000-4000-8000-000000000111',
    ],
  });
});

test('does not copy source values, arguments, decisions, or approvals into compiled Workflow IR', async () => {
  const trace = await loadExampleTrace();
  const result = compileTraceToWorkflow(trace);
  const compiled = JSON.stringify(result);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(compiled.includes('summarize fixture'), false);
  assert.equal(compiled.includes('example answer'), false);
  assert.equal(compiled.includes('all read-only tools completed'), false);
});

function semanticWorkflow(): WorkflowDocument {
  return {
    schema_version: '0.1.0',
    workflow_type: 'agent-workflow',
    workflow_id: 'wf_semantic_fixture',
    name: 'Semantic fixture',
    inputs: { topic: { schema: { type: 'string' }, required: true } },
    verifiers: [
      {
        verifier_id: 'verifier_answer',
        kind: 'json_schema',
        schema: { type: 'string', minLength: 3 },
      },
    ],
    nodes: [
      {
        node_id: 'node_draft',
        kind: 'agent_task',
        goal: 'Draft an answer.',
        depends_on: [],
        retry: { max_attempts: 2 },
        on_failure: 'stop',
        permissions: { side_effect: 'read_only' },
        success_conditions: [{ kind: 'output_schema', schema: { type: 'string', minLength: 3 } }],
      },
      {
        node_id: 'node_verify',
        kind: 'verification',
        verifier_id: 'verifier_answer',
        depends_on: [{ node_id: 'node_draft', on: 'success' }],
        on_failure: 'stop',
        permissions: { side_effect: 'read_only' },
        success_conditions: [{ kind: 'verifier', verifier_id: 'verifier_answer' }],
      },
    ],
    outputs: { answer: { from: { node_id: 'node_verify' }, schema: { type: 'string' } } },
  };
}

test('semantic replay accepts new inputs, retries invalid outputs, and reports process/result separately', async () => {
  const calls: Array<{ nodeId: string; attempt: number; topic: string }> = [];
  const result = await new SemanticReplayRunner({
    workflow: semanticWorkflow(),
    recorder: new Recorder(),
    agent: {
      descriptor: {
        name: 'semantic-test-agent',
        version: 'test',
        capabilities: ['agent.execute'],
        sideEffect: 'read_only',
      },
      async execute(invocation) {
        calls.push({
          nodeId: invocation.node.node_id,
          attempt: invocation.attempt,
          topic: invocation.inputs.topic as string,
        });
        if (invocation.node.node_id === 'node_draft' && invocation.attempt === 1) {
          return { status: 'completed', output: '' };
        }
        return { status: 'completed', output: `answer for ${invocation.inputs.topic as string}` };
      },
    },
  }).run({ inputs: { topic: 'new request' } });

  assert.equal(result.run.status, 'completed');
  assert.deepEqual(result.outputs, { answer: 'answer for new request' });
  assert.deepEqual(result.report, { process: 'diverged', result: 'equivalent' });
  assert.deepEqual(
    calls.map(({ nodeId, attempt }) => ({ nodeId, attempt })),
    [
      { nodeId: 'node_draft', attempt: 1 },
      { nodeId: 'node_draft', attempt: 2 },
      { nodeId: 'node_verify', attempt: 1 },
    ],
  );
  assert.equal(result.nodeResults[0]?.status, 'completed');
  assert.equal(result.nodeResults[0]?.attempts, 2);
  assert.deepEqual(result.diagnostics, []);
});

test('semantic replay blocks an external-write node before the Agent can execute it', async () => {
  const workflow = semanticWorkflow();
  workflow.nodes[0] = {
    ...workflow.nodes[0]!,
    kind: 'human_approval',
    approval_id: 'publish',
    prompt: 'Publish?',
    permissions: { side_effect: 'external_write', requires_approval: true },
  };
  let invocations = 0;
  const result = await new SemanticReplayRunner({
    workflow,
    recorder: new Recorder(),
    agent: {
      descriptor: {
        name: 'semantic-test-agent',
        version: 'test',
        capabilities: ['agent.execute'],
        sideEffect: 'external_write',
      },
      async execute() {
        invocations += 1;
        return { status: 'completed', output: 'should not run' };
      },
    },
  }).run({ inputs: { topic: 'new request' } });

  assert.equal(invocations, 0);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.report.result, 'not_equivalent');
  assert.equal(result.nodeResults[0]?.status, 'failed');
});

test('runs one Workflow IR on two Semantic runtimes and reports capability degradation before execution', async () => {
  const workflow = semanticWorkflow();
  const referenceAgent = {
    descriptor: {
      name: 'reference-semantic-runtime',
      version: 'test',
      capabilities: [
        'agent.execute',
        'semantic.node.agent_task',
        'semantic.node.verification',
      ] as const,
      sideEffect: 'read_only' as const,
    },
    async execute() {
      return { status: 'completed' as const, output: 'portable answer' };
    },
  };
  const scriptedAgent = new ScriptedSemanticRuntimeAdapter({
    execute: async () => ({ status: 'completed', output: 'portable answer' }),
  });

  const reference = await new SemanticReplayRunner({
    workflow,
    recorder: new Recorder(),
    agent: referenceAgent,
  }).run({ inputs: { topic: 'portable request' } });
  const scripted = await new SemanticReplayRunner({
    workflow,
    recorder: new Recorder(),
    agent: scriptedAgent,
  }).run({ inputs: { topic: 'portable request' } });
  assert.deepEqual(reference.outputs, { answer: 'portable answer' });
  assert.deepEqual(scripted.outputs, reference.outputs);
  assert.equal(reference.run.status, 'completed');
  assert.equal(scripted.run.status, 'completed');

  let executions = 0;
  const restrictedAgent = new ScriptedSemanticRuntimeAdapter({
    supportedNodes: ['semantic.node.agent_task'],
    execute: async () => {
      executions += 1;
      return { status: 'completed', output: 'should not run' };
    },
  });
  assert.deepEqual(inspectSemanticAgentCompatibility(workflow, restrictedAgent), {
    compatible: false,
    required: ['semantic.node.agent_task', 'semantic.node.verification'],
    unsupported: ['semantic.node.verification'],
    capabilityMode: 'explicit',
  });
  const degraded = await new SemanticReplayRunner({
    workflow,
    recorder: new Recorder(),
    agent: restrictedAgent,
  }).run({ inputs: { topic: 'portable request' } });
  assert.equal(executions, 0);
  assert.equal(degraded.run.status, 'failed');
  assert.ok(
    degraded.diagnostics.some((diagnostic) => diagnostic.code === 'AGENT_CAPABILITY_MISSING'),
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
