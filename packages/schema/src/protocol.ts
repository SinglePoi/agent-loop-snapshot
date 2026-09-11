export const snapshotSchemaVersion = '0.2.0' as const;

export type SnapshotSchemaVersion = typeof snapshotSchemaVersion;

export const supportedSnapshotSchemaVersions = ['0.1.0', snapshotSchemaVersion] as const;

export type SupportedSnapshotSchemaVersion = (typeof supportedSnapshotSchemaVersions)[number];

export function isSupportedSnapshotSchemaVersion(
  value: unknown,
): value is SupportedSnapshotSchemaVersion {
  return typeof value === 'string' && supportedSnapshotSchemaVersions.includes(value as never);
}

/** Workflow IR deliberately evolves independently from persisted snapshots. */
export const workflowSchemaVersion = '0.1.0' as const;

export type WorkflowSchemaVersion = typeof workflowSchemaVersion;

export const schemaFiles = {
  artifactReference: 'artifact-reference.schema.json',
  checkpoint: 'checkpoint.schema.json',
  events: 'events.schema.json',
  manifest: 'manifest.schema.json',
  workflow: 'workflow.schema.json',
} as const;
