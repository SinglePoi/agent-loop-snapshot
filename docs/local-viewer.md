# Local Viewer

Start a read-only Viewer for one explicit snapshot directory:

```bash
pnpm alsnap -- view ./runs/run-123
```

The command prints a `127.0.0.1` URL with a new session token. Keep that token private to the local session; stop the Viewer with `Ctrl+C` when finished. The server does not scan parent directories, accept a directory path through HTTP, listen on a non-loopback address, write snapshots, execute replay, upload content, or manage credentials.

The page shows run metadata, source/completeness, diagnostics, a paged timeline, failure filtering, a paged causal graph, event payload detail as inert text, reconstructed state when available, checkpoints, and artifact metadata. Graph and state reconstruction begin only after the user chooses their respective **Load** button. It labels missing or oversized details instead of fabricating an empty value. Artifact bytes are not served by the first release.

The Viewer permits only `GET` and `HEAD` requests. It checks the loopback `Host`, same-origin browser requests, and the session token before serving HTML or API data. Its CSP disallows external resources, frames, forms, and navigation bases. Snapshot files continue to be loaded through the existing regular-file and symbolic-link boundary checks.

For very large runs, APIs page events and graph nodes (default 100, hard maximum 500); the UI loads additional pages only when requested. It does not render arbitrary snapshot values as HTML or SVG. The current 100k-event baseline is recorded in [Viewer 100k baseline](benchmarks/viewer-100k.md).

This is an inspection surface, not an execution surface: Snapshot execution eligibility may be displayed from metadata, but it never enables Mock, Verified, or Semantic Replay.
