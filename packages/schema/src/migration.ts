import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { snapshotSchemaVersion } from './protocol.js';
import {
  validateSnapshot,
  validateSnapshotDirectory,
  type SnapshotDocument,
  type ValidationDiagnostic,
} from './validator.js';

export type SnapshotCompatibilityStatus = 'executable' | 'migratable' | 'view_only';

export interface SnapshotCompatibility {
  readonly sourceVersion?: string;
  readonly status: SnapshotCompatibilityStatus;
  readonly canExecute: boolean;
  readonly canMigrate: boolean;
  readonly reason: string;
}

export interface SnapshotMetadataView {
  readonly schemaVersion?: string;
  readonly snapshotType?: string;
  readonly runId?: string;
  readonly runState?: string;
  readonly runtimeName?: string;
}

export interface SnapshotMigrationStep {
  readonly from: string;
  readonly to: string;
  readonly description: string;
}

export type SnapshotMigrationDiagnosticCode =
  | 'MISSING_SCHEMA_VERSION'
  | 'INVALID_SCHEMA_VERSION'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'MIGRATED_DOCUMENT_INVALID'
  | 'SOURCE_DIRECTORY_INVALID'
  | 'OUTPUT_EQUALS_SOURCE'
  | 'OUTPUT_ALREADY_EXISTS'
  | 'OUTPUT_DIRECTORY_INVALID';

export interface SnapshotMigrationDiagnostic {
  readonly severity: 'error';
  readonly code: SnapshotMigrationDiagnosticCode;
  readonly message: string;
  readonly validationDiagnostics?: readonly ValidationDiagnostic[];
}

export interface SnapshotMigrationReport {
  readonly sourceVersion: string;
  readonly targetVersion: typeof snapshotSchemaVersion;
  readonly appliedSteps: readonly SnapshotMigrationStep[];
}

export interface SnapshotMigrationResult {
  readonly document?: SnapshotDocument;
  readonly report?: SnapshotMigrationReport;
  readonly diagnostics: readonly SnapshotMigrationDiagnostic[];
}

export interface SnapshotDirectoryMigrationResult extends SnapshotMigrationResult {
  readonly outputDirectory?: string;
}

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const legacyMigration: SnapshotMigrationStep = {
  from: '0.0.0',
  to: '0.1.0',
  description: 'Normalize v0.0.0 persisted object version markers to Snapshot Schema v0.1.0.',
};

const observationMigration: SnapshotMigrationStep = {
  from: '0.1.0',
  to: snapshotSchemaVersion,
  description:
    'Add v0.2.0 observation provenance and completeness metadata without changing recorded facts.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function parseSemver(value: string): Semver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Reads only safe manifest metadata; it does not parse or execute event payloads. */
export function viewSnapshotMetadata(manifest: unknown): SnapshotMetadataView {
  const runtime = isRecord(manifest) && isRecord(manifest.runtime) ? manifest.runtime : undefined;
  const schemaVersion = readString(manifest, 'schema_version');
  const snapshotType = readString(manifest, 'snapshot_type');
  const runId = readString(manifest, 'run_id');
  const runState = readString(manifest, 'run_state');
  return {
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(snapshotType === undefined ? {} : { snapshotType }),
    ...(runId === undefined ? {} : { runId }),
    ...(runState === undefined ? {} : { runState }),
    ...(runtime === undefined || typeof runtime.name !== 'string'
      ? {}
      : { runtimeName: runtime.name }),
  };
}

export function inspectSnapshotCompatibility(manifest: unknown): SnapshotCompatibility {
  const sourceVersion = readString(manifest, 'schema_version');
  if (sourceVersion === undefined) {
    return {
      status: 'view_only',
      canExecute: false,
      canMigrate: false,
      reason: 'Snapshot manifest does not declare schema_version.',
    };
  }
  const source = parseSemver(sourceVersion);
  const current = parseSemver(snapshotSchemaVersion)!;
  if (source === undefined) {
    return {
      sourceVersion,
      status: 'view_only',
      canExecute: false,
      canMigrate: false,
      reason: 'Snapshot schema_version is not a supported semantic version.',
    };
  }
  if (sourceVersion === snapshotSchemaVersion) {
    return {
      sourceVersion,
      status: 'executable',
      canExecute: true,
      canMigrate: true,
      reason: 'Snapshot matches the current schema exactly.',
    };
  }
  if (sourceVersion === legacyMigration.from || sourceVersion === observationMigration.from) {
    return {
      sourceVersion,
      status: 'migratable',
      canExecute: false,
      canMigrate: true,
      reason: 'Snapshot has a registered forward migration to the current schema.',
    };
  }
  if (source.major !== current.major) {
    return {
      sourceVersion,
      status: 'view_only',
      canExecute: false,
      canMigrate: false,
      reason: 'Unknown major schema versions are metadata-viewable but never executable.',
    };
  }
  return {
    sourceVersion,
    status: 'view_only',
    canExecute: false,
    canMigrate: false,
    reason: 'No explicit migration is registered for this schema version.',
  };
}

function replaceVersion(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceVersion(entry, from, to));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === 'schema_version' && entry === from ? to : replaceVersion(entry, from, to),
    ]),
  );
}

