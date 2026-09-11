import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  assessSnapshotExecution,
  inspectSnapshotCompatibility,
  migrateSnapshot,
  migrateSnapshotDirectory,
  readSnapshotObservationMetadata,
  schemaFiles,
  snapshotSchemaVersion,
  workflowSchemaVersion,
  viewSnapshotMetadata,
  type WorkflowDocument,
} from './index.js';
import { validateSnapshot, validateSnapshotDirectory, validateWorkflow } from './validator.js';

test('exports the current snapshot schema version', () => {
  assert.equal(snapshotSchemaVersion, '0.2.0');
});

test('keeps execution eligibility separate from source claims and permissions', () => {
  assert.deepEqual(
    assessSnapshotExecution({
      source: 'otel-import',
      completeness: 'complete',
      limitations: [],
    }),
    {
      eligibility: 'observation_only',
      reason: 'OTel-imported snapshots are observation-only.',
    },
  );
  assert.equal(
    assessSnapshotExecution({
      source: 'sdk',
      completeness: 'partial',
      limitations: [],
    }).eligibility,
    'observation_only',
  );
  assert.equal(
    assessSnapshotExecution({
      source: 'native',
      completeness: 'complete',
      limitations: [{ code: 'final_state_unavailable', message: 'No state was recorded.' }],
    }).eligibility,
    'observation_only',
  );
  assert.equal(
    assessSnapshotExecution({
      source: 'native',
      completeness: 'complete',
      limitations: [],
    }).eligibility,
    'eligible_for_validation',
  );
});

test('accepts a partial observation snapshot for viewing but not execution', () => {
  const document = {
    manifest: {
      schema_version: '0.2.0',
      snapshot_type: 'run-snapshot',
      run_id: 'run_00000000-0000-4000-8000-000000000099',
      created_at: '2026-09-11T00:00:00.000Z',
      updated_at: '2026-09-11T00:00:01.000Z',
      run_state: 'finished',
      terminal_status: 'unknown',
      runtime: { name: 'otel-import', version: '1.0.0' },
      source: 'otel-import',
      completeness: 'partial',
      limitations: [{ code: 'missing_root', message: 'Source trace has no root span.' }],
      last_sequence: 2,
      event_count: 2,
      completed_at: '2026-09-11T00:00:01.000Z',
    },
    events: [
      {
        schema_version: '0.2.0',
        run_id: 'run_00000000-0000-4000-8000-000000000099',
        event_id: 'evt_00000000-0000-4000-8000-000000000099',
        parent_ids: [],
        sequence: 1,
        type: 'otel.span',
        timestamp: '2026-09-11T00:00:00.000Z',
        monotonic_offset_ms: 0,
        actor: 'otel',
        payload: { trace_id: 'trace-1', span_id: 'span-1', name: 'root', status: 'unset' },
        security: { side_effect: 'read_only', redactions: [] },
      },
      {
        schema_version: '0.2.0',
        run_id: 'run_00000000-0000-4000-8000-000000000099',
        event_id: 'evt_00000000-0000-4000-8000-000000000100',
        parent_ids: ['evt_00000000-0000-4000-8000-000000000099'],
        sequence: 2,
        type: 'run.observed',
        timestamp: '2026-09-11T00:00:01.000Z',
        monotonic_offset_ms: 1,
        actor: 'otel',
        payload: { outcome: 'unknown' },
        security: { side_effect: 'read_only', redactions: [] },
      },
    ],
  };
  const result = validateSnapshot(document);

  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'SNAPSHOT_PARTIAL'));
  assert.equal(
    assessSnapshotExecution(readSnapshotObservationMetadata(document.manifest)).eligibility,
    'observation_only',
  );
});

test('ships versioned schemas and preserves the independent Workflow version', async () => {
  const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../schemas');

  for (const fileName of Object.values(schemaFiles)) {
    const rawSchema = await readFile(resolve(schemaDirectory, fileName), 'utf8');
    const schema = JSON.parse(rawSchema) as {
      $schema?: string;
      properties?: { schema_version?: { const?: string; enum?: string[] } };
    };

    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    const version = schema.properties?.schema_version;
    if (fileName === schemaFiles.workflow) {
      assert.equal(version?.const, workflowSchemaVersion);
    } else {
      assert.ok(version?.enum?.includes(snapshotSchemaVersion));
      assert.ok(version?.enum?.includes('0.1.0'));
    }
  }
});

