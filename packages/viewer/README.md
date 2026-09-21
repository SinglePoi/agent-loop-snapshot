# @agent-loop-snapshot/viewer

Read-only local HTTP Viewer for one explicitly selected Agent Loop Snapshot.

```bash
npm install --save-dev @agent-loop-snapshot/cli
npx alsnap view ./runs/run-123
```

The Viewer binds only to `127.0.0.1`, emits a per-process session-token URL, accepts only `GET`/`HEAD`, and never executes snapshot content. Event details and reconstructed state are rendered as inert text; events and graph nodes use bounded pagination.

See [the local Viewer guide](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/local-viewer.md).
