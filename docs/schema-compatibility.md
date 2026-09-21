# Schema compatibility and migration

Snapshot Schema uses semantic versions. Version compatibility is deliberately conservative: a snapshot is executable only when its persisted schema exactly matches a version the current runtime understands; version inspection never implies execution authority.

| Source version | Handling | Execute | Migrate |
| --- | --- | --- | --- |
| `0.1.0` | Current schema | Yes | Idempotent copy only |
| `0.0.0` | Registered legacy migration | No, until migrated | Yes, to `0.1.0` |
| Other `0.x.y` | Safe metadata view | No | No, until a migration is registered |
| Different major | Safe metadata view | No | No |
| Missing or invalid version | Safe metadata view when fields are readable | No | No |

`viewSnapshotMetadata()` reads only manifest metadata such as version, run ID, state, and runtime name. `inspectSnapshotCompatibility()` provides the actionable status without parsing payloads or running adapters.

`migrateSnapshot()` is pure: it returns a cloned, migrated document and a report of applied steps. The first registered step changes every persisted `schema_version` marker from `0.0.0` to `0.1.0`, then validates the full result using the current schema.

`migrateSnapshotDirectory(source, output)` writes only to an output directory that does not already exist and rejects `source === output`. It creates a temporary sibling directory, validates the migrated snapshot there, then atomically renames it to the requested output. The source snapshot is never overwritten; artifacts are copied unchanged. Re-running a completed migration is safe because the existing output is rejected rather than replaced.
