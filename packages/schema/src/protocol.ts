export const snapshotSchemaVersion = '0.1.0' as const;

export type SnapshotSchemaVersion = typeof snapshotSchemaVersion;

export const schemaFiles = {
  artifactReference: 'artifact-reference.schema.json',
  checkpoint: 'checkpoint.schema.json',
  events: 'events.schema.json',
  manifest: 'manifest.schema.json',
} as const;