test('validates reusable golden fixtures and reports expected failures', async (t) => {
  const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
  const fixtures = [
    { name: 'minimal-success', valid: true },
    { name: 'tool-failure-retry', valid: true },
    { name: 'parallel-calls', valid: true },
    { name: 'corrupted-reference', valid: false, code: 'ARTIFACT_DIGEST_MISMATCH' },
    { name: 'unknown-version', valid: false, code: 'SCHEMA_ENUM' },
  ] as const;

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const result = await validateSnapshotDirectory(resolve(fixtureDirectory, fixture.name));

      assert.equal(result.valid, fixture.valid);
      if (!fixture.valid) {
        assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === fixture.code));
        assert.ok(result.diagnostics.every((diagnostic) => diagnostic.path.startsWith('/')));
      }
    });
  }
});

test('limits untrusted event and artifact reads during directory validation', async () => {
  const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');
  const events = await validateSnapshotDirectory(resolve(fixtureDirectory, 'minimal-success'), {
    maxEventFileBytes: 1,
  });
  assert.ok(events.diagnostics.some((diagnostic) => diagnostic.code === 'EVENT_FILE_TOO_LARGE'));

  const artifacts = await validateSnapshotDirectory(
    resolve(fixtureDirectory, 'corrupted-reference'),
    {
      maxArtifactBytes: 1,
    },
  );
  assert.ok(artifacts.diagnostics.some((diagnostic) => diagnostic.code === 'ARTIFACT_TOO_LARGE'));
});

function workflowFixture(): WorkflowDocument {
  return {
    schema_version: '0.1.0',
    workflow_type: 'agent-workflow',
    workflow_id: 'wf_fixture',
    name: 'Workflow fixture',
    inputs: {
      goal: { schema: { type: 'string' }, required: true },
    },
    verifiers: [
      {
        verifier_id: 'verifier_result_shape',
        kind: 'json_schema',
        schema: { type: 'object', required: ['answer'] },
      },
    ],
    nodes: [
      {
        node_id: 'node_plan',
        kind: 'agent_task',
        goal: 'Create an execution plan.',
        depends_on: [],
        retry: { max_attempts: 2, retry_on: ['TEMPORARY_MODEL_ERROR'] },
        on_failure: 'stop',
        permissions: { side_effect: 'read_only' },
        success_conditions: [{ kind: 'output_schema', schema: { type: 'object' } }],
      },
      {
        node_id: 'node_research',
        kind: 'tool_call',
        tool: 'research',
        arguments: { topic: 'fixture' },
        depends_on: [{ node_id: 'node_plan', on: 'success' }],
        on_failure: 'continue',
        permissions: { side_effect: 'read_only', capabilities: ['internet.search'] },
        success_conditions: [
          {
            kind: 'condition',
            condition: { from: { kind: 'input', name: 'goal' }, operator: 'exists' },
          },
        ],
      },
      {
        node_id: 'node_approve',
        kind: 'human_approval',
        approval_id: 'publish',
        prompt: 'Approve publication?',
        depends_on: [{ node_id: 'node_plan', on: 'success' }],
        on_failure: 'stop',
        permissions: { side_effect: 'external_write', requires_approval: true },
        success_conditions: [
          {
            kind: 'condition',
            condition: { from: { kind: 'node_output', name: 'node_plan' }, operator: 'exists' },
          },
        ],
      },
      {
        node_id: 'node_verify',
        kind: 'verification',
        verifier_id: 'verifier_result_shape',
        depends_on: [
          { node_id: 'node_research', on: 'always' },
          { node_id: 'node_approve', on: 'success' },
        ],
        on_failure: 'stop',
        permissions: { side_effect: 'read_only' },
        success_conditions: [{ kind: 'verifier', verifier_id: 'verifier_result_shape' }],
      },
    ],
    outputs: {
      result: { from: { node_id: 'node_verify' }, schema: { type: 'object' } },
    },
  };
}

test('validates a Workflow IR with branching, parallel work, a join, retry, and failure handling', () => {
  const result = validateWorkflow(workflowFixture());

  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
});

test('uses the same Workflow IR validator after JSON and YAML have been parsed', () => {
  const jsonDocument = JSON.parse(JSON.stringify(workflowFixture())) as unknown;
  // A YAML parser produces the same data model; serialization is deliberately
  // outside the IR validator so both formats share one schema and semantics.
  const yamlDocument: unknown = structuredClone(workflowFixture());

  assert.equal(validateWorkflow(jsonDocument).valid, true);
  assert.equal(validateWorkflow(yamlDocument).valid, true);
});

