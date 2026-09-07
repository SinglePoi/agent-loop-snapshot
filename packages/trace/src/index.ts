import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  snapshotSchemaVersion,
  SnapshotPathError,
  createSnapshotPathBoundary,
  inspectSnapshotPath,
  type ArtifactReference,
  type Checkpoint,
  type EventEnvelope,
  type SnapshotManifest,
  type SnapshotPathBoundary,
  validateSnapshot,
  type ValidationDiagnostic,
} from '@agent-loop-snapshot/schema';

export interface TraceLoader {
  readonly packageName: '@agent-loop-snapshot/trace';
}

export const tracePackageName: TraceLoader['packageName'] = '@agent-loop-snapshot/trace';

export const defaultTraceLoadLimits = {
  maxEventFileBytes: 64 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
} as const;

export interface TraceLoadOptions {
  /** Maximum events.jsonl size accepted from an untrusted snapshot. */
  maxEventFileBytes?: number;
  /** Maximum artifact size exposed through readArtifact(). */
  maxArtifactBytes?: number;
}

export type TraceDiagnosticSeverity = 'error' | 'warning';
export type TraceDiagnosticSource =
  'manifest' | 'events' | 'checkpoints' | 'artifacts' | 'integrity' | 'loader' | 'workflow';

export interface TraceDiagnostic {
  severity: TraceDiagnosticSeverity;
  code: string;
  path: string;
  message: string;
  source: TraceDiagnosticSource;
  file?: string | undefined;
  line?: number | undefined;
}

/** A failure while materializing an artifact from a loaded snapshot. */
export class ArtifactReadError extends Error {
  constructor(
    readonly code:
      | 'ARTIFACT_INVALID_DIGEST'
      | 'ARTIFACT_MISSING'
      | 'ARTIFACT_TOO_LARGE'
      | 'ARTIFACT_UNTRUSTED'
      | 'ARTIFACT_UNAVAILABLE'
      | 'ARTIFACT_SIZE_MISMATCH'
      | 'ARTIFACT_DIGEST_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactReadError';
  }
}

export interface ArtifactMetadata {
  readonly digest: string;
  readonly path: string;
  readonly exists: boolean;
  readonly byte_length?: number;
  readonly actual_byte_length?: number;
  readonly media_types: readonly string[];
  readonly previews: readonly string[];
}

export interface EventQuery {
  readonly actor?: string;
  readonly type?: string;
  readonly minSequence?: number;
  readonly maxSequence?: number;
  readonly after?: string;
  readonly before?: string;
}

export interface TraceIndexes {
  readonly eventById: ReadonlyMap<string, EventEnvelope<string, unknown>>;
  readonly childrenById: ReadonlyMap<string, readonly EventEnvelope<string, unknown>[]>;
  readonly eventsByActor: ReadonlyMap<string, readonly EventEnvelope<string, unknown>[]>;
  readonly eventsByType: ReadonlyMap<string, readonly EventEnvelope<string, unknown>[]>;
  readonly eventLineById: ReadonlyMap<string, number>;
}

export interface TraceQueryModel {
  getEvent(eventId: string): EventEnvelope<string, unknown> | undefined;
  getParents(eventId: string): readonly EventEnvelope<string, unknown>[];
  getChildren(eventId: string): readonly EventEnvelope<string, unknown>[];
  findEvents(query?: EventQuery): readonly EventEnvelope<string, unknown>[];
  getEventsByActor(actor: string): readonly EventEnvelope<string, unknown>[];
  getEventsByType(type: string): readonly EventEnvelope<string, unknown>[];
  getRootEvents(): readonly EventEnvelope<string, unknown>[];
}

export interface TraceSnapshot {
  readonly directory: string;
  readonly valid: boolean;
  readonly manifest?: SnapshotManifest;
  readonly manifestSource?: 'temporary' | 'final';
  readonly events: readonly EventEnvelope<string, unknown>[];
  readonly checkpoints: readonly Checkpoint[];
  readonly artifacts: ReadonlyMap<string, ArtifactMetadata>;
  readonly artifactReferences: ReadonlyMap<string, readonly ArtifactReference[]>;
  readonly indexes: TraceIndexes;
  readonly query: TraceQueryModel;
  readonly diagnostics: readonly TraceDiagnostic[];
  readonly readArtifact: (digest: string) => Promise<Uint8Array>;
}

