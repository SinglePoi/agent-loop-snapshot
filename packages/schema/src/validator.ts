import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import {
  type ArtifactReference,
  type Checkpoint,
  type EventEnvelope,
  type EventType,
  type JsonSchema,
  type WorkflowDocument,
  type WorkflowNodeId,
} from './index.js';
import { isSupportedSnapshotSchemaVersion, snapshotSchemaVersion } from './protocol.js';
import {
  SnapshotPathError,
  createSnapshotPathBoundary,
  inspectSnapshotPath,
  type SnapshotPathBoundary,
} from './snapshot-path.js';

export const defaultSnapshotDirectoryValidationLimits = {
  maxEventFileBytes: 64 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
} as const;

export interface SnapshotDirectoryValidationOptions {
  maxEventFileBytes?: number;
  maxArtifactBytes?: number;
}
const schemaFiles = {
  artifactReference: 'artifact-reference.schema.json',
  checkpoint: 'checkpoint.schema.json',
  events: 'events.schema.json',
  manifest: 'manifest.schema.json',
  workflow: 'workflow.schema.json',
} as const;

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticSource =
  'manifest' | 'events' | 'checkpoints' | 'artifacts' | 'integrity' | 'workflow';

export interface ValidationDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  path: string;
  message: string;
  source: DiagnosticSource;
  file?: string;
  line?: number;
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

export interface SnapshotDocument {
  manifest: unknown;
  events: unknown[];
  checkpoints?: unknown[];
}

const knownEventTypes = new Set<EventType>([
  'run.started',
  'run.completed',
  'run.failed',
  'run.observed',
  'model.requested',
  'model.completed',
  'model.failed',
  'tool.requested',
  'tool.completed',
  'tool.failed',
  'decision.recorded',
  'state.changed',
  'checkpoint.created',
  'verification.completed',
  'otel.span',
]);

const schemaDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../schemas');

function loadSchema(fileName: string): AnySchema {
  return JSON.parse(readFileSync(join(schemaDirectory, fileName), 'utf8')) as AnySchema;
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)),
});

const validators = {
  artifactReference: ajv.compile(loadSchema(schemaFiles.artifactReference)),
  checkpoint: ajv.compile(loadSchema(schemaFiles.checkpoint)),
  events: ajv.compile(loadSchema(schemaFiles.events)),
  manifest: ajv.compile(loadSchema(schemaFiles.manifest)),
  workflow: ajv.compile(loadSchema(schemaFiles.workflow)),
} satisfies Record<string, ValidateFunction<unknown>>;

export interface WorkflowValidationDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  path: string;
  message: string;
  source: 'workflow';
}

export interface WorkflowValidationResult {
  valid: boolean;
  diagnostics: WorkflowValidationDiagnostic[];
}

