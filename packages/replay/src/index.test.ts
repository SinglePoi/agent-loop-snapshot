import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArtifactReadError, loadTraceSnapshot } from '@agent-loop-snapshot/trace';
import {
  SnapshotWriter,
  RedactionPipeline,
  RedactionError,
  createDefaultRedactionPipeline,
  hashState,
  Recorder,
  reconstructState,
  type RunHandle,
} from '@agent-loop-snapshot/recorder';
import {
  validateWorkflow,
  type EventId,
  type JsonValue,
  type WorkflowDocument,
} from '@agent-loop-snapshot/schema';

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

function asOtelObservation<T extends Awaited<ReturnType<typeof loadTraceSnapshot>>>(trace: T): T {
  return {
    ...trace,
    manifest: {
      ...trace.manifest!,
      schema_version: '0.2.0',
      source: 'otel-import',
      completeness: 'complete',
      limitations: [],
    },
  } as T;
}

async function loadExampleTrace() {
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../example-runtime/fixtures/example-run',
  );
  const trace = await loadTraceSnapshot(fixture);
  assert.equal(trace.valid, true, JSON.stringify(trace.diagnostics));
  return trace;
}

interface RecordedTraceFixture {
  readonly directory: string;
  readonly trace: Awaited<ReturnType<typeof loadTraceSnapshot>>;
}

async function createRecordedTrace(
  build: (recorder: Recorder, run: RunHandle) => Promise<void>,
): Promise<RecordedTraceFixture> {
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-compiler-'));
  const recorder = new Recorder();
  const run = await recorder.startRun({
    runtime: { name: 'compiler-test-runtime', version: '0.1.0' },
    input: {},
  });
  await build(recorder, run);
  await recorder.completeRun(run, { final_state_hash: hashState({}), output: {} });
  await writeFile(
    join(directory, 'events.jsonl'),
    `${recorder
      .getEvents(run)
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  );
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify(recorder.getManifest(run), null, 2)}\n`,
  );
  const trace = await loadTraceSnapshot(directory);
  assert.equal(trace.valid, true, JSON.stringify(trace.diagnostics));
  return { directory, trace };
}

function toolRequest(
  recorder: Recorder,
  run: RunHandle,
  parentIds: readonly EventId[],
  correlationKey: string,
  tool: string,
) {
  return recorder.appendEvent(run.context(parentIds), {
    type: 'tool.requested',
    payload: { correlation_key: correlationKey, tool, arguments: {} },
  });
}

function toolCompleted(
  recorder: Recorder,
  run: RunHandle,
  parentId: EventId,
  correlationKey: string,
) {
  return recorder.appendEvent(run.context([parentId]), {
    type: 'tool.completed',
    payload: { correlation_key: correlationKey, output: {} },
  });
}

interface TamperableArtifactTrace {
  readonly directory: string;
  readonly stateArtifactPath: string;
  readonly checkpointArtifactPath: string;
  readonly checkpointId: string;
}

function artifactReference(bytes: Uint8Array) {
  return {
    schema_version: '0.1.0',
    digest: createHash('sha256').update(bytes).digest('hex'),
    media_type: 'application/json',
    byte_length: bytes.byteLength,
  };
}