interface ParsedJsonFile {
  readonly value: unknown;
}

interface JsonlReadResult {
  readonly values: unknown[];
}

const eventEnvelopeFields = [
  'schema_version',
  'run_id',
  'event_id',
  'parent_ids',
  'sequence',
  'type',
  'timestamp',
  'monotonic_offset_ms',
  'actor',
  'payload',
  'security',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEventEnvelope(value: unknown): value is EventEnvelope<string, unknown> {
  return (
    isRecord(value) &&
    eventEnvelopeFields.every((field) => field in value) &&
    typeof value.event_id === 'string' &&
    Array.isArray(value.parent_ids) &&
    typeof value.sequence === 'number' &&
    typeof value.type === 'string' &&
    typeof value.actor === 'string'
  );
}

function isArtifactReference(value: unknown): value is ArtifactReference {
  return (
    isRecord(value) &&
    value.schema_version === snapshotSchemaVersion &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest) &&
    typeof value.media_type === 'string' &&
    typeof value.byte_length === 'number'
  );
}

function addDiagnostic(diagnostics: TraceDiagnostic[], diagnostic: TraceDiagnostic): void {
  diagnostics.push(diagnostic);
}

function fromValidationDiagnostic(diagnostic: ValidationDiagnostic): TraceDiagnostic {
  return {
    ...diagnostic,
    source: diagnostic.source,
  };
}

function collectArtifactReferences(
  value: unknown,
  path: string,
  references: Map<string, Array<{ path: string; reference: ArtifactReference }>>,
): void {
  if (isArtifactReference(value)) {
    const entries = references.get(value.digest) ?? [];
    entries.push({ path, reference: value });
    references.set(value.digest, entries);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectArtifactReferences(item, `${path}/${index}`, references));
    return;
  }

  if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => {
      const escapedKey = key.replaceAll('~', '~0').replaceAll('/', '~1');
      collectArtifactReferences(child, `${path}/${escapedKey}`, references);
    });
  }
}

async function readJsonFile(
  boundary: SnapshotPathBoundary,
  filePath: string,
  source: TraceDiagnosticSource,
  path: string,
  diagnostics: TraceDiagnostic[],
): Promise<ParsedJsonFile | undefined> {
  try {
    const trustedFile = await inspectSnapshotPath(boundary, filePath, 'file');
    return {
      value: JSON.parse(await readFile(trustedFile.path, 'utf8')) as unknown,
    };
  } catch (error) {
    addDiagnostic(diagnostics, {
      severity: 'error',
      code:
        error instanceof SnapshotPathError && error.code !== 'MISSING'
          ? 'UNTRUSTED_SNAPSHOT_ENTRY'
          : 'INVALID_JSON',
      path,
      message: error instanceof Error ? error.message : `Could not read ${basename(filePath)}.`,
      source,
      file: basename(filePath),
    });
    return undefined;
  }
}

async function readManifest(
  boundary: SnapshotPathBoundary,
  diagnostics: TraceDiagnostic[],
): Promise<{ value?: unknown; source?: 'temporary' | 'final' }> {
  const candidates: Array<{ path: string; source: 'temporary' | 'final' }> = [
    { path: join(boundary.directory, 'manifest.json.tmp'), source: 'temporary' },
    { path: join(boundary.directory, 'manifest.json'), source: 'final' },
  ];
  let manifestFilePresent = false;

  for (const candidate of candidates) {
    try {
      const trustedFile = await inspectSnapshotPath(boundary, candidate.path, 'file');
      const parsed = JSON.parse(await readFile(trustedFile.path, 'utf8')) as unknown;
      manifestFilePresent = true;
      return { value: parsed, source: candidate.source };
    } catch (error) {
      if (error instanceof SnapshotPathError && error.code === 'MISSING') {
        // A missing manifest candidate is normal while checking the other candidate.
        continue;
      }
      manifestFilePresent = true;
      addDiagnostic(diagnostics, {
        severity: 'error',
        code: error instanceof SnapshotPathError ? 'UNTRUSTED_MANIFEST_FILE' : 'INVALID_JSON',
        path: '/manifest',
        message: error instanceof Error ? error.message : 'Manifest is not valid JSON.',
        source: 'manifest',
        file: basename(candidate.path),
      });
    }
  }

  if (manifestFilePresent) {
    return {};
  }

  addDiagnostic(diagnostics, {
    severity: 'error',
    code: 'MISSING_MANIFEST',
    path: '/manifest',
    message: 'Snapshot does not contain manifest.json or manifest.json.tmp.',
    source: 'manifest',
    file: 'manifest.json',
  });
  return {};
}