export interface JsonSchemaValueValidationResult {
  valid: boolean;
  diagnostics: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function joinJsonPath(prefix: string, path: string): string {
  if (!path) {
    return prefix;
  }

  return `${prefix}${path}`;
}

function errorPath(error: ErrorObject): string {
  if (error.keyword === 'required' && typeof error.params === 'object' && error.params !== null) {
    const missingProperty = (error.params as { missingProperty?: unknown }).missingProperty;

    if (typeof missingProperty === 'string') {
      return `${error.instancePath}/${escapeJsonPointerSegment(missingProperty)}`;
    }
  }

  return error.instancePath || '';
}

function schemaDiagnostics(
  validator: ValidateFunction<unknown>,
  value: unknown,
  source: DiagnosticSource,
  prefix: string,
  file?: string,
  line?: number,
): ValidationDiagnostic[] {
  if (validator(value)) {
    return [];
  }

  return (validator.errors ?? []).map((error) => ({
    severity: 'error' as const,
    code: `SCHEMA_${error.keyword.toUpperCase()}`,
    path: joinJsonPath(prefix, errorPath(error)),
    message: error.message ?? 'Schema validation failed.',
    source,
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
  }));
}

function workflowSemanticDiagnostics(document: WorkflowDocument): WorkflowValidationDiagnostic[] {
  const diagnostics: WorkflowValidationDiagnostic[] = [];
  const nodeIds = new Set<WorkflowNodeId>();
  const verifierIds = new Set<string>();

  document.verifiers?.forEach((verifier, index) => {
    if (verifierIds.has(verifier.verifier_id)) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_WORKFLOW_VERIFIER_ID',
        path: `/verifiers/${index}/verifier_id`,
        message: `Verifier ID "${verifier.verifier_id}" is duplicated.`,
        source: 'workflow',
      });
    }
    verifierIds.add(verifier.verifier_id);
  });

  document.nodes.forEach((node, index) => {
    if (nodeIds.has(node.node_id)) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_WORKFLOW_NODE_ID',
        path: `/nodes/${index}/node_id`,
        message: `Node ID "${node.node_id}" is duplicated.`,
        source: 'workflow',
      });
    }
    nodeIds.add(node.node_id);
  });

  document.nodes.forEach((node, index) => {
    node.depends_on.forEach((dependency, dependencyIndex) => {
      if (!nodeIds.has(dependency.node_id)) {
        diagnostics.push({
          severity: 'error',
          code: 'MISSING_WORKFLOW_DEPENDENCY',
          path: `/nodes/${index}/depends_on/${dependencyIndex}/node_id`,
          message: `Dependency "${dependency.node_id}" does not name a workflow node.`,
          source: 'workflow',
        });
      }
      if (dependency.node_id === node.node_id) {
        diagnostics.push({
          severity: 'error',
          code: 'SELF_WORKFLOW_DEPENDENCY',
          path: `/nodes/${index}/depends_on/${dependencyIndex}/node_id`,
          message: 'A workflow node cannot depend on itself.',
          source: 'workflow',
        });
      }
    });

    if (node.kind === 'verification' && !verifierIds.has(node.verifier_id)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_WORKFLOW_VERIFIER',
        path: `/nodes/${index}/verifier_id`,
        message: `Verifier "${node.verifier_id}" is not declared by the workflow.`,
        source: 'workflow',
      });
    }

    node.success_conditions.forEach((condition, conditionIndex) => {
      if (condition.kind === 'verifier' && !verifierIds.has(condition.verifier_id ?? '')) {
        diagnostics.push({
          severity: 'error',
          code: 'MISSING_WORKFLOW_VERIFIER',
          path: `/nodes/${index}/success_conditions/${conditionIndex}/verifier_id`,
          message: `Verifier "${condition.verifier_id ?? ''}" is not declared by the workflow.`,
          source: 'workflow',
        });
      }
    });

    const references = [
      ...(node.condition === undefined
        ? []
        : [{ path: `/nodes/${index}/condition/from`, value: node.condition.from }]),
      ...node.success_conditions.flatMap((successCondition, conditionIndex) =>
        successCondition.kind === 'condition' && successCondition.condition !== undefined
          ? [
              {
                path: `/nodes/${index}/success_conditions/${conditionIndex}/condition/from`,
                value: successCondition.condition.from,
              },
            ]
          : [],
      ),
    ];
    references.forEach((reference) => {
      const isKnown =
        reference.value.kind === 'input'
          ? Object.hasOwn(document.inputs, reference.value.name)
          : nodeIds.has(reference.value.name as WorkflowNodeId);
      if (!isKnown) {
        diagnostics.push({
          severity: 'error',
          code: 'MISSING_WORKFLOW_REFERENCE',
          path: reference.path,
          message: `${reference.value.kind === 'input' ? 'Input' : 'Node output'} reference "${reference.value.name}" is not declared.`,
          source: 'workflow',
        });
      }
    });
  });

  Object.entries(document.outputs).forEach(([name, output]) => {
    if (!nodeIds.has(output.from.node_id)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_WORKFLOW_OUTPUT_NODE',
        path: `/outputs/${escapeJsonPointerSegment(name)}/from/node_id`,
        message: `Output "${name}" references unknown node "${output.from.node_id}".`,
        source: 'workflow',
      });
    }
  });

  const dependencies = new Map(
    document.nodes.map((node) => [
      node.node_id,
      node.depends_on
        .map((dependency) => dependency.node_id)
        .filter((nodeId) => nodeIds.has(nodeId)),
    ]),
  );
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (nodeId: WorkflowNodeId): void => {
    if (active.has(nodeId)) {
      diagnostics.push({
        severity: 'error',
        code: 'WORKFLOW_DEPENDENCY_CYCLE',
        path: '/nodes',
        message: `Workflow dependencies contain a cycle through "${nodeId}".`,
        source: 'workflow',
      });
      return;
    }
    if (visited.has(nodeId)) {
      return;
    }
    active.add(nodeId);
    dependencies.get(nodeId)?.forEach(visit);
    active.delete(nodeId);
    visited.add(nodeId);
  };
  dependencies.forEach((_, nodeId) => visit(nodeId));

  return diagnostics;
}