async function createTamperableArtifactTrace(): Promise<TamperableArtifactTrace> {
  const directory = await mkdtemp(
    join(process.env.TEMP ?? process.cwd(), 'alsnap-replay-artifact-'),
  );
  const fixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../schema/fixtures/minimal-success',
  );
  const stateBytes = Buffer.from(
    JSON.stringify({ operation: 'set', path: '/answer', value: 'good' }),
    'utf8',
  );
  const checkpointBytes = Buffer.from(JSON.stringify({ answer: 'good' }), 'utf8');
  const stateReference = artifactReference(stateBytes);
  const checkpointReference = artifactReference(checkpointBytes);
  const events = (await readFile(join(fixture, 'events.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const stateEvent = events[1];
  const completedEvent = events[2];
  assert.ok(stateEvent && completedEvent);
  stateEvent.payload = stateReference;
  completedEvent.payload = {
    ...(completedEvent.payload as Record<string, unknown>),
    final_state_hash: hashState({ answer: 'good' }),
  };

  const checkpointId = 'cp_00000000-0000-4000-8000-000000000005';
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  await mkdir(join(directory, 'checkpoints'), { recursive: true });
  await writeFile(join(directory, 'manifest.json'), await readFile(join(fixture, 'manifest.json')));
  await writeFile(
    join(directory, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  const stateArtifactPath = join(directory, 'artifacts', `sha256-${stateReference.digest}`);
  const checkpointArtifactPath = join(
    directory,
    'artifacts',
    `sha256-${checkpointReference.digest}`,
  );
  await writeFile(stateArtifactPath, stateBytes);
  await writeFile(checkpointArtifactPath, checkpointBytes);
  await writeFile(
    join(directory, 'checkpoints', '000002.json'),
    JSON.stringify({
      schema_version: '0.1.0',
      checkpoint_id: checkpointId,
      run_id: 'run_00000000-0000-4000-8000-000000000001',
      created_at: '2026-09-06T02:00:00.750Z',
      last_event_id: 'evt_00000000-0000-4000-8000-000000000002',
      sequence: 2,
      state_hash: hashState({ answer: 'good' }),
      state: checkpointReference,
    }),
  );
  return { directory, stateArtifactPath, checkpointArtifactPath, checkpointId };
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

test('retains call dependencies across multiple unmapped intermediate events', async () => {
  const fixture = await createRecordedTrace(async (recorder, run) => {
    const firstRequest = await toolRequest(
      recorder,
      run,
      [run.startedEvent.event_id],
      'tool:first',
      'first',
    );
    const firstCompleted = await toolCompleted(recorder, run, firstRequest.event_id, 'tool:first');
    const stateChanged = await recorder.appendEvent(run.context([firstCompleted.event_id]), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/first_complete', value: true },
    });
    const decision = await recorder.appendEvent(run.context([stateChanged.event_id]), {
      type: 'decision.recorded',
      payload: {
        decision: 'continue',
        basis_summary: 'The first call completed.',
        success_conditions: ['continue to the second call'],
      },
    });
    const secondRequest = await toolRequest(
      recorder,
      run,
      [decision.event_id],
      'tool:second',
      'second',
    );
    await toolCompleted(recorder, run, secondRequest.event_id, 'tool:second');
  });
  try {
    const result = compileTraceToWorkflow(fixture.trace);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.workflow);
    assert.deepEqual(
      result.workflow.nodes.map((node) => node.depends_on),
      [[], [{ node_id: 'node_tool_1', on: 'success' }]],
    );
    assert.equal(validateWorkflow(result.workflow).valid, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('retains joins through intermediates without serializing parallel branches or retry attempts', async () => {
  let retryFailedEventId: EventId | undefined;
  const fixture = await createRecordedTrace(async (recorder, run) => {
    const firstRequest = await toolRequest(
      recorder,
      run,
      [run.startedEvent.event_id],
      'tool:first',
      'first',
    );
    const secondRequest = await toolRequest(
      recorder,
      run,
      [run.startedEvent.event_id],
      'tool:second',
      'second',
    );
    const firstCompleted = await toolCompleted(recorder, run, firstRequest.event_id, 'tool:first');
    const secondCompleted = await toolCompleted(
      recorder,
      run,
      secondRequest.event_id,
      'tool:second',
    );
    const joined = await recorder.appendEvent(
      run.context([firstCompleted.event_id, secondCompleted.event_id]),
      {
        type: 'state.changed',
        payload: { operation: 'set', path: '/joined', value: true },
      },
    );
    const decision = await recorder.appendEvent(run.context([joined.event_id]), {
      type: 'decision.recorded',
      payload: {
        decision: 'retry',
        basis_summary: 'Both parallel calls completed.',
        success_conditions: ['retryable call runs after the join'],
      },
    });
    const retryRequest = await toolRequest(
      recorder,
      run,
      [decision.event_id],
      'tool:retry',
      'retryable',
    );
    const retryFailed = await recorder.appendEvent(run.context([retryRequest.event_id]), {
      type: 'tool.failed',
      payload: {
        correlation_key: 'tool:retry',
        attempt: 1,
        error: {
          code: 'TRANSIENT',
          message: 'Retry once.',
          retryable: true,
          kind: 'tool',
        },
      },
    });
    retryFailedEventId = retryFailed.event_id;
    const retryDecision = await recorder.appendEvent(run.context([retryFailed.event_id]), {
      type: 'decision.recorded',
      payload: {
        decision: 'retry',
        basis_summary: 'The retryable call failed transiently.',
        success_conditions: ['retry the same correlation key'],
      },
    });
    const retryRequestAgain = await toolRequest(
      recorder,
      run,
      [retryDecision.event_id],
      'tool:retry',
      'retryable',
    );
    const retryCompleted = await toolCompleted(
      recorder,
      run,
      retryRequestAgain.event_id,
      'tool:retry',
    );
    const afterRetry = await recorder.appendEvent(run.context([retryCompleted.event_id]), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/retried', value: true },
    });
    const followupRequest = await toolRequest(
      recorder,
      run,
      [afterRetry.event_id],
      'tool:followup',
      'followup',
    );
    await toolCompleted(recorder, run, followupRequest.event_id, 'tool:followup');
  });
  try {
    const result = compileTraceToWorkflow(fixture.trace);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.workflow);
    assert.deepEqual(
      result.workflow.nodes.map((node) => node.depends_on),
      [
        [],
        [],
        [
          { node_id: 'node_tool_1', on: 'success' },
          { node_id: 'node_tool_2', on: 'success' },
        ],
        [{ node_id: 'node_tool_3', on: 'success' }],
      ],
    );
    assert.deepEqual(result.workflow.nodes[2]?.retry, {
      max_attempts: 2,
      retry_on: ['TRANSIENT'],
    });
    assert.ok(retryFailedEventId);
    assert.deepEqual(result.report.removedFailureSteps, [
      {
        kind: 'tool',
        correlationKey: 'tool:retry',
        eventIds: [retryFailedEventId],
        errorCodes: ['TRANSIENT'],
        reason: 'retry_merged',
      },
    ]);
    assert.equal(validateWorkflow(result.workflow).valid, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('compiles an 8,000-event unmapped ancestor chain without exhausting the call stack', async () => {
  const fixture = await createRecordedTrace(async (recorder, run) => {
    const firstRequest = await toolRequest(
      recorder,
      run,
      [run.startedEvent.event_id],
      'tool:first',
      'first',
    );
    const firstCompleted = await toolCompleted(recorder, run, firstRequest.event_id, 'tool:first');
    let parentId = firstCompleted.event_id;
    for (let index = 0; index < 8_000; index += 1) {
      const decision = await recorder.appendEvent(run.context([parentId]), {
        type: 'decision.recorded',
        payload: {
          decision: 'continue',
          basis_summary: 'review',
          success_conditions: ['continue'],
        },
      });
      parentId = decision.event_id;
    }
    const secondRequest = await toolRequest(recorder, run, [parentId], 'tool:second', 'second');
    await toolCompleted(recorder, run, secondRequest.event_id, 'tool:second');
  });
  try {
    const result = compileTraceToWorkflow(fixture.trace);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.workflow);
    assert.deepEqual(
      result.workflow.nodes.map((node) => node.depends_on),
      [[], [{ node_id: 'node_tool_1', on: 'success' }]],
    );
    assert.equal(validateWorkflow(result.workflow).valid, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
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

function approvalWorkflow(kind: 'agent_task' | 'human_approval'): WorkflowDocument {
  return {
    schema_version: '0.1.0',
    workflow_type: 'agent-workflow',
    workflow_id: 'wf_semantic_approval',
    name: 'Approval fixture',
    inputs: {},
    nodes: [
      kind === 'human_approval'
        ? {
            node_id: 'node_approval',
            kind: 'human_approval',
            approval_id: 'approve-read',
            prompt: 'Approve this read-only action?',
            depends_on: [],
            on_failure: 'stop',
            permissions: { side_effect: 'read_only', requires_approval: true },
            success_conditions: [{ kind: 'output_schema', schema: { type: 'string' } }],
          }
        : {
            node_id: 'node_approval',
            kind: 'agent_task',
            goal: 'Perform an explicitly approved read-only action.',
            depends_on: [],
            on_failure: 'stop',
            permissions: { side_effect: 'read_only', requires_approval: true },
            success_conditions: [{ kind: 'output_schema', schema: { type: 'string' } }],
          },
    ],
    outputs: {
      approved: { from: { node_id: 'node_approval' }, schema: { type: 'string' } },
    },
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

test('requires a matching current approval for read-only human-approval nodes', async () => {
  const workflow = approvalWorkflow('human_approval');
  let invocations = 0;
  const agent = {
    descriptor: {
      name: 'approval-test-agent',
      version: 'test',
      capabilities: ['agent.execute'] as const,
      sideEffect: 'read_only' as const,
    },
    async execute() {
      invocations += 1;
      return { status: 'completed' as const, output: 'approved action completed' };
    },
  };

  const noApprovalRecorder = new Recorder();
  const noApproval = await new SemanticReplayRunner({
    workflow,
    recorder: noApprovalRecorder,
    agent,
  }).run({ inputs: {} });
  assert.equal(invocations, 0);
  assert.equal(noApproval.run.status, 'failed');
  assert.equal(noApproval.nodeResults[0]?.status, 'failed');
  assert.ok(noApproval.diagnostics.some((diagnostic) => diagnostic.code === 'POLICY_BLOCKED'));
  const noApprovalAudit = noApprovalRecorder
    .getEvents(noApproval.run)
    .find((event) => event.type === 'decision.recorded');
  assert.deepEqual(noApprovalAudit?.payload, {
    decision: 'policy.require_approval',
    basis_summary:
      'The workflow declared this action requires approval. A matching approval for this action has not been supplied.',
    success_conditions: ['policy decision recorded before adapter execution'],
    policy: {
      action_id:
        'replay-policy/v1/live/agent/read_only/node_approval/semantic%2Fwf_semantic_approval%2Fnode_approval/1',
      mode: 'live',
      adapter_kind: 'agent',
      target: 'node_approval',
      side_effect: 'read_only',
      correlation_key: 'semantic/wf_semantic_approval/node_approval',
      attempt: 1,
      approved: false,
    },
  });

  const mismatchedApproval = await new SemanticReplayRunner({
    workflow,
    recorder: new Recorder(),
    agent,
  }).run({
    inputs: {},
    approvalForAction: () => ({
      actionId: 'replay-policy/v1/historical-approval',
      approvedBy: 'source trace',
      approvedAt: '2026-09-07T00:00:00.000Z',
    }),
  });
  assert.equal(invocations, 0);
  assert.equal(mismatchedApproval.run.status, 'failed');
  assert.ok(
    mismatchedApproval.diagnostics.some((diagnostic) => diagnostic.code === 'POLICY_BLOCKED'),
  );

  let policyRecorded = false;
  let policyRecordedBeforeExecution = false;
  const approvedRecorder = new Recorder({
    interceptors: [
      {
        afterAppend: (event) => {
          if (
            event.type === 'decision.recorded' &&
            (event.payload as { decision?: string }).decision === 'policy.allow'
          ) {
            policyRecorded = true;
          }
        },
      },
    ],
  });
  const approved = await new SemanticReplayRunner({
    workflow,
    recorder: approvedRecorder,
    agent: {
      ...agent,
      async execute() {
        policyRecordedBeforeExecution = policyRecorded;
        invocations += 1;
        return { status: 'completed' as const, output: 'approved action completed' };
      },
    },
  }).run({
    inputs: {},
    approvalForAction: (action) => ({
      actionId: action.id,
      approvedBy: 'current user',
      approvedAt: '2026-09-07T00:00:00.000Z',
    }),
  });
  assert.equal(invocations, 1);
  assert.equal(policyRecordedBeforeExecution, true);
  assert.equal(approved.run.status, 'completed');
  assert.deepEqual(approved.outputs, { approved: 'approved action completed' });
});

test('requires approval for other nodes and never lets approval override a policy deny', async () => {
  const workflow = approvalWorkflow('agent_task');
  let defaultInvocations = 0;
  const noApproval = await new SemanticReplayRunner({
    workflow,
    recorder: new Recorder(),
    agent: {
      descriptor: {
        name: 'approval-test-agent',
        version: 'test',
        capabilities: ['agent.execute'] as const,
        sideEffect: 'read_only' as const,
      },
      async execute() {
        defaultInvocations += 1;
        return { status: 'completed' as const, output: 'should not run' };
      },
    },
  }).run({ inputs: {} });
  assert.equal(defaultInvocations, 0);
  assert.equal(noApproval.run.status, 'failed');

  let deniedInvocations = 0;
  const deniedRecorder = new Recorder();
  const denied = await new SemanticReplayRunner({
    workflow,
    recorder: deniedRecorder,
    agent: {
      descriptor: {
        name: 'approval-test-agent',
        version: 'test',
        capabilities: ['agent.execute'] as const,
        sideEffect: 'read_only' as const,
      },
      async execute() {
        deniedInvocations += 1;
        return { status: 'completed' as const, output: 'should not run' };
      },
    },
    policy: { rules: [{ decision: 'deny', target: 'node_approval' }] },
  }).run({
    inputs: {},
    approvalForAction: (action) => ({
      actionId: action.id,
      approvedBy: 'current user',
      approvedAt: '2026-09-07T00:00:00.000Z',
    }),
  });
  assert.equal(deniedInvocations, 0);
  assert.equal(denied.run.status, 'failed');
  const deniedAudit = deniedRecorder
    .getEvents(denied.run)
    .find((event) => event.type === 'decision.recorded');
  assert.equal((deniedAudit?.payload as { decision?: string }).decision, 'policy.deny');
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

test('blocks observation-only traces from compilation and replay entry points', async () => {
  const source = asOtelObservation(await loadExampleTrace());
  const compilation = compileTraceToWorkflow(source);
  assert.equal(compilation.workflow, undefined);
  assert.equal(compilation.diagnostics[0]?.code, 'SOURCE_TRACE_OBSERVATION_ONLY');

  const mock = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
  assert.equal(mock.diagnostics[0]?.code, 'SOURCE_TRACE_OBSERVATION_ONLY');

  const verified = await new VerifiedReplayRunner({
    source,
    recorder: new Recorder(),
    adapters: new ReplayAdapterRegistry(),
  }).run();
  assert.equal(verified.diagnostics[0]?.code, 'SOURCE_TRACE_OBSERVATION_ONLY');
});

test('default state redaction keeps whole logical values consistent through mock replay', async () => {
  const scenarios: ReadonlyArray<{
    readonly label: string;
    readonly path: string;
    readonly value: string;
    readonly state: Record<string, string>;
  }> = [
    {
      label: 'generic API-key value',
      path: '/value',
      value: 'sk-reviewsecret123456789',
      state: { value: 'sk-reviewsecret123456789' },
    },
    {
      label: 'API-key field',
      path: '/api_key',
      value: 'sk-reviewsecret123456789',
      state: { api_key: 'sk-reviewsecret123456789' },
    },
    {
      label: 'complete API-key token',
      path: '/token',
      value: 'sk-reviewsecret123456789',
      state: { token: 'sk-reviewsecret123456789' },
    },
    {
      label: 'ordinary password',
      path: '/password',
      value: 'review-only-opaque-password',
      state: { password: 'review-only-opaque-password' },
    },
    {
      label: 'prefixed API-key token',
      path: '/token',
      value: 'prefix sk-reviewsecret123456789',
      state: { token: 'prefix sk-reviewsecret123456789' },
    },
  ];
  for (const scenario of scenarios) {
    const directory = await mkdtemp(
      join(process.env.TEMP ?? process.cwd(), 'alsnap-default-redaction-'),
    );
    const writer = await SnapshotWriter.open(directory, { flushMode: 'event' });
    const pipeline = createDefaultRedactionPipeline();
    const recorder = new Recorder({
      interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
    });
    const originalState = scenario.state;

    try {
      const run = await recorder.startRun({
        runtime: { name: 'redaction-test-runtime', version: '0.1.0' },
        input: {},
      });
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path: scenario.path, value: scenario.value },
      });
      const firstCheckpoint = await recorder.checkpoint(run, {
        state: originalState,
        stateHash: hashState(originalState),
      });
      const secondCheckpoint = await recorder.checkpoint(run, {
        state: originalState,
        stateHash: hashState(originalState),
      });
      const thirdCheckpoint = await recorder.checkpoint(run, {
        state: secondCheckpoint.state,
        stateHash: hashState(secondCheckpoint.state as typeof originalState),
      });
      assert.deepEqual(firstCheckpoint.state, secondCheckpoint.state, scenario.label);
      assert.deepEqual(secondCheckpoint.state, thirdCheckpoint.state, scenario.label);
      assert.equal(firstCheckpoint.state_hash, secondCheckpoint.state_hash, scenario.label);
      assert.equal(secondCheckpoint.state_hash, thirdCheckpoint.state_hash, scenario.label);

      await recorder.completeRun(run, {
        final_state_hash: thirdCheckpoint.state_hash,
        output: {},
      });
      await writer.commit(recorder.getManifest(run));
      await writer.close();

      const eventFile = await readFile(join(directory, 'events.jsonl'), 'utf8');
      const checkpointFile = await readFile(join(directory, 'checkpoints', '000003.json'), 'utf8');
      assert.equal(eventFile.includes(scenario.value), false, scenario.label);
      assert.equal(checkpointFile.includes(scenario.value), false, scenario.label);

      const source = await loadTraceSnapshot(directory);
      assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
      const fromEvents = await reconstructState(source.events);
      const fromCheckpoint = await reconstructState(source.events, {
        checkpoints: source.checkpoints,
      });
      assert.deepEqual(fromCheckpoint.state, fromEvents.state, scenario.label);
      assert.equal(fromCheckpoint.stateHash, fromEvents.stateHash, scenario.label);
      assert.equal(fromCheckpoint.usedCheckpoint, true, scenario.label);

      const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
      assert.equal(replay.run.status, 'completed', scenario.label);
      assert.deepEqual(replay.diagnostics, [], scenario.label);
      assert.deepEqual(replay.finalState, fromEvents.state, scenario.label);
      assert.equal(replay.finalStateHash, fromEvents.stateHash, scenario.label);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('unsafe state redaction fails before persistence and full-parent retries replay consistently', async () => {
  for (const scenario of ['remove', 'append-index'] as const) {
    const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-safe-state-'));
    const writer = await SnapshotWriter.open(directory);
    const secret = 'review-only-secret';
    const pipeline = new RedactionPipeline({
      fieldRules: [
        scenario === 'remove'
          ? { path: '/profile/password', category: 'password', strategy: 'remove' }
          : { path: '/tokens/1', category: 'token', strategy: 'mask' },
      ],
    });
    const recorder = new Recorder({
      interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
    });
    try {
      const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
      const path = scenario === 'remove' ? '/profile' : '/tokens';
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: {
          operation: 'set',
          path,
          value: scenario === 'remove' ? {} : ['public'],
        },
      });
      const before = recorder.getEvents(run);
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: {
            operation: scenario === 'remove' ? 'set' : 'append',
            path: scenario === 'remove' ? '/profile/password' : '/tokens',
            value: secret,
          },
        }),
        (error: unknown) =>
          error instanceof RedactionError &&
          error.code ===
            (scenario === 'remove'
              ? 'STATE_REDACTION_UNREPRESENTABLE'
              : 'STATE_REDACTION_CONTEXT_REQUIRED'),
      );
      assert.deepEqual(recorder.getEvents(run), before);
      await writer.flush();
      assert.equal(
        (await readFile(join(directory, 'events.jsonl'), 'utf8')).includes(secret),
        false,
      );

      // Supply the complete parent value so removal/index rules can be applied exactly.
      const value =
        scenario === 'remove' ? { password: secret, label: 'public' } : ['public', secret];
      const state = scenario === 'remove' ? { profile: value } : { tokens: value };
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path, value },
      });
      const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
      await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
      await writer.commit(recorder.getManifest(run));
      await writer.close();
      const source = await loadTraceSnapshot(directory);
      assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
      const fromEvents = await reconstructState(source.events);
      const fromCheckpoint = await reconstructState(source.events, {
        checkpoints: source.checkpoints,
      });
      assert.deepEqual(fromEvents.state, fromCheckpoint.state);
      assert.equal(fromEvents.stateHash, fromCheckpoint.stateHash);
      assert.equal(
        (await readFile(join(directory, 'events.jsonl'), 'utf8')).includes(secret),
        false,
      );
      assert.equal(JSON.stringify(source.checkpoints).includes(secret), false);
      const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
      assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
      assert.deepEqual(replay.finalState, fromEvents.state);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('non-object merge redaction is not persisted and a full set retry replays', async () => {
  for (const strategy of ['mask', 'reference'] as const) {
    const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-merge-state-'));
    const writer = await SnapshotWriter.open(directory);
    const pipeline = new RedactionPipeline({
      fieldRules: [{ path: '/profile', category: 'private', strategy }],
    });
    const recorder = new Recorder({
      interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
    });
    try {
      const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
      const value = { password: 'review-only-secret' };
      const before = recorder.getEvents(run);
      await writer.flush();
      const eventPath = join(directory, 'events.jsonl');
      const beforeFile = await readFile(eventPath, 'utf8');
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: { operation: 'merge', path: '/profile', value },
        }),
        (error: unknown) =>
          error instanceof RedactionError && error.code === 'STATE_REDACTION_UNREPRESENTABLE',
      );
      assert.deepEqual(recorder.getEvents(run), before);
      await writer.flush();
      assert.equal(await readFile(eventPath, 'utf8'), beforeFile);
      const retry = await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path: '/profile', value },
      });
      assert.equal(retry.sequence, before.at(-1)!.sequence + 1);
      const state = { profile: value };
      const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
      await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
      await writer.commit(recorder.getManifest(run));
      await writer.close();
      const source = await loadTraceSnapshot(directory);
      assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
      const fromEvents = await reconstructState(source.events);
      const fromCheckpoint = await reconstructState(source.events, {
        checkpoints: source.checkpoints,
      });
      assert.deepEqual(fromEvents.state, fromCheckpoint.state);
      assert.equal(fromEvents.stateHash, fromCheckpoint.stateHash);
      assert.equal((await readFile(eventPath, 'utf8')).includes(value.password), false);
      assert.equal(JSON.stringify(source.checkpoints).includes(value.password), false);
      const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
      assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
      assert.deepEqual(replay.finalState, fromEvents.state);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('unsafe deletes are not persisted and complete parent set retries replay', async () => {
  for (const scenario of [
    'object-remove',
    'array-remove',
    'array-mask',
    'custom-remove',
  ] as const) {
    const directory = await mkdtemp(
      join(process.env.TEMP ?? process.cwd(), 'alsnap-delete-state-'),
    );
    const writer = await SnapshotWriter.open(directory);
    const object = scenario === 'object-remove' || scenario === 'custom-remove';
    const rulePath = object ? '/profile/password' : '/tokens/0';
    const pipeline = new RedactionPipeline(
      scenario === 'custom-remove'
        ? {
            customRedactors: [
              { path: rulePath, category: 'private', redact: () => ({ action: 'remove' }) },
            ],
          }
        : {
            fieldRules: [
              {
                path: rulePath,
                category: 'private',
                strategy: scenario === 'array-mask' ? 'mask' : 'remove',
              },
            ],
          },
    );
    const recorder = new Recorder({
      interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
    });
    try {
      const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
      const secret = 'review-only-secret';
      const path = object ? '/profile' : '/tokens';
      const initial = object ? { password: secret, label: 'public' } : [secret, 'public', 'keep'];
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path, value: initial },
      });
      const before = recorder.getEvents(run);
      await writer.flush();
      const eventPath = join(directory, 'events.jsonl');
      const beforeFile = await readFile(eventPath, 'utf8');
      await assert.rejects(
        recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: {
            operation: 'delete',
            path: object
              ? '/profile/password'
              : scenario === 'array-mask'
                ? '/tokens/0'
                : '/tokens/1',
          },
        }),
        (error: unknown) =>
          error instanceof RedactionError &&
          (error.code === 'STATE_REDACTION_UNREPRESENTABLE' ||
            error.code === 'STATE_REDACTION_CONTEXT_REQUIRED'),
      );
      assert.deepEqual(recorder.getEvents(run), before);
      await writer.flush();
      assert.equal(await readFile(eventPath, 'utf8'), beforeFile);
      const value = object
        ? { label: 'public' }
        : scenario === 'array-mask'
          ? ['public', 'keep']
          : [secret, 'keep'];
      const retry = await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path, value },
      });
      assert.equal(retry.sequence, before.at(-1)!.sequence + 1);
      const state = object ? { profile: value } : { tokens: value };
      const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
      await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
      await writer.commit(recorder.getManifest(run));
      await writer.close();
      const source = await loadTraceSnapshot(directory);
      assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
      const restored = await reconstructState(source.events);
      const fromCheckpoint = await reconstructState(source.events, {
        checkpoints: source.checkpoints,
      });
      assert.deepEqual(restored.state, fromCheckpoint.state);
      assert.equal(restored.stateHash, fromCheckpoint.stateHash);
      assert.equal((await readFile(eventPath, 'utf8')).includes(secret), false);
      assert.equal(JSON.stringify(source.checkpoints).includes(secret), false);
      const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
      assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
      assert.deepEqual(replay.finalState, restored.state);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('logical path and operation fields never rewrite state controls through persistence and replay', async () => {
  for (const strategy of ['mask', 'reference'] as const) {
    const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-controls-'));
    const writer = await SnapshotWriter.open(directory);
    const pipeline = new RedactionPipeline({
      fieldRules: [
        ...['/path', '/operation', '/profile/token', '/tokens/*', '/note'].map((path) => ({
          path,
          category: 'private',
          strategy,
        })),
      ],
    });
    const recorder = new Recorder({
      interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
    });
    try {
      const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
      const secret = 'review-only-secret';
      for (const payload of [
        { operation: 'set', path: '/path', value: secret },
        { operation: 'set', path: '/operation', value: secret },
        { operation: 'merge', path: '/profile', value: { token: secret } },
        { operation: 'set', path: '/tokens', value: [] },
        { operation: 'append', path: '/tokens', value: secret },
        { operation: 'delete', path: '/path' },
        { operation: 'delete', path: '/operation' },
      ]) {
        const recorded = await recorder.appendEvent(run.context(), {
          type: 'state.changed',
          payload: { ...payload, note: secret },
        });
        assert.equal(recorded.payload.operation, payload.operation);
        assert.equal(recorded.payload.path, payload.path);
        if (payload.operation === 'delete')
          assert.equal(Object.hasOwn(recorded.payload, 'value'), false);
        assert.equal(JSON.stringify(recorded.payload).includes(secret), false);
      }
      const state = { profile: { token: secret }, tokens: [secret] };
      const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
      await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
      await writer.commit(recorder.getManifest(run));
      await writer.close();
      const source = await loadTraceSnapshot(directory);
      assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
      const restored = await reconstructState(source.events);
      assert.deepEqual(restored.state, checkpoint.state);
      assert.equal(restored.stateHash, checkpoint.state_hash);
      assert.equal(
        (await readFile(join(directory, 'events.jsonl'), 'utf8')).includes(secret),
        false,
      );
      assert.equal(JSON.stringify(source.checkpoints).includes(secret), false);
      const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
      assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
      assert.deepEqual(replay.finalState, restored.state);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('custom redactors reject partial state changes before persistence and full-parent sets replay', async () => {
  const directory = await mkdtemp(
    join(process.env.TEMP ?? process.cwd(), 'alsnap-custom-context-'),
  );
  const writer = await SnapshotWriter.open(directory);
  const pipeline = new RedactionPipeline({
    customRedactors: [
      {
        path: '/profile',
        category: 'private',
        redact: (value) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            return { action: 'keep' } as const;
          }
          const profile = value as Record<string, unknown>;
          if (profile.private !== true) return { action: 'keep' } as const;
          const redacted = { ...profile };
          delete redacted.label;
          return { action: 'replace', value: redacted as typeof value } as const;
        },
      },
    ],
  });
  const recorder = new Recorder({
    interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
  });
  try {
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/profile', value: { private: true } },
    });
    const before = recorder.getEvents(run);
    const secret = 'review-only-secret';
    const eventPath = join(directory, 'events.jsonl');
    await writer.flush();
    const beforeFile = await readFile(eventPath, 'utf8');
    for (const payload of [
      { operation: 'merge', path: '/profile', value: { label: secret } },
      { operation: 'set', path: '/profile/label', value: secret },
    ]) {
      await assert.rejects(
        recorder.appendEvent(run.context(), { type: 'state.changed', payload }),
        (error: unknown) =>
          error instanceof RedactionError && error.code === 'STATE_REDACTION_CONTEXT_REQUIRED',
      );
      assert.deepEqual(recorder.getEvents(run), before);
      await writer.flush();
      assert.equal(await readFile(eventPath, 'utf8'), beforeFile);
    }
    const retry = await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/profile', value: { private: true, label: secret } },
    });
    assert.equal(retry.sequence, before.at(-1)!.sequence + 1);
    const state = { profile: { private: true, label: secret } };
    const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
    await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
    await writer.commit(recorder.getManifest(run));
    await writer.close();
    const source = await loadTraceSnapshot(directory);
    assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
    const fromEvents = await reconstructState(source.events);
    const fromCheckpoint = await reconstructState(source.events, {
      checkpoints: source.checkpoints,
    });
    assert.deepEqual(fromEvents.state, { profile: { private: true } });
    assert.deepEqual(fromEvents.state, fromCheckpoint.state);
    assert.equal(fromEvents.stateHash, fromCheckpoint.stateHash);
    assert.equal((await readFile(eventPath, 'utf8')).includes(secret), false);
    assert.equal(JSON.stringify(source.checkpoints).includes(secret), false);
    const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
    assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
    assert.deepEqual(replay.finalState, fromEvents.state);
  } finally {
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom removals reject stale merge keys and shifted array updates before persistence', async () => {
  const hidden = { private: true, label: 'review-only-secret' };
  const original = { private: false, label: 'old', tags: [] };
  const updated = { ...original, label: 'updated' };
  const scenarios: {
    name: string;
    root: string;
    rule: string;
    initial: JsonValue;
    change: { operation: string; path: string; value: JsonValue };
    next: JsonValue;
    error: string;
  }[] = [
    {
      name: 'merge removes an existing child',
      root: '/profile',
      rule: '/profile/contact',
      initial: { contact: original, label: 'parent' },
      change: { operation: 'merge', path: '/profile', value: { contact: hidden } },
      next: { contact: hidden, label: 'parent' },
      error: 'STATE_REDACTION_UNREPRESENTABLE',
    },
    ...(['set', 'merge', 'append'] as const).map((operation) => ({
      name: `array ${operation} after element removal`,
      root: '/items',
      rule: '/items/*',
      initial: [hidden, original],
      change:
        operation === 'append'
          ? { operation, path: '/items/1/tags', value: 'public' }
          : {
              operation,
              path: '/items/1',
              value: operation === 'set' ? updated : { label: 'updated' },
            },
      next: [hidden, operation === 'append' ? { ...original, tags: ['public'] } : updated],
      error: 'STATE_REDACTION_CONTEXT_REQUIRED',
    })),
    {
      name: 'artifact-backed set after element removal',
      root: '/items',
      rule: '/items/*',
      initial: [hidden, original],
      change: {
        operation: 'set',
        path: '/items/1',
        value: {
          schema_version: '0.1.0',
          digest: 'a'.repeat(64),
          media_type: 'application/json',
          byte_length: 128,
        },
      },
      next: [hidden, updated],
      error: 'STATE_REDACTION_CONTEXT_REQUIRED',
    },
    {
      name: 'artifact-backed set after whole-array filtering',
      root: '/items',
      rule: '/items',
      initial: [hidden, original],
      change: {
        operation: 'set',
        path: '/items/1',
        value: {
          schema_version: '0.1.0',
          digest: 'a'.repeat(64),
          media_type: 'application/json',
          byte_length: 128,
        },
      },
      next: [hidden, updated],
      error: 'STATE_REDACTION_CONTEXT_REQUIRED',
    },
  ];
  for (const scenario of scenarios) {
    const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-structural-'));
    const writer = await SnapshotWriter.open(directory);
    const pipeline = new RedactionPipeline({
      customRedactors: [
        {
          path: scenario.rule,
          category: 'private',
          redact: (value) =>
            Array.isArray(value)
              ? {
                  action: 'replace',
                  value: value.filter(
                    (item) =>
                      item === null ||
                      typeof item !== 'object' ||
                      Array.isArray(item) ||
                      item.private !== true,
                  ),
                }
              : value !== null &&
                  typeof value === 'object' &&
                  !Array.isArray(value) &&
                  value.private === true
                ? { action: 'remove' }
                : { action: 'keep' },
        },
      ],
    });
    const recorder = new Recorder({
      interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
    });
    try {
      const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path: scenario.root, value: scenario.initial },
      });
      const before = recorder.getEvents(run);
      await writer.flush();
      const eventPath = join(directory, 'events.jsonl');
      const beforeFile = await readFile(eventPath, 'utf8');
      await assert.rejects(
        recorder.appendEvent(run.context(), { type: 'state.changed', payload: scenario.change }),
        (error: unknown) => error instanceof RedactionError && error.code === scenario.error,
        scenario.name,
      );
      assert.deepEqual(recorder.getEvents(run), before);
      await writer.flush();
      assert.equal(await readFile(eventPath, 'utf8'), beforeFile);
      const retry = await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path: scenario.root, value: scenario.next },
      });
      assert.equal(retry.sequence, before.at(-1)!.sequence + 1);
      const state = { [scenario.root.slice(1)]: scenario.next };
      const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
      await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
      await writer.commit(recorder.getManifest(run));
      await writer.close();
      const source = await loadTraceSnapshot(directory);
      assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
      const fromEvents = await reconstructState(source.events);
      const fromCheckpoint = await reconstructState(source.events, {
        checkpoints: source.checkpoints,
      });
      assert.deepEqual(fromEvents.state, fromCheckpoint.state);
      assert.equal(fromEvents.stateHash, fromCheckpoint.stateHash);
      assert.equal((await readFile(eventPath, 'utf8')).includes(hidden.label), false);
      assert.equal(JSON.stringify(source.checkpoints).includes(hidden.label), false);
      const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
      assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
      assert.deepEqual(replay.finalState, fromEvents.state);
    } finally {
      await writer.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('protocol controls and canonical references survive real persistence and replay', async () => {
  const directory = await mkdtemp(
    join(process.env.TEMP ?? process.cwd(), 'alsnap-protocol-controls-'),
  );
  const writer = await SnapshotWriter.open(directory);
  const pipeline = new RedactionPipeline({
    fieldRules: [
      ...['/state_hash', '/final_state_hash', '/sequence', '/checkpoint_id', '/last_event_id'].map(
        (path) => ({ path, category: 'private', strategy: 'mask' as const }),
      ),
      { path: '/profile', category: 'private', strategy: 'reference' },
    ],
  });
  const recorder = new Recorder({
    interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
  });
  const secret = 'review-only-secret';
  try {
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    for (const key of [
      'state_hash',
      'final_state_hash',
      'sequence',
      'checkpoint_id',
      'last_event_id',
    ]) {
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation: 'set', path: `/${key}`, value: secret },
      });
    }
    await recorder.appendEvent(run.context(), {
      type: 'state.changed',
      payload: { operation: 'set', path: '/profile', value: { a: secret, b: 2 } },
    });
    const state = {
      last_event_id: secret,
      checkpoint_id: secret,
      sequence: secret,
      final_state_hash: secret,
      state_hash: secret,
      profile: { b: 2, a: secret },
    };
    const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
    await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
    await writer.commit(recorder.getManifest(run));
    await writer.close();
    const source = await loadTraceSnapshot(directory);
    assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
    const fromEvents = await reconstructState(source.events);
    const fromCheckpoint = await reconstructState(source.events, {
      checkpoints: source.checkpoints,
    });
    assert.deepEqual(fromEvents.state, fromCheckpoint.state);
    assert.equal(fromEvents.stateHash, fromCheckpoint.stateHash);
    const checkpointEvent = source.events.find((entry) => entry.type === 'checkpoint.created');
    assert.equal(typeof (checkpointEvent?.payload as { sequence?: unknown }).sequence, 'number');
    assert.match(
      (checkpointEvent?.payload as { state_hash?: unknown }).state_hash as string,
      /^[a-f0-9]{64}$/,
    );
    const eventFile = await readFile(join(directory, 'events.jsonl'), 'utf8');
    assert.equal(eventFile.includes(secret), false);
    assert.equal(JSON.stringify(source.checkpoints).includes(secret), false);
    const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
    assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
    assert.deepEqual(replay.finalState, fromEvents.state);
  } finally {
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('large numeric and dash keys and real array updates redact consistently through persistence and replay', async () => {
  const directory = await mkdtemp(join(process.env.TEMP ?? process.cwd(), 'alsnap-numeric-'));
  const writer = await SnapshotWriter.open(directory);
  const pipeline = new RedactionPipeline({
    fieldRules: [
      { path: '/byId/*/password', category: 'private', strategy: 'reference' },
      { path: '/byId/*/tokens/*', category: 'private', strategy: 'mask' },
      { path: '/items/*/password', category: 'private', strategy: 'reference' },
      { path: '/items/*/tokens/*', category: 'private', strategy: 'mask' },
      { path: '/exact/-/password', category: 'private', strategy: 'mask' },
      { path: '/exact/-/tokens/*', category: 'private', strategy: 'mask' },
    ],
  });
  const recorder = new Recorder({
    interceptors: [pipeline.asInterceptor(), writer.asInterceptor()],
  });
  const secret = 'review-only-secret';
  try {
    const run = await recorder.startRun({ runtime: { name: 'test', version: '1' } });
    const write = async (operation: string, path: string, value?: JsonValue) => {
      await recorder.appendEvent(run.context(), {
        type: 'state.changed',
        payload: { operation, path, ...(operation === 'delete' ? {} : { value }) },
      });
    };
    await write('set', '/byId', {});
    await write('set', '/exact', {});
    const beforeEvents = recorder.getEvents(run);
    const beforeFile = await readFile(join(directory, 'events.jsonl'), 'utf8');
    await assert.rejects(
      write('set', '/exact/-', { password: secret }),
      (error: unknown) =>
        error instanceof RedactionError && error.code === 'STATE_REDACTION_CONTEXT_REQUIRED',
    );
    assert.deepEqual(recorder.getEvents(run), beforeEvents);
    assert.equal(await readFile(join(directory, 'events.jsonl'), 'utf8'), beforeFile);
    await write('set', '/exact', { '-': { password: secret, tokens: [] } });
    await write('merge', '/exact/-', { password: secret });
    await write('set', '/exact/-/password', secret);
    await write('append', '/exact/-/tokens', secret);
    await write('set', '/exact/-/tokens/-', secret);
    const keys = ['-', '1000000', '4294967295', '9007199254740993', '9'.repeat(80)];
    for (const key of keys) {
      const path = `/byId/${key}`;
      await write('set', path, { password: secret, tokens: [] });
      await write('merge', path, { password: secret, label: 'public' });
      await write('append', `${path}/tokens`, secret);
      await write('set', `${path}/tokens/0`, secret);
      await write('set', `${path}/tokens/-`, secret);
      await write('delete', `${path}/label`);
    }
    await write('set', '/items', [{ password: secret, tokens: [] }]);
    await write('merge', '/items/0', { password: secret });
    await write('append', '/items/0/tokens', secret);
    await write('set', '/items/0/tokens/-', secret);
    await write('set', '/items/0', { password: secret, tokens: [secret] });
    await write('append', '/items', { password: secret, tokens: [] });
    await write('set', '/items/-', { password: secret, tokens: [] });
    const state = {
      exact: { '-': { password: secret, tokens: [secret, secret] } },
      byId: Object.fromEntries(
        keys.map((key) => [key, { password: secret, tokens: [secret, secret] }]),
      ),
      items: [
        { password: secret, tokens: [secret] },
        { password: secret, tokens: [] },
        { password: secret, tokens: [] },
      ],
    };
    const checkpoint = await recorder.checkpoint(run, { state, stateHash: hashState(state) });
    await recorder.completeRun(run, { final_state_hash: checkpoint.state_hash });
    await writer.commit(recorder.getManifest(run));
    await writer.close();
    const source = await loadTraceSnapshot(directory);
    assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
    const restored = await reconstructState(source.events);
    const fromCheckpoint = await reconstructState(source.events, {
      checkpoints: source.checkpoints,
    });
    assert.deepEqual(restored.state, fromCheckpoint.state);
    assert.equal(restored.stateHash, fromCheckpoint.stateHash);
    assert.equal((await readFile(join(directory, 'events.jsonl'), 'utf8')).includes(secret), false);
    assert.equal(JSON.stringify(source.checkpoints).includes(secret), false);
    const replay = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
    assert.equal(replay.run.status, 'completed', JSON.stringify(replay.diagnostics));
    assert.deepEqual(replay.finalState, restored.state);
  } finally {
    await writer.close();
    await rm(directory, { recursive: true, force: true });
  }
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

test('mock and verified replay reject a tampered artifact-backed state change', async () => {
  const fixture = await createTamperableArtifactTrace();
  try {
    const source = await loadTraceSnapshot(fixture.directory);
    assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
    await writeFile(
      fixture.stateArtifactPath,
      JSON.stringify({ operation: 'set', path: '/answer', value: 'evil' }),
    );

    const mock = await new MockReplayRunner({ source, recorder: new Recorder() }).run();
    assert.equal(mock.run.status, 'failed');
    assert.ok(mock.diagnostics.some((diagnostic) => diagnostic.code === 'SOURCE_ARTIFACT_INVALID'));
    assert.equal('finalState' in mock, false);

    const verified = await new VerifiedReplayRunner({
      source,
      recorder: new Recorder(),
      adapters: new ReplayAdapterRegistry(),
    }).run();
    assert.equal(verified.run.status, 'failed');
    assert.ok(
      verified.diagnostics.some((diagnostic) => diagnostic.code === 'SOURCE_ARTIFACT_INVALID'),
    );
    assert.equal('recordedState' in verified, false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
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

test('checkpoint restoration and verified replay reject tampered checkpoint artifacts', async () => {
  const fixture = await createTamperableArtifactTrace();
  try {
    const source = await loadTraceSnapshot(fixture.directory);
    assert.equal(source.valid, true, JSON.stringify(source.diagnostics));
    await writeFile(fixture.checkpointArtifactPath, JSON.stringify({ answer: 'evil' }));

    await assert.rejects(
      selectReplayResumePoint(source, fixture.checkpointId),
      (error: unknown) =>
        error instanceof ArtifactReadError && error.code === 'ARTIFACT_DIGEST_MISMATCH',
    );

    const result = await new VerifiedReplayRunner({
      source,
      recorder: new Recorder(),
      adapters: new ReplayAdapterRegistry(),
    }).run({ checkpointId: fixture.checkpointId });
    assert.equal(result.run.status, 'failed');
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'CHECKPOINT_INVALID'));
    assert.ok(result.diagnostics.some((diagnostic) => /SHA-256/u.test(diagnostic.message)));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
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