function addJsonlDiagnostic(
  diagnostics: TraceDiagnostic[],
  line: number,
  eventIndex: number,
  code: 'INVALID_JSONL_LINE' | 'PARTIAL_JSONL_TAIL',
  error: unknown,
): void {
  addDiagnostic(diagnostics, {
    severity: 'error',
    code,
    path: `/events/${eventIndex}`,
    message: error instanceof Error ? error.message : 'Line is not valid JSON.',
    source: 'events',
    file: 'events.jsonl',
    line,
  });
}

async function readJsonlFile(
  boundary: SnapshotPathBoundary,
  filePath: string,
  diagnostics: TraceDiagnostic[],
  maxBytes: number,
): Promise<JsonlReadResult> {
  const values: unknown[] = [];
  let trustedPath: string;

  try {
    const trustedFile = await inspectSnapshotPath(boundary, filePath, 'file');
    trustedPath = trustedFile.path;
    if (trustedFile.size > maxBytes) {
      addDiagnostic(diagnostics, {
        severity: 'error',
        code: 'EVENT_FILE_TOO_LARGE',
        path: '/events',
        message: `events.jsonl is ${String(trustedFile.size)} bytes, exceeding the ${String(maxBytes)} byte limit.`,
        source: 'events',
        file: 'events.jsonl',
      });
      return { values };
    }
  } catch (error) {
    addDiagnostic(diagnostics, {
      severity: 'error',
      code:
        error instanceof SnapshotPathError && error.code !== 'MISSING'
          ? 'UNTRUSTED_EVENTS_FILE'
          : 'MISSING_EVENTS_FILE',
      path: '/events',
      message: error instanceof Error ? error.message : 'events.jsonl could not be read.',
      source: 'events',
      file: 'events.jsonl',
    });
    return { values };
  }

  const stream = createReadStream(trustedPath, { encoding: 'utf8' });

  let buffer = '';
  let line = 0;

  const parseLine = (rawLine: string, lineNumber: number, isTail: boolean): void => {
    if (rawLine.trim() === '') {
      return;
    }

    try {
      values.push(JSON.parse(rawLine) as unknown);
    } catch (error) {
      addJsonlDiagnostic(
        diagnostics,
        lineNumber,
        values.length,
        isTail ? 'PARTIAL_JSONL_TAIL' : 'INVALID_JSONL_LINE',
        error,
      );
    }
  };

  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        line += 1;
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        parseLine(rawLine, line, false);
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } catch (error) {
    addDiagnostic(diagnostics, {
      severity: 'error',
      code: 'EVENTS_READ_FAILED',
      path: '/events',
      message: error instanceof Error ? error.message : 'Could not read events.jsonl.',
      source: 'events',
      file: 'events.jsonl',
    });
  }

  if (buffer.length > 0) {
    line += 1;
    parseLine(buffer, line, true);
  }

  return { values };
}

async function readCheckpoints(
  boundary: SnapshotPathBoundary,
  directory: string,
  diagnostics: TraceDiagnostic[],
): Promise<unknown[]> {
  let fileNames: string[];
  try {
    const trustedDirectory = await inspectSnapshotPath(boundary, directory, 'directory');
    fileNames = (await readdir(trustedDirectory.path))
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();
  } catch (error) {
    if (error instanceof SnapshotPathError && error.code !== 'MISSING') {
      addDiagnostic(diagnostics, {
        severity: 'error',
        code: 'UNTRUSTED_CHECKPOINT_DIRECTORY',
        path: '/checkpoints',
        message: error.message,
        source: 'checkpoints',
        file: basename(directory),
      });
    }
    return [];
  }

  const checkpoints: unknown[] = [];
  for (const fileName of fileNames) {
    const parsed = await readJsonFile(
      boundary,
      join(directory, fileName),
      'checkpoints',
      `/checkpoints/${checkpoints.length}`,
      diagnostics,
    );
    if (parsed !== undefined) {
      checkpoints.push(parsed.value);
    }
  }
  return checkpoints;
}