/**
 * Validates an already parsed workflow document. Callers may parse JSON or
 * YAML first; both serializations intentionally share this exact validator.
 */
export function validateWorkflow(document: unknown): WorkflowValidationResult {
  const diagnostics = schemaDiagnostics(validators.workflow, document, 'workflow', '').map(
    (diagnostic) => ({ ...diagnostic, source: 'workflow' as const }),
  );

  if (validators.workflow(document)) {
    diagnostics.push(...workflowSemanticDiagnostics(document as WorkflowDocument));
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}

/** Validates a JSON value against an embedded Workflow IR JSON Schema fragment. */
export function validateJsonSchemaValue(
  schema: JsonSchema,
  value: unknown,
): JsonSchemaValueValidationResult {
  try {
    const validator = ajv.compile(schema);
    if (validator(value)) {
      return { valid: true, diagnostics: [] };
    }
    return {
      valid: false,
      diagnostics: (validator.errors ?? []).map((error) => ({
        path: errorPath(error),
        message: error.message ?? 'JSON Schema validation failed.',
      })),
    };
  } catch (error) {
    return {
      valid: false,
      diagnostics: [
        {
          path: '',
          message: error instanceof Error ? error.message : 'JSON Schema could not be compiled.',
        },
      ],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    isSupportedSnapshotSchemaVersion(value.schema_version) &&
    typeof value.digest === 'string' &&
    typeof value.media_type === 'string' &&
    typeof value.byte_length === 'number'
  );
}

function collectArtifactReferences(
  value: unknown,
  path: string,
  references: Array<{ path: string; reference: ArtifactReference }>,
): void {
  if (isArtifactReference(value)) {
    references.push({ path, reference: value });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectArtifactReferences(item, `${path}/${index}`, references));
    return;
  }

  if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => {
      collectArtifactReferences(child, `${path}/${escapeJsonPointerSegment(key)}`, references);
    });
  }
}