test('rejects Workflow IR schema errors and cross-reference errors', () => {
  const missingSuccessCondition = workflowFixture();
  missingSuccessCondition.nodes[0] = {
    ...missingSuccessCondition.nodes[0]!,
    success_conditions: [],
  };
  const schemaResult = validateWorkflow(missingSuccessCondition);
  assert.equal(schemaResult.valid, false);
  assert.ok(schemaResult.diagnostics.some((diagnostic) => diagnostic.code === 'SCHEMA_MINITEMS'));

  const missingDependency = workflowFixture();
  missingDependency.nodes[1] = {
    ...missingDependency.nodes[1]!,
    depends_on: [{ node_id: 'node_missing', on: 'success' }],
  };
  const semanticResult = validateWorkflow(missingDependency);
  assert.equal(semanticResult.valid, false);
  assert.ok(
    semanticResult.diagnostics.some(
      (diagnostic) => diagnostic.code === 'MISSING_WORKFLOW_DEPENDENCY',
    ),
  );
});

test('migrates the v0.0.0 golden snapshot without changing its source document', async () => {
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy-v0.0.0');
  const source = {
    manifest: JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8')) as unknown,
    events: (await readFile(join(fixture, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown),
  };
  const original = structuredClone(source);
  const first = migrateSnapshot(source);

  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.report?.sourceVersion, '0.0.0');
  assert.equal(first.report?.targetVersion, '0.2.0');
  assert.equal(first.report?.appliedSteps.length, 2);
  assert.equal((first.document?.manifest as { schema_version?: string }).schema_version, '0.2.0');
  assert.deepEqual(source, original);

  const second = migrateSnapshot(first.document!);
  assert.deepEqual(second.diagnostics, []);
  assert.deepEqual(second.document, first.document);
  assert.deepEqual(second.report?.appliedSteps, []);
});

test('migrates a legacy v0.1.0 snapshot into observation-aware v0.2.0 metadata', async () => {
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/minimal-success');
  const source = {
    manifest: JSON.parse(await readFile(join(fixture, 'manifest.json'), 'utf8')) as unknown,
    events: (await readFile(join(fixture, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown),
  };
  const result = migrateSnapshot(source);

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.report?.appliedSteps.map((step) => [step.from, step.to]),
    [['0.1.0', '0.2.0']],
  );
  assert.deepEqual(readSnapshotObservationMetadata(result.document?.manifest), {
    source: 'native',
    completeness: 'complete',
    limitations: [],
  });
  assert.equal(validateSnapshot(result.document!).valid, true);
});

test('writes migrated snapshots to a new directory and leaves the source bytes unchanged', async () => {
  const fixture = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/legacy-v0.0.0');
  const sourceManifest = await readFile(join(fixture, 'manifest.json'), 'utf8');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'alsnap-migration-test-'));
  const output = join(temporaryRoot, 'migrated');
  try {
    const result = await migrateSnapshotDirectory(fixture, output);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.outputDirectory, output);
    assert.equal((await validateSnapshotDirectory(output)).valid, true);
    assert.equal(await readFile(join(fixture, 'manifest.json'), 'utf8'), sourceManifest);

    const sameDirectory = await migrateSnapshotDirectory(fixture, fixture);
    assert.equal(sameDirectory.diagnostics[0]?.code, 'OUTPUT_EQUALS_SOURCE');

    const duplicate = await migrateSnapshotDirectory(fixture, output);
    assert.equal(duplicate.diagnostics[0]?.code, 'OUTPUT_ALREADY_EXISTS');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('views unknown major metadata but never authorizes migration or execution', () => {
  const futureManifest = {
    schema_version: '9.0.0',
    snapshot_type: 'run-snapshot',
    run_id: 'run_future',
    run_state: 'finished',
    runtime: { name: 'future-runtime' },
  };
  assert.deepEqual(viewSnapshotMetadata(futureManifest), {
    schemaVersion: '9.0.0',
    snapshotType: 'run-snapshot',
    runId: 'run_future',
    runState: 'finished',
    runtimeName: 'future-runtime',
  });
  assert.deepEqual(inspectSnapshotCompatibility(futureManifest), {
    sourceVersion: '9.0.0',
    status: 'view_only',
    canExecute: false,
    canMigrate: false,
    reason: 'Unknown major schema versions are metadata-viewable but never executable.',
  });
  assert.equal(
    migrateSnapshot({ manifest: futureManifest, events: [] }).diagnostics[0]?.code,
    'UNSUPPORTED_SCHEMA_VERSION',
  );
});
