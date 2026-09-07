# Changelog

All notable changes to Agent Loop Snapshot are recorded here. This project follows Semantic Versioning; a release is created only after the package scope, registry and release owner are explicitly chosen.

## Unreleased

### Security

- Treat snapshot directories as untrusted input: directory validation and Trace loading reject non-regular event/artifact files and impose configurable 64 MiB defaults for events and artifact reads.
- Preserve secret-safe CLI summaries: inspect output excludes event payloads, and Mermaid labels escape untrusted event metadata.
- Keep replay side effects denied by default unless the current caller supplies a fresh, matching approval.

### Reliability

- Add Recorder, Trace Loader and Graph performance baselines; add concurrent Recorder and storage-failure coverage.
- Ensure failed durable event writes cannot advance the Recorder's visible event sequence or terminal state.

## 0.1.0

- Initial internal preview of the Snapshot Schema, Recorder, Trace Loader, Graph, Replay, CLI and framework-neutral example runtime.