function semanticDiagnostics(document: SnapshotDocument): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const manifest = isRecord(document.manifest) ? document.manifest : undefined;
  const events = document.events;
  const eventIds = new Set<string>();
  let previousSequence = 0;

  events.forEach((eventValue, index) => {
    if (!isRecord(eventValue)) {
      return;
    }

    const event = eventValue as Partial<EventEnvelope>;
    const eventPath = `/events/${index}`;

    if (typeof event.type === 'string' && !knownEventTypes.has(event.type as EventType)) {
      diagnostics.push({
        severity: 'warning',
        code: 'UNKNOWN_EVENT_TYPE',
        path: `${eventPath}/type`,
        message: `Unknown event type "${event.type}" is retained as an opaque event and cannot be replayed.`,
        source: 'events',
      });
    }

    if (typeof event.event_id === 'string') {
      if (eventIds.has(event.event_id)) {
        diagnostics.push({
          severity: 'error',
          code: 'DUPLICATE_EVENT_ID',
          path: `${eventPath}/event_id`,
          message: `Event ID "${event.event_id}" is duplicated.`,
          source: 'events',
        });
      }
    }

    if (typeof event.sequence === 'number') {
      if (event.sequence <= previousSequence) {
        diagnostics.push({
          severity: 'error',
          code: 'SEQUENCE_NOT_INCREASING',
          path: `${eventPath}/sequence`,
          message: 'Event sequence must be strictly increasing in JSONL write order.',
          source: 'events',
        });
      } else if (event.sequence !== previousSequence + 1) {
        diagnostics.push({
          severity: 'error',
          code: 'SEQUENCE_GAP',
          path: `${eventPath}/sequence`,
          message: `Expected sequence ${previousSequence + 1}, received ${event.sequence}.`,
          source: 'events',
        });
      }
      previousSequence = event.sequence;
    }

    if (Array.isArray(event.parent_ids)) {
      event.parent_ids.forEach((parentId, parentIndex) => {
        if (typeof parentId === 'string' && !eventIds.has(parentId)) {
          diagnostics.push({
            severity: 'error',
            code: 'MISSING_PARENT_EVENT',
            path: `${eventPath}/parent_ids/${parentIndex}`,
            message: `Parent event "${parentId}" is not present earlier in the event stream.`,
            source: 'events',
          });
        }
      });
    }

    if (typeof event.event_id === 'string') {
      eventIds.add(event.event_id);
    }

    if (manifest !== undefined && event.run_id !== manifest.run_id) {
      diagnostics.push({
        severity: 'error',
        code: 'RUN_ID_MISMATCH',
        path: `${eventPath}/run_id`,
        message: 'Event run_id does not match manifest run_id.',
        source: 'events',
      });
    }
    if (
      manifest !== undefined &&
      typeof manifest.schema_version === 'string' &&
      event.schema_version !== manifest.schema_version
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'SCHEMA_VERSION_MISMATCH',
        path: `${eventPath}/schema_version`,
        message: 'Event schema_version does not match manifest schema_version.',
        source: 'events',
      });
    }
  });

  if (manifest !== undefined) {
    if (manifest.schema_version === snapshotSchemaVersion) {
      if (manifest.completeness === 'partial') {
        diagnostics.push({
          severity: 'warning',
          code: 'SNAPSHOT_PARTIAL',
          path: '/manifest/completeness',
          message: 'Snapshot is structurally valid but its recording is partial.',
          source: 'manifest',
        });
      } else if (manifest.completeness === 'unknown') {
        diagnostics.push({
          severity: 'warning',
          code: 'SNAPSHOT_COMPLETENESS_UNKNOWN',
          path: '/manifest/completeness',
          message: 'Snapshot is structurally valid but recording completeness is unknown.',
          source: 'manifest',
        });
      }
    }
    if (manifest.event_count !== events.length) {
      diagnostics.push({
        severity: 'error',
        code: 'EVENT_COUNT_MISMATCH',
        path: '/manifest/event_count',
        message: `Manifest declares ${String(manifest.event_count)} events, but ${events.length} were loaded.`,
        source: 'manifest',
      });
    }

    if (manifest.last_sequence !== previousSequence) {
      diagnostics.push({
        severity: 'error',
        code: 'LAST_SEQUENCE_MISMATCH',
        path: '/manifest/last_sequence',
        message: `Manifest declares last_sequence ${String(manifest.last_sequence)}, but the event stream ends at ${previousSequence}.`,
        source: 'manifest',
      });
    }
  }

  document.checkpoints?.forEach((checkpointValue, index) => {
    if (!isRecord(checkpointValue)) {
      return;
    }

    const checkpoint = checkpointValue as Partial<Checkpoint>;
    const checkpointPath = `/checkpoints/${index}`;

    if (typeof checkpoint.last_event_id === 'string' && !eventIds.has(checkpoint.last_event_id)) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_CHECKPOINT_EVENT',
        path: `${checkpointPath}/last_event_id`,
        message: `Checkpoint references missing event "${checkpoint.last_event_id}".`,
        source: 'checkpoints',
      });
    }

    if (
      typeof checkpoint.run_id === 'string' &&
      manifest !== undefined &&
      checkpoint.run_id !== manifest.run_id
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'CHECKPOINT_RUN_ID_MISMATCH',
        path: `${checkpointPath}/run_id`,
        message: 'Checkpoint run_id does not match manifest run_id.',
        source: 'checkpoints',
      });
    }
    if (
      typeof checkpoint.schema_version === 'string' &&
      manifest !== undefined &&
      checkpoint.schema_version !== manifest.schema_version
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'SCHEMA_VERSION_MISMATCH',
        path: `${checkpointPath}/schema_version`,
        message: 'Checkpoint schema_version does not match manifest schema_version.',
        source: 'checkpoints',
      });
    }
  });

  const references: Array<{ path: string; reference: ArtifactReference }> = [];
  collectArtifactReferences(document.manifest, '/manifest', references);
  events.forEach((event, index) =>
    collectArtifactReferences(event, `/events/${index}`, references),
  );
  document.checkpoints?.forEach((checkpoint, index) => {
    collectArtifactReferences(checkpoint, `/checkpoints/${index}`, references);
  });

  references.forEach(({ path, reference }) => {
    diagnostics.push(
      ...schemaDiagnostics(validators.artifactReference, reference, 'artifacts', path),
    );
  });

  return diagnostics;
}

