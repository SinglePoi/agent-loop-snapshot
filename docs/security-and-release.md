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

State changes apply redaction rules at their logical JSON Pointer path. Logical fields named `path` or `operation` are ordinary state data; field and custom rules do not receive the event's protocol controls. Those controls are preserved exactly, while values and extension metadata remain subject to redaction. If a regex rule would change a control (for example a secret embedded in the JSON Pointer), the event is rejected with `STATE_REDACTION_UNREPRESENTABLE`; use non-sensitive state keys. Metadata transformed into a non-object is also rejected instead of falling back to the original payload. Some isolated increments cannot safely represent the redacted result:

- `STATE_REDACTION_UNREPRESENTABLE`: a rule removes the entire change target, removes an ancestor, replaces the append container, transforms a `merge` value into a non-object (including arrays and null), or removes a top-level key from a merge patch. Omitting a merge key cannot remove an existing value, so the event is rejected before persistence. Removing nested fields inside a child object that the shallow merge completely replaces remains supported. For a rejected `merge`, supply the complete updated target with `set`, not merely the merge patch.
- `STATE_REDACTION_CONTEXT_REQUIRED`: an increment cannot supply all data a custom rule could inspect. This includes a `merge` at a custom rule's target or descendant, a `set` beneath a custom-rule target, all global custom rules, and `append` (including `set` at a trailing `/-`) with an overlapping custom callback. Record the complete updated custom-rule target with `set`; scoped descendant custom rules may still be used with a `merge` when the patch supplies that descendant's complete value. Global custom rules cannot safely redact an incremental state event because the protocol has no root-state replacement. Position-independent field wildcard rules remain supported for append.

Other protocol events receive the same protection. Runtime descriptors, replay correlation and attempt fields, checkpoint IDs/sequences/hashes, terminal state hashes, and verification identity/results are preserved exactly. Field rules aimed at an exact protected field do not rewrite it; rules that would replace a containing protocol structure, or regex rules that match protected content, reject the event with `PROTOCOL_REDACTION_UNREPRESENTABLE` before persistence. Payload data such as inputs, outputs, error messages/details, and verification diagnostics remains redacted normally. Do not place a secret in any protocol control field.

Numeric addresses in every state operation also require stable array positions. If an element-level field remove rule or custom callback can compact any array along the path, or an ancestor rule can transform that array, the pipeline returns `STATE_REDACTION_CONTEXT_REQUIRED` before handling the value, including artifact-reference values. This includes fixed-index and wildcard rules, nested arrays, whole-array filtering, and updates inside an element. Use a complete array `set` so redaction can determine the resulting positions. Numeric object keys are treated conservatively as possible array indexes; full parent updates remain available. These checks do not rewrite pointers or introduce no-op operations.

Virtual ancestors preserve numeric pointer tokens as exact string properties, without numeric conversion or allocation proportional to the key's value. Large numeric object keys therefore remain supported when no rule requires unavailable container context. Supplied arrays retain array semantics, including indexed updates and trailing `/-` appends; the conservative address checks above still apply.

A dash (`-`) inside a path, or at a `merge`/`append` target, is preserved as an object key. Only a trailing dash on `set` is ambiguous between an object key and an array append. If a field rule addresses that exact dash key, the pipeline returns `STATE_REDACTION_CONTEXT_REQUIRED` before persistence; use a complete parent `set`. Position-independent wildcard field rules remain supported under the existing append safeguards.

Reference placeholders identify canonical JSON values: object property order does not change the placeholder, while array order does. Array removals retain their redaction audit entry. A redaction inside an append is recorded at the protocol path using `/-`, never an invented index such as `/0`.

Handle these errors before treating the recording as successful. With the pipeline before `SnapshotWriter.asInterceptor()`, a rejected event is not written and does not advance the Recorder sequence. Do not retry without redaction. Use a complete parent-object/array update where representable; if the protocol cannot express the removed target as a safe update, stop that recording operation explicitly. The pipeline does not invent a no-op state event or silently change the snapshot protocol.

`delete` has no original state to project. It is rejected with `STATE_REDACTION_UNREPRESENTABLE` when field rules can remove its target or replace an ancestor. It is rejected with `STATE_REDACTION_CONTEXT_REQUIRED` when element removal can shift an addressed array index, deletion can shift index-specific field rules, or relevant custom callbacks require state/position context (global callbacks are always relevant). Numeric object keys are conservatively treated as possible array indexes. These checks apply even when an optional value is attached to the delete event.

Ordinary object deletes, deletion of an exactly masked/referenced field, deletion of a whole parent containing removed descendants, and position-independent wildcard array deletes remain supported when no other rule conflicts. For rejected deletes, record the complete updated parent object or array using `set`; do not simply ignore the recording error or turn every missing delete into a no-op.

## Release checklist

This repository is currently an internal preview: all workspace packages remain `private`, so no registry publication can occur accidentally. Before a public release, choose the npm scope/registry and explicitly remove `private` in a reviewed release change.

Run the following from a clean checkout with Node.js `24.20.x` and pnpm `11.19.x`:

```bash
pnpm install --frozen-lockfile
pnpm run release:verify
```

`release:verify` runs the quality gate, builds every package, checks the tarball contents, then creates fresh package tarballs and installs them into an automatically removed temporary consumer directory. The clean install may fetch external production dependencies from the configured registry; internal packages are always installed from the generated tarballs. That installed CLI validates the sanitized example snapshot, exports its Mermaid graph, and creates a Mock Replay snapshot.

Before publishing, also review [CHANGELOG.md](../CHANGELOG.md), increment all package versions consistently, verify the generated tarballs contain only `dist/` plus required schemas/fixtures, and publish from CI using short-lived registry credentials. No release credential should be stored in this repository.