function cloneDocument(document: SnapshotDocument): SnapshotDocument {
  return structuredClone(document);
}

function addObservationMetadata(document: SnapshotDocument): SnapshotDocument {
  const migrated = cloneDocument(document);
  if (!isRecord(migrated.manifest)) {
    return migrated;
  }
  const incomplete = migrated.manifest.run_state === 'incomplete';
  migrated.manifest = {
    ...migrated.manifest,
    source: 'native',
    completeness: incomplete ? 'partial' : 'complete',
    limitations: incomplete
      ? [{ code: 'recording_failed', message: 'Legacy snapshot was recorded as incomplete.' }]
      : [],
  };
  return migrated;
}

export function migrateSnapshot(document: SnapshotDocument): SnapshotMigrationResult {
  const compatibility = inspectSnapshotCompatibility(document.manifest);
  if (compatibility.sourceVersion === undefined) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'MISSING_SCHEMA_VERSION',
          message: compatibility.reason,
        },
      ],
    };
  }
  if (parseSemver(compatibility.sourceVersion) === undefined) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'INVALID_SCHEMA_VERSION',
          message: compatibility.reason,
        },
      ],
    };
  }
  if (!compatibility.canMigrate) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'UNSUPPORTED_SCHEMA_VERSION',
          message: compatibility.reason,
        },
      ],
    };
  }

  let migrated = cloneDocument(document);
  const appliedSteps: SnapshotMigrationStep[] = [];
  if (compatibility.sourceVersion === legacyMigration.from) {
    migrated = replaceVersion(
      migrated,
      legacyMigration.from,
      legacyMigration.to,
    ) as SnapshotDocument;
    appliedSteps.push(legacyMigration);
  }
  if (
    compatibility.sourceVersion === legacyMigration.from ||
    compatibility.sourceVersion === observationMigration.from
  ) {
    migrated = replaceVersion(
      migrated,
      observationMigration.from,
      observationMigration.to,
    ) as SnapshotDocument;
    migrated = addObservationMetadata(migrated);
    appliedSteps.push(observationMigration);
  }
  const validation = validateSnapshot(migrated);
  if (!validation.valid) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'MIGRATED_DOCUMENT_INVALID',
          message: 'The migrated snapshot does not satisfy the current schema.',
          validationDiagnostics: validation.diagnostics,
        },
      ],
    };
  }
  return {
    document: migrated,
    report: {
      sourceVersion: compatibility.sourceVersion,
      targetVersion: snapshotSchemaVersion,
      appliedSteps,
    },
    diagnostics: [],
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readSnapshotDirectory(sourceDirectory: string): Promise<SnapshotDocument> {
  const manifest = await readJson(join(sourceDirectory, 'manifest.json'));
  const eventText = await readFile(join(sourceDirectory, 'events.jsonl'), 'utf8');
  const events = eventText
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
  let checkpoints: unknown[] = [];
  try {
    const checkpointDirectory = join(sourceDirectory, 'checkpoints');
    const files = (await readdir(checkpointDirectory))
      .filter((file) => file.endsWith('.json'))
      .sort();
    checkpoints = await Promise.all(files.map((file) => readJson(join(checkpointDirectory, file))));
  } catch {
    checkpoints = [];
  }
  return { manifest, events, checkpoints };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeMigratedDirectory(
  temporaryDirectory: string,
  document: SnapshotDocument,
  sourceDirectory: string,
): Promise<void> {
  await writeFile(
    join(temporaryDirectory, 'manifest.json'),
    `${JSON.stringify(document.manifest, null, 2)}\n`,
  );
  await writeFile(
    join(temporaryDirectory, 'events.jsonl'),
    document.events.map((event) => JSON.stringify(event)).join('\n') +
      (document.events.length === 0 ? '' : '\n'),
  );
  if ((document.checkpoints?.length ?? 0) > 0) {
    const checkpointDirectory = join(temporaryDirectory, 'checkpoints');
    await mkdir(checkpointDirectory);
    await Promise.all(
      document.checkpoints!.map((checkpoint, index) =>
        writeFile(
          join(checkpointDirectory, `${String(index + 1).padStart(6, '0')}.json`),
          `${JSON.stringify(checkpoint, null, 2)}\n`,
        ),
      ),
    );
  }
  const sourceArtifacts = join(sourceDirectory, 'artifacts');
  if (await pathExists(sourceArtifacts)) {
    await cp(sourceArtifacts, join(temporaryDirectory, 'artifacts'), { recursive: true });
  }
}

/**
 * Writes a migrated copy to an output directory that must not yet exist. The
 * source directory is read-only throughout; failed writes remain in a private
 * temporary directory and never replace the requested output path.
 */
export async function migrateSnapshotDirectory(
  sourceDirectory: string,
  outputDirectory: string,
): Promise<SnapshotDirectoryMigrationResult> {
  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  if (source === output) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'OUTPUT_EQUALS_SOURCE',
          message: 'Migration output directory must differ from the source directory.',
        },
      ],
    };
  }
  if (await pathExists(output)) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'OUTPUT_ALREADY_EXISTS',
          message: 'Migration output directory must not already exist.',
        },
      ],
    };
  }

  let sourceDocument: SnapshotDocument;
  try {
    sourceDocument = await readSnapshotDirectory(source);
  } catch (error) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'SOURCE_DIRECTORY_INVALID',
          message:
            error instanceof Error ? error.message : 'Could not read source snapshot directory.',
        },
      ],
    };
  }
  const migration = migrateSnapshot(sourceDocument);
  if (migration.document === undefined || migration.report === undefined) {
    return migration;
  }

  let temporaryDirectory: string;
  try {
    temporaryDirectory = await mkdtemp(join(dirname(output), '.alsnap-migration-'));
  } catch (error) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'OUTPUT_DIRECTORY_INVALID',
          message:
            error instanceof Error
              ? error.message
              : 'Could not create a temporary migration directory.',
        },
      ],
    };
  }
  try {
    await writeMigratedDirectory(temporaryDirectory, migration.document, source);
    const validation = await validateSnapshotDirectory(temporaryDirectory);
    if (!validation.valid) {
      return {
        diagnostics: [
          {
            severity: 'error',
            code: 'OUTPUT_DIRECTORY_INVALID',
            message: 'The migrated output directory did not pass validation.',
            validationDiagnostics: validation.diagnostics,
          },
        ],
      };
    }
    await rename(temporaryDirectory, output);
    return { ...migration, outputDirectory: output };
  } finally {
    if (await pathExists(temporaryDirectory)) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