export function validateSnapshot(document: SnapshotDocument): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  diagnostics.push(
    ...schemaDiagnostics(validators.manifest, document.manifest, 'manifest', '/manifest'),
  );

  if (!Array.isArray(document.events)) {
    diagnostics.push({
      severity: 'error',
      code: 'EVENTS_NOT_ARRAY',
      path: '/events',
      message: 'Events must be supplied as an array of event envelopes.',
      source: 'events',
    });
  } else {
    document.events.forEach((event, index) => {
      diagnostics.push(
        ...schemaDiagnostics(validators.events, event, 'events', `/events/${index}`),
      );
    });
  }

  document.checkpoints?.forEach((checkpoint, index) => {
    diagnostics.push(
      ...schemaDiagnostics(
        validators.checkpoint,
        checkpoint,
        'checkpoints',
        `/checkpoints/${index}`,
      ),
    );
  });

  if (Array.isArray(document.events)) {
    diagnostics.push(...semanticDiagnostics(document));
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}

async function readJsonFile(
  boundary: SnapshotPathBoundary,
  filePath: string,
  source: DiagnosticSource,
  path: string,
  diagnostics: ValidationDiagnostic[],
): Promise<unknown> {
  try {
    const trustedFile = await inspectSnapshotPath(boundary, filePath, 'file');
    return JSON.parse(await readFile(trustedFile.path, 'utf8')) as unknown;
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code:
        error instanceof SnapshotPathError && error.code !== 'MISSING'
          ? 'UNTRUSTED_SNAPSHOT_ENTRY'
          : 'INVALID_JSON',
      path,
      message: error instanceof Error ? error.message : 'File is not valid JSON.',
      source,
      file: basename(filePath),
    });
    return undefined;
  }
}

async function readEventsFile(
  boundary: SnapshotPathBoundary,
  filePath: string,
  diagnostics: ValidationDiagnostic[],
  maxBytes: number,
): Promise<unknown[]> {
  let content: string;

  try {
    const trustedFile = await inspectSnapshotPath(boundary, filePath, 'file');
    if (trustedFile.size > maxBytes) {
      diagnostics.push({
        severity: 'error',
        code: 'EVENT_FILE_TOO_LARGE',
        path: '/events',
        message: `events.jsonl is ${String(trustedFile.size)} bytes, exceeding the ${String(maxBytes)} byte limit.`,
        source: 'events',
        file: basename(filePath),
      });
      return [];
    }
    content = await readFile(trustedFile.path, 'utf8');
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code:
        error instanceof SnapshotPathError && error.code !== 'MISSING'
          ? 'UNTRUSTED_EVENTS_FILE'
          : 'MISSING_EVENTS_FILE',
      path: '/events',
      message: error instanceof Error ? error.message : 'events.jsonl could not be read.',
      source: 'events',
      file: basename(filePath),
    });
    return [];
  }

  const events: unknown[] = [];
  content.split(/\r?\n/).forEach((line, lineIndex) => {
    if (line.trim() === '') {
      return;
    }

    try {
      events.push(JSON.parse(line) as unknown);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_JSONL_LINE',
        path: `/events/${events.length}`,
        message: error instanceof Error ? error.message : 'Line is not valid JSON.',
        source: 'events',
        file: basename(filePath),
        line: lineIndex + 1,
      });
    }
  });

  return events;
}

async function readCheckpoints(
  boundary: SnapshotPathBoundary,
  checkpointDirectory: string,
  diagnostics: ValidationDiagnostic[],
): Promise<unknown[]> {
  let fileNames: string[];

  try {
    const trustedDirectory = await inspectSnapshotPath(boundary, checkpointDirectory, 'directory');
    fileNames = (await readdir(trustedDirectory.path)).filter((fileName) =>
      fileName.endsWith('.json'),
    );
  } catch (error) {
    if (error instanceof SnapshotPathError && error.code !== 'MISSING') {
      diagnostics.push({
        severity: 'error',
        code: 'UNTRUSTED_CHECKPOINT_DIRECTORY',
        path: '/checkpoints',
        message: error.message,
        source: 'checkpoints',
        file: basename(checkpointDirectory),
      });
    }
    return [];
  }

  const checkpoints: unknown[] = [];
  for (const fileName of fileNames.sort()) {
    const checkpoint = await readJsonFile(
      boundary,
      join(checkpointDirectory, fileName),
      'checkpoints',
      `/checkpoints/${checkpoints.length}`,
      diagnostics,
    );
    if (checkpoint !== undefined) {
      checkpoints.push(checkpoint);
    }
  }
  return checkpoints;
}

