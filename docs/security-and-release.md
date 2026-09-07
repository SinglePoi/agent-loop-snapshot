# Security and release guide

## Trust boundary

Treat every supplied snapshot directory as untrusted input. The CLI never executes payloads while validating, inspecting, or projecting a trace. `inspect` intentionally prints metadata, counters, event types and error codes rather than event payloads. Mermaid output assigns generated node IDs and escapes labels derived from trace metadata.

Replay is different: Mock Replay only consumes recorded results; verified and semantic replay require caller-supplied adapters. Side effects are denied by default, and historical approvals are never accepted as current authorization.

## Input limits and paths

`loadTraceSnapshot()` and `validateSnapshotDirectory()` default to these limits:

| Input | Default | Configuration |
| --- | ---: | --- |
| `events.jsonl` | 64 MiB | `maxEventFileBytes` |
| Single artifact read or validation | 64 MiB | `maxArtifactBytes` |

Files exceeding a limit produce `EVENT_FILE_TOO_LARGE` or `ARTIFACT_TOO_LARGE`; callers can use lower positive integer limits. Event and artifact entries must be regular files. Symbolic links, directories and other special entries are rejected as untrusted, so file reads remain within the chosen snapshot directory.

The project does not unpack archives or decode compressed artifact formats. Store an archive as an opaque artifact and apply a separate, format-aware extraction service with its own size and path policy if extraction is required. Do not pass a snapshot archive to a shell command or execute scripts stored in artifacts.

## Secrets

Use `createDefaultRedactionPipeline()` before every persistence boundary. It covers common API key and authorization patterns; add field rules for application-specific credentials. Secrets must be supplied only through environment variables such as `ALS_MODEL_API_KEY`; `.env` files are ignored by Git. Do not include credentials, production payloads, or unredacted snapshots in fixtures, issue reports, benchmark output or release archives.

## Release checklist

This repository is currently an internal preview: all workspace packages remain `private`, so no registry publication can occur accidentally. Before a public release, choose the npm scope/registry and explicitly remove `private` in a reviewed release change.

Run the following from a clean checkout with Node.js `24.20.x` and pnpm `11.19.x`:

```bash
pnpm install --frozen-lockfile
pnpm run release:verify
```

`release:verify` runs the quality gate, builds every package, checks the tarball contents, then creates fresh package tarballs and installs them into an automatically removed temporary consumer directory. The clean install may fetch external production dependencies from the configured registry; internal packages are always installed from the generated tarballs. That installed CLI validates the sanitized example snapshot, exports its Mermaid graph, and creates a Mock Replay snapshot.

Before publishing, also review [CHANGELOG.md](../CHANGELOG.md), increment all package versions consistently, verify the generated tarballs contain only `dist/` plus required schemas/fixtures, and publish from CI using short-lived registry credentials. No release credential should be stored in this repository.