function buildIndexes(events: readonly EventEnvelope<string, unknown>[]): TraceIndexes {
  const eventById = new Map<string, EventEnvelope<string, unknown>>();
  const childrenById = new Map<string, EventEnvelope<string, unknown>[]>();
  const eventsByActor = new Map<string, EventEnvelope<string, unknown>[]>();
  const eventsByType = new Map<string, EventEnvelope<string, unknown>[]>();
  const eventLineById = new Map<string, number>();

  events.forEach((event, index) => {
    if (!eventById.has(event.event_id)) {
      eventById.set(event.event_id, event);
      eventLineById.set(event.event_id, index + 1);
    }

    const actorEvents = eventsByActor.get(event.actor) ?? [];
    actorEvents.push(event);
    eventsByActor.set(event.actor, actorEvents);

    const typeEvents = eventsByType.get(event.type) ?? [];
    typeEvents.push(event);
    eventsByType.set(event.type, typeEvents);

    event.parent_ids.forEach((parentId) => {
      const children = childrenById.get(parentId) ?? [];
      children.push(event);
      childrenById.set(parentId, children);
    });
  });

  return {
    eventById,
    childrenById,
    eventsByActor,
    eventsByType,
    eventLineById,
  };
}

function buildStructuralDiagnostics(
  manifest: SnapshotManifest | undefined,
  events: readonly EventEnvelope<string, unknown>[],
  indexes: TraceIndexes,
  diagnostics: TraceDiagnostic[],
): void {
  const eventIndex = new Map(events.map((event, index) => [event.event_id, index]));
  const indegree = new Map<string, number>();
  const roots: EventEnvelope<string, unknown>[] = [];

  events.forEach((event) => {
    let existingParentCount = 0;
    event.parent_ids.forEach((parentId, parentIndex) => {
      if (indexes.eventById.has(parentId)) {
        existingParentCount += 1;
        return;
      }

      addDiagnostic(diagnostics, {
        severity: 'error',
        code: 'BROKEN_PARENT_REFERENCE',
        path: `/events/${eventIndex.get(event.event_id) ?? 0}/parent_ids/${parentIndex}`,
        message: `Event references missing parent "${parentId}".`,
        source: 'integrity',
        file: 'events.jsonl',
        ...(indexes.eventLineById.get(event.event_id) === undefined
          ? {}
          : { line: indexes.eventLineById.get(event.event_id) }),
      });
    });
    indegree.set(event.event_id, existingParentCount);
    if (event.parent_ids.length === 0) {
      roots.push(event);
    }
  });

  const ready = events
    .filter((event) => (indegree.get(event.event_id) ?? 0) === 0)
    .map((event) => event.event_id);
  let processed = 0;
  while (ready.length > 0) {
    const eventId = ready.shift();
    if (eventId === undefined) {
      continue;
    }
    processed += 1;
    for (const child of indexes.childrenById.get(eventId) ?? []) {
      const next = (indegree.get(child.event_id) ?? 0) - 1;
      indegree.set(child.event_id, next);
      if (next === 0) {
        ready.push(child.event_id);
      }
    }
  }

  if (processed !== events.length) {
    events.forEach((event) => {
      if ((indegree.get(event.event_id) ?? 0) > 0) {
        addDiagnostic(diagnostics, {
          severity: 'error',
          code: 'EVENT_CYCLE',
          path: `/events/${eventIndex.get(event.event_id) ?? 0}`,
          message: `Event "${event.event_id}" participates in a causal cycle.`,
          source: 'integrity',
          file: 'events.jsonl',
          ...(indexes.eventLineById.get(event.event_id) === undefined
            ? {}
            : { line: indexes.eventLineById.get(event.event_id) }),
        });
      }
    });
  }

  const declaredRoot = manifest?.root_event_id;
  if (declaredRoot !== undefined && !indexes.eventById.has(declaredRoot)) {
    addDiagnostic(diagnostics, {
      severity: 'error',
      code: 'MISSING_ROOT_EVENT',
      path: '/manifest/root_event_id',
      message: `Manifest references missing root event "${declaredRoot}".`,
      source: 'integrity',
      file: 'manifest.json',
    });
  }

  if (declaredRoot !== undefined) {
    roots.forEach((root) => {
      if (root.event_id !== declaredRoot) {
        addDiagnostic(diagnostics, {
          severity: 'warning',
          code: 'ORPHAN_ROOT_EVENT',
          path: `/events/${eventIndex.get(root.event_id) ?? 0}`,
          message: `Root event "${root.event_id}" is not the manifest root event.`,
          source: 'integrity',
          file: 'events.jsonl',
          ...(indexes.eventLineById.get(root.event_id) === undefined
            ? {}
            : { line: indexes.eventLineById.get(root.event_id) }),
        });
      }
    });
  }
}