async function validateArtifactFiles(
  boundary: SnapshotPathBoundary,
  document: SnapshotDocument,
  diagnostics: ValidationDiagnostic[],
  maxArtifactBytes: number,
): Promise<void> {
  const references: Array<{ path: string; reference: ArtifactReference }> = [];
  collectArtifactReferences(document.manifest, '/manifest', references);
  document.events.forEach((event, index) =>
    collectArtifactReferences(event, `/events/${index}`, references),
  );
  document.checkpoints?.forEach((checkpoint, index) => {
    collectArtifactReferences(checkpoint, `/checkpoints/${index}`, references);
  });

  for (const { path, reference } of references) {
    if (!/^[a-f0-9]{64}$/.test(reference.digest)) {
      continue;
    }

    const artifactPath = join(boundary.directory, 'artifacts', `sha256-${reference.digest}`);
    let contents: Buffer;

    try {
      const trustedFile = await inspectSnapshotPath(boundary, artifactPath, 'file');
      if (trustedFile.size > maxArtifactBytes) {
        diagnostics.push({
          severity: 'error',
          code: 'ARTIFACT_TOO_LARGE',
          path,
          message: `Artifact is ${String(trustedFile.size)} bytes, exceeding the ${String(maxArtifactBytes)} byte limit.`,
          source: 'integrity',
          file: artifactPath,
        });
        continue;
      }
      contents = await readFile(trustedFile.path);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code:
          error instanceof SnapshotPathError && error.code !== 'MISSING'
            ? 'UNTRUSTED_ARTIFACT_ENTRY'
            : 'MISSING_ARTIFACT',
        path,
        message: error instanceof Error ? error.message : 'Referenced artifact is missing.',
        source: 'integrity',
        file: artifactPath,
      });
      continue;
    }

    const digest = createHash('sha256').update(contents).digest('hex');
    if (digest !== reference.digest) {
      diagnostics.push({
        severity: 'error',
        code: 'ARTIFACT_DIGEST_MISMATCH',
        path,
        message: `Artifact digest ${digest} does not match declared digest ${reference.digest}.`,
        source: 'integrity',
        file: artifactPath,
      });
    }

    if (contents.byteLength !== reference.byte_length) {
      diagnostics.push({
        severity: 'error',
        code: 'ARTIFACT_SIZE_MISMATCH',
        path,
        message: `Artifact has ${contents.byteLength} bytes, expected ${reference.byte_length}.`,
        source: 'integrity',
        file: artifactPath,
      });
    }
  }
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

export async function validateSnapshotDirectory(
  snapshotDirectory: string,
  options: SnapshotDirectoryValidationOptions = {},
): Promise<ValidationResult> {
  const boundary = await createSnapshotPathBoundary(snapshotDirectory);
  const root = boundary.directory;
  const maxEventFileBytes = limit(
    options.maxEventFileBytes,
    defaultSnapshotDirectoryValidationLimits.maxEventFileBytes,
    'maxEventFileBytes',
  );
  const maxArtifactBytes = limit(
    options.maxArtifactBytes,
    defaultSnapshotDirectoryValidationLimits.maxArtifactBytes,
    'maxArtifactBytes',
  );
  const diagnostics: ValidationDiagnostic[] = [];
  const manifest = await readJsonFile(
    boundary,
    join(root, 'manifest.json'),
    'manifest',
    '/manifest',
    diagnostics,
  );
  const events = await readEventsFile(
    boundary,
    join(root, 'events.jsonl'),
    diagnostics,
    maxEventFileBytes,
  );
  const checkpoints = await readCheckpoints(boundary, join(root, 'checkpoints'), diagnostics);
  const document: SnapshotDocument = { manifest, events, checkpoints };
  const result = validateSnapshot(document);

  diagnostics.push(...result.diagnostics);
  await validateArtifactFiles(boundary, document, diagnostics, maxArtifactBytes);

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}
