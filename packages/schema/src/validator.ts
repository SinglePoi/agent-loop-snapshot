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
} from './index.js';

const snapshotSchemaVersion = '0.1.0';
const schemaFiles = {
  artifactReference: 'artifact-reference.schema.json',
  checkpoint: 'checkpoint.schema.json',
  events: 'events.schema.json',
  manifest: 'manifest.schema.json',
} as const;

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticSource = 'manifest' | 'events' | 'checkpoints' | 'artifacts' | 'integrity';

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
} satisfies Record<string, ValidateFunction<unknown>>;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    value.schema_version === snapshotSchemaVersion &&
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
  });

  if (manifest !== undefined) {
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
  filePath: string,
  source: DiagnosticSource,
  path: string,
  diagnostics: ValidationDiagnostic[],
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'INVALID_JSON',
      path,
      message: error instanceof Error ? error.message : 'File is not valid JSON.',
      source,
      file: basename(filePath),
    });
    return undefined;
  }
}

async function readEventsFile(
  filePath: string,
  diagnostics: ValidationDiagnostic[],
): Promise<unknown[]> {
  let content: string;

  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_EVENTS_FILE',
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
  checkpointDirectory: string,
  diagnostics: ValidationDiagnostic[],
): Promise<unknown[]> {
  let fileNames: string[];

  try {
    fileNames = (await readdir(checkpointDirectory)).filter((fileName) =>
      fileName.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const checkpoints: unknown[] = [];
  for (const fileName of fileNames.sort()) {
    const checkpoint = await readJsonFile(
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
  snapshotDirectory: string,
  document: SnapshotDocument,
  diagnostics: ValidationDiagnostic[],
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

    const artifactPath = join(snapshotDirectory, 'artifacts', `sha256-${reference.digest}`);
    let contents: Buffer;

    try {
      contents = await readFile(artifactPath);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'MISSING_ARTIFACT',
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

export async function validateSnapshotDirectory(
  snapshotDirectory: string,
): Promise<ValidationResult> {
  const root = resolve(snapshotDirectory);
  const diagnostics: ValidationDiagnostic[] = [];
  const manifest = await readJsonFile(
    join(root, 'manifest.json'),
    'manifest',
    '/manifest',
    diagnostics,
  );
  const events = await readEventsFile(join(root, 'events.jsonl'), diagnostics);
  const checkpoints = await readCheckpoints(join(root, 'checkpoints'), diagnostics);
  const document: SnapshotDocument = { manifest, events, checkpoints };
  const result = validateSnapshot(document);

  diagnostics.push(...result.diagnostics);
  await validateArtifactFiles(root, document, diagnostics);

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    diagnostics,
  };
}