async function loadArtifactMetadata(
  boundary: SnapshotPathBoundary,
  referenceMap: Map<string, Array<{ path: string; reference: ArtifactReference }>>,
  diagnostics: TraceDiagnostic[],
  maxArtifactBytes: number,
): Promise<Map<string, ArtifactMetadata>> {
  const artifactDirectory = join(boundary.directory, 'artifacts');
  const digests = new Set(referenceMap.keys());
  try {
    const trustedDirectory = await inspectSnapshotPath(boundary, artifactDirectory, 'directory');
    for (const fileName of await readdir(trustedDirectory.path)) {
      if (fileName.startsWith('sha256-')) {
        digests.add(fileName.slice('sha256-'.length));
      }
    }
  } catch (error) {
    if (error instanceof SnapshotPathError && error.code !== 'MISSING') {
      addDiagnostic(diagnostics, {
        severity: 'error',
        code: 'UNTRUSTED_ARTIFACT_DIRECTORY',
        path: '/artifacts',
        message: error.message,
        source: 'artifacts',
        file: artifactDirectory,
      });
    }
    // An artifact directory is optional when a snapshot has no artifact references.
  }

  const metadata = new Map<string, ArtifactMetadata>();
  for (const digest of [...digests].sort()) {
    const artifactPath = join(artifactDirectory, `sha256-${digest}`);
    let exists = false;
    let actualByteLength: number | undefined;
    try {
      const trustedFile = await inspectSnapshotPath(boundary, artifactPath, 'file');
      exists = true;
      actualByteLength = trustedFile.size;
      if (actualByteLength > maxArtifactBytes) {
        addDiagnostic(diagnostics, {
          severity: 'error',
          code: 'ARTIFACT_TOO_LARGE',
          path: `/artifacts/${digest}`,
          message: `Artifact "${digest}" is ${String(actualByteLength)} bytes, exceeding the ${String(maxArtifactBytes)} byte limit.`,
          source: 'artifacts',
          file: artifactPath,
        });
      }
    } catch (error) {
      if (error instanceof SnapshotPathError && error.code !== 'MISSING') {
        addDiagnostic(diagnostics, {
          severity: 'error',
          code: 'UNTRUSTED_ARTIFACT_ENTRY',
          path: `/artifacts/${digest}`,
          message: error.message,
          source: 'artifacts',
          file: artifactPath,
        });
      }
      // The missing-artifact diagnostic below is emitted for referenced artifacts.
    }

    const references = referenceMap.get(digest) ?? [];
    const expectedByteLengths = [
      ...new Set(references.map(({ reference }) => reference.byte_length)),
    ];
    const mediaTypes = [...new Set(references.map(({ reference }) => reference.media_type))];
    const previews = [
      ...new Set(
        references
          .map(({ reference }) => reference.preview)
          .filter((preview): preview is string => preview !== undefined),
      ),
    ];

    if (references.length > 0 && !exists) {
      references.forEach(({ path }) => {
        addDiagnostic(diagnostics, {
          severity: 'error',
          code: 'MISSING_ARTIFACT',
          path,
          message: `Referenced artifact "${digest}" is missing.`,
          source: 'artifacts',
          file: artifactPath,
        });
      });
    }

    if (exists && actualByteLength !== undefined) {
      references.forEach(({ path, reference }) => {
        if (reference.byte_length !== actualByteLength) {
          addDiagnostic(diagnostics, {
            severity: 'error',
            code: 'ARTIFACT_SIZE_MISMATCH',
            path,
            message: `Artifact "${digest}" has ${String(actualByteLength)} bytes; reference declares ${String(reference.byte_length)}.`,
            source: 'integrity',
            file: artifactPath,
          });
        }
      });
    }

    metadata.set(digest, {
      digest,
      path: artifactPath,
      exists,
      ...(expectedByteLengths.length === 1 ? { byte_length: expectedByteLengths[0] } : {}),
      ...(actualByteLength === undefined ? {} : { actual_byte_length: actualByteLength }),
      media_types: mediaTypes,
      previews,
    });
  }
  return metadata;
}

