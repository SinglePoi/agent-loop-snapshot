# Local Viewer 100k baseline

Command:

```bash
pnpm run benchmark:viewer
```

Baseline recorded on 2026-09-21 with Node.js `v24.20.0` on `win32-x64`:

| Measure | Result |
| --- | ---: |
| Events | 100,000 |
| Viewer startup | 1391.83 ms |
| First timeline page (100 nodes) | 17.15 ms |
| First causal-graph page (100 nodes) | 332.77 ms |
| RSS delta | 195.96 MiB |

The benchmark creates and removes its own sanitized local snapshot. The first page remains bounded to 100 entries; state reconstruction is deliberately not included because the UI performs it only after the user chooses **Load reconstructed state**.