function createQueryModel(
  events: readonly EventEnvelope<string, unknown>[],
  indexes: TraceIndexes,
  manifest: SnapshotManifest | undefined,
): TraceQueryModel {
  const rootEvents = events.filter((event) => event.parent_ids.length === 0);

  return {
    getEvent: (eventId) => indexes.eventById.get(eventId),
    getParents: (eventId) => {
      const event = indexes.eventById.get(eventId);
      if (event === undefined) {
        return [];
      }
      return event.parent_ids
        .map((parentId) => indexes.eventById.get(parentId))
        .filter((parent): parent is EventEnvelope<string, unknown> => parent !== undefined);
    },
    getChildren: (eventId) => indexes.childrenById.get(eventId) ?? [],
    findEvents: (query = {}) => {
      const candidates =
        query.actor === undefined
          ? query.type === undefined
            ? events
            : (indexes.eventsByType.get(query.type) ?? [])
          : query.type === undefined
            ? (indexes.eventsByActor.get(query.actor) ?? [])
            : (indexes.eventsByActor.get(query.actor) ?? []).filter(
                (event) => event.type === query.type,
              );

      return candidates.filter(
        (event) =>
          (query.minSequence === undefined || event.sequence >= query.minSequence) &&
          (query.maxSequence === undefined || event.sequence <= query.maxSequence) &&
          (query.after === undefined || event.timestamp > query.after) &&
          (query.before === undefined || event.timestamp < query.before),
      );
    },
    getEventsByActor: (actor) => indexes.eventsByActor.get(actor) ?? [],
    getEventsByType: (type) => indexes.eventsByType.get(type) ?? [],
    getRootEvents: () => {
      if (manifest?.root_event_id !== undefined) {
        const declaredRoot = indexes.eventById.get(manifest.root_event_id);
        return declaredRoot === undefined ? rootEvents : [declaredRoot];
      }
      return rootEvents;
    },
  };
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

export async function loadTraceSnapshot(
  directory: string,
  options: TraceLoadOptions = {},
): Promise<TraceSnapshot> {
  const boundary = await createSnapshotPathBoundary(directory);
  const root = boundary.directory;
  const maxEventFileBytes = limit(
    options.maxEventFileBytes,
    defaultTraceLoadLimits.maxEventFileBytes,
    'maxEventFileBytes',
  );
  const maxArtifactBytes = limit(
    options.maxArtifactBytes,
    defaultTraceLoadLimits.maxArtifactBytes,
    'maxArtifactBytes',
  );
  const diagnostics: TraceDiagnostic[] = [];
  const manifestResult = await readManifest(boundary, diagnostics);
  const eventsResult = await readJsonlFile(
    boundary,
    join(root, 'events.jsonl'),
    diagnostics,
    maxEventFileBytes,
  );
  const checkpointValues = await readCheckpoints(boundary, join(root, 'checkpoints'), diagnostics);
  const manifest = isRecord(manifestResult.value)
    ? (manifestResult.value as unknown as SnapshotManifest)
    : undefined;
  const events = eventsResult.values.filter(isEventEnvelope);
  const checkpoints = checkpointValues.filter(isRecord) as unknown as Checkpoint[];

  const validation = validateSnapshot({
    manifest: manifestResult.value,
    events: eventsResult.values,
    checkpoints: checkpointValues,
  });
  diagnostics.push(...validation.diagnostics.map(fromValidationDiagnostic));

  const indexes = buildIndexes(events);
  buildStructuralDiagnostics(manifest, events, indexes, diagnostics);

  const referenceMap = new Map<string, Array<{ path: string; reference: ArtifactReference }>>();
  collectArtifactReferences(manifestResult.value, '/manifest', referenceMap);
  eventsResult.values.forEach((event, index) =>
    collectArtifactReferences(event, `/events/${index}`, referenceMap),
  );
  checkpointValues.forEach((checkpoint, index) =>
    collectArtifactReferences(checkpoint, `/checkpoints/${index}`, referenceMap),
  );
  const artifacts = await loadArtifactMetadata(
    boundary,
    referenceMap,
    diagnostics,
    maxArtifactBytes,
  );
  const artifactReferences = new Map<string, readonly ArtifactReference[]>(
    [...referenceMap.entries()].map(([digest, references]) => [
      digest,
      references.map(({ reference }) => reference),
    ]),
  );
  const query = createQueryModel(events, indexes, manifest);

  const readArtifact = async (digest: string): Promise<Uint8Array> => {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new ArtifactReadError(
        'ARTIFACT_INVALID_DIGEST',
        `Invalid artifact digest "${digest}".`,
      );
    }
    const metadata = artifacts.get(digest);
    if (metadata === undefined || !metadata.exists) {
      throw new ArtifactReadError('ARTIFACT_MISSING', `Artifact "${digest}" is missing.`);
    }
    if (
      metadata.actual_byte_length !== undefined &&
      metadata.actual_byte_length > maxArtifactBytes
    ) {
      throw new ArtifactReadError(
        'ARTIFACT_TOO_LARGE',
        `Artifact "${digest}" exceeds the configured read limit.`,
      );
    }
    let trustedFile;
    try {
      trustedFile = await inspectSnapshotPath(boundary, metadata.path, 'file');
    } catch (error) {
      throw new ArtifactReadError(
        'ARTIFACT_UNTRUSTED',
        error instanceof Error
          ? `Artifact "${digest}" is not a trusted snapshot file: ${error.message}`
          : `Artifact "${digest}" is not a trusted snapshot file.`,
      );
    }
    if (trustedFile.size > maxArtifactBytes) {
      throw new ArtifactReadError(
        'ARTIFACT_TOO_LARGE',
        `Artifact "${digest}" exceeds the configured read limit.`,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(trustedFile.path));
    } catch (error) {
      throw new ArtifactReadError(
        'ARTIFACT_UNAVAILABLE',
        error instanceof Error
          ? `Artifact "${digest}" could not be read: ${error.message}`
          : `Artifact "${digest}" could not be read.`,
      );
    }
    if (bytes.byteLength > maxArtifactBytes) {
      throw new ArtifactReadError(
        'ARTIFACT_TOO_LARGE',
        `Artifact "${digest}" exceeds the configured read limit.`,
      );
    }
    const mismatchedReference = artifactReferences
      .get(digest)
      ?.find((reference) => reference.byte_length !== bytes.byteLength);
    if (mismatchedReference !== undefined) {
      throw new ArtifactReadError(
        'ARTIFACT_SIZE_MISMATCH',
        `Artifact "${digest}" is ${String(bytes.byteLength)} bytes, expected ${String(
          mismatchedReference.byte_length,
        )} bytes.`,
      );
    }
    const actualDigest = createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== digest) {
      throw new ArtifactReadError(
        'ARTIFACT_DIGEST_MISMATCH',
        `Artifact "${digest}" does not match its SHA-256 digest.`,
      );
    }
    return bytes;
  };

  return {
    directory: root,
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    ...(manifest === undefined ? {} : { manifest }),
    ...(manifestResult.source === undefined ? {} : { manifestSource: manifestResult.source }),
    events,
    checkpoints,
    artifacts,
    artifactReferences,
    indexes,
    query,
    diagnostics,
    readArtifact,
  };
}

export const loadTrace = loadTraceSnapshot;
