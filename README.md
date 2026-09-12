# Agent Loop Snapshot

[简体中文](README.zh-CN.md) · [User Guide](docs/user-guide.md) · [npm packages](https://www.npmjs.com/search?q=%40agent-loop-snapshot)

Agent Loop Snapshot is an open-source toolkit for recording, inspecting, visualizing, and replaying Agent Runtime executions. It stores model calls, tool calls, state changes, checkpoints, and artifacts from an Agent Loop as portable snapshots, making it easier to audit runs, debug control flow, and reproduce tasks under explicit permission and verification rules.

The project is open source on [GitHub](https://github.com/SinglePoi/agent-loop-snapshot), and its core packages are published to npm. The current public release is `0.1.2`.

> The current Snapshot Schema version is `0.2.0`. OTLP imports are always observation-only. OTLP export has no default cloud destination and must be explicitly configured by the caller.

## Features

- Record Agent runs as append-only JSONL events while preserving causality for parallel branches, retries, and joins through `parent_ids`.
- Persist explicit checkpoints and SHA-256 content-addressed artifacts with integrity verification and state reconstruction.
- Project traces into causal DAGs, call trees, or linear timelines, with Mermaid and JSON output.
- Provide Mock, Verified, and Semantic replay modes, plus Trace-to-Workflow IR compilation.
- Redact data before persistence with JSON Pointer rules, array wildcards, regular expressions, and custom redactors.
- Instrument custom model and tool functions with framework-neutral TypeScript APIs.
- Automatically capture OpenAI and Anthropic SDK calls, including non-streaming calls and `stream: true` async iteration.
- Import OTLP/HTTP JSON traces or export snapshots to OTLP/HTTP through a durable local queue.
- Apply explicit safety gates to execution and side effects; historical approvals are never reused as authorization for a new run.

The project does not attempt to guarantee token-level determinism and does not record or depend on hidden model chain-of-thought. Snapshots contain auditable inputs, outputs, tool results, state changes, and concise decision summaries.

## Installation

Node.js `24.20.x` is required. pnpm is not required when using only the CLI.

```bash
# Validate, inspect, graph, replay, and import/export OTLP
npm install --save-dev @agent-loop-snapshot/cli

# Instrument custom models and tools
npm install @agent-loop-snapshot/instrumentation

# Automatically capture OpenAI or Anthropic SDK calls
npm install @agent-loop-snapshot/instrumentation-openai
npm install @agent-loop-snapshot/instrumentation-anthropic
```

The CLI command is `alsnap`:

```bash
npx alsnap --help
npx alsnap validate ./runs/run-123
npx alsnap inspect ./runs/run-123 --json
```

Install lower-level packages as needed:

| Capability | npm package |
| --- | --- |
| Snapshot and Workflow schemas, compatibility checks, and migrations | [`@agent-loop-snapshot/schema`](https://www.npmjs.com/package/@agent-loop-snapshot/schema) |
| Run recording, checkpoints, artifacts, and redaction | [`@agent-loop-snapshot/recorder`](https://www.npmjs.com/package/@agent-loop-snapshot/recorder) |
| Trace loading, querying, and state reconstruction | [`@agent-loop-snapshot/trace`](https://www.npmjs.com/package/@agent-loop-snapshot/trace) |
| DAG, call-tree, and timeline projections | [`@agent-loop-snapshot/graph`](https://www.npmjs.com/package/@agent-loop-snapshot/graph) |
| Mock, Verified, and Semantic Replay; Workflow compilation | [`@agent-loop-snapshot/replay`](https://www.npmjs.com/package/@agent-loop-snapshot/replay) |
| OTLP/HTTP JSON import | [`@agent-loop-snapshot/otel-import`](https://www.npmjs.com/package/@agent-loop-snapshot/otel-import) |
| OTLP/HTTP export | [`@agent-loop-snapshot/otel-export`](https://www.npmjs.com/package/@agent-loop-snapshot/otel-export) |

## Quick start

### Run the offline examples

The repository examples require no API key, Docker, or real model request:

```bash
pnpm install
pnpm build

# Generic function instrumentation
node examples/function-instrumentation/demo.mjs

# OpenAI SDK instrumentation (local HTTP fixture; no external request)
node examples/sdk-instrumentation/demo.mjs

# Import OTLP/HTTP JSON
pnpm alsnap -- import-otel examples/otel-import/trace.json \
  --output ./runs/otel-import --json
```

Run all offline examples in one command:

```bash
pnpm run examples:check
```

### Record a custom Agent

Use `instrument()` when your model and tools are Promise-based functions owned by your application:

```ts
import { instrument } from '@agent-loop-snapshot/instrumentation';

const agent = instrument({
  snapshotDir: './runs',
  runtime: { name: 'my-agent', version: '1.0.0' },
  model: {
    name: 'my-model',
    call: async (prompt: string) => existingModel.generate(prompt),
  },
  tools: {
    search: {
      sideEffect: 'read_only',
      call: async (query: string) => searchDocuments(query),
    },
  },
});

const answer = await agent.run(
  { input: { goal: 'Research and summarize' } },
  async ({ model, tools, checkpoint }) => {
    const query = await model.call('Generate a search query');
    const documents = await tools.search(query);
    await checkpoint({ query, documents });
    return model.call(JSON.stringify(documents));
  },
);
```

Tools must declare their side-effect level explicitly. `checkpoint()` stores only the state supplied by the caller; ordinary model responses, tool results, and decision summaries remain observation state and do not automatically become recoverable state.

### Automatically capture SDK calls

Initialize integrations before loading application modules, then wrap one run with `telemetry.run()`:

```ts
import { initInstrumentation } from '@agent-loop-snapshot/instrumentation';
import { openAIIntegration } from '@agent-loop-snapshot/instrumentation-openai';
import { anthropicIntegration } from '@agent-loop-snapshot/instrumentation-anthropic';

const telemetry = initInstrumentation({
  snapshotDir: './runs',
  integrations: [
    openAIIntegration({ recording: 'metadata-only' }),
    anthropicIntegration({ recording: 'metadata-only' }),
  ],
});

const { main } = await import('./app.js');
try {
  await telemetry.run({ input: { goal: 'Complete the task' } }, () => main());
} finally {
  await telemetry.shutdown();
}
```

Current support matrix:

- OpenAI `7.15.0`: Chat Completions and Responses `create()` calls.
- Anthropic `0.125.0`: Messages `create()` calls.
- Both support non-streaming calls and `stream: true` async iteration. Streams are observed only while the application actually iterates them.

SDK instrumentation is best-effort: capture failures produce diagnostics without replacing the SDK result or application error. SDKs must be loaded after initialization. SDK `.stream()` helpers, Azure/Bedrock/Vertex-specific clients, and SDK versions outside the fixed matrix are not currently supported.

## CLI

Assuming the snapshot is at `./runs/run-123`:

```bash
# Validate the snapshot, events, and artifact references
npx alsnap validate ./runs/run-123

# Inspect a payload-free run summary
npx alsnap inspect ./runs/run-123

# Output a Mermaid causal graph or a JSON timeline
npx alsnap graph ./runs/run-123 --format mermaid
npx alsnap graph ./runs/run-123 --kind timeline --format json

# Mock Replay writes a new snapshot directory
npx alsnap replay ./runs/run-123 \
  --mode mock --output ./runs/run-123-mock-replay
```

All commands support `--json` for machine-readable output. Exit codes are `0` for success, `2` for invalid snapshots, no valid imported trace, or an export that was not fully accepted, and `1` for usage or runtime errors.

## OTLP import and export

### Import

`alsnap import-otel` accepts OTLP/HTTP JSON `ExportTraceServiceRequest` files containing `resourceSpans`. It does not accept protobuf, gRPC, console text, or vendor UI exports:

```bash
npx alsnap import-otel trace-a.json trace-b.json \
  --output ./imported-runs --json
```

Each input file is limited to 64 MiB. Imported results are observation-only snapshots: they can be validated, inspected, and graphed, but cannot be replayed, resumed, or compiled into executable Workflows. Import never sends data to an external system automatically.

### Export

`@agent-loop-snapshot/otel-export` maps snapshots to OTLP/HTTP and sends them through a durable local queue. The default `metadata-only` policy excludes model inputs/outputs, tool arguments/results, state values, exception bodies, and arbitrary free text. An endpoint must be configured explicitly; production endpoints should use HTTPS:

```json
{
  "targetAlias": "local-collector",
  "endpointEnv": "OTLP_TRACES_ENDPOINT",
  "headersEnv": { "Authorization": "OTLP_AUTHORIZATION" },
  "serviceName": "my-agent",
  "queueDir": "./runs/otlp-queue",
  "contentPolicy": "metadata-only",
  "batchSpanLimit": 512,
  "timeoutMs": 10000,
  "retryMaxAttempts": 3,
  "retryBudgetMs": 30000
}
```

```bash
# Check mapping, filtering, and data loss; no network, queue, or credentials
npx alsnap export-otel ./runs/run-123 \
  --config ./export.json --dry-run --json

# Send, then resume queued batches with the same configuration fingerprint
npx alsnap export-otel ./runs/run-123 --config ./export.json --json
npx alsnap export-otel --resume --config ./export.json --json
```

Credentials must be supplied through environment variables. Never put tokens or API keys in configuration files, snapshots, or the Git repository. See [OTLP export and platform integration](docs/otel-export.md) for the full configuration and compatibility matrix.

## Snapshot model

```text
run-snapshot/
├── manifest.json
├── events.jsonl
├── checkpoints/
│   └── 000001.json
└── artifacts/
    └── sha256-<digest>
```

- `Trace`: the append-only event record produced by a run.
- `Checkpoint`: caller-provided recoverable state.
- `Artifact`: a file, image, or large tool output addressed by SHA-256.
- `Graph Projection`: a DAG, call tree, or timeline derived from event causality.
- `Workflow IR`: a parameterizable execution flow distilled from a Trace.
- `Replay`: reuse recorded results, invoke tools again, or ask another Agent to reproduce the task semantically.

`events.jsonl` is the factual record. A Workflow file is a reviewed execution flow distilled from that record. Failed attempts, environmental accidents, approvals, and decision text from a historical run are not copied into a Workflow automatically.

## Replay and safety

| Mode | Behavior | Use case |
| --- | --- | --- |
| Mock Replay | Uses recorded model and tool results without producing new side effects | Control-flow debugging and UI reproduction |
| Verified Replay | Re-executes calls and compares results with the snapshot or assertions | Regression and compatibility testing |
| Semantic Replay | Another Agent completes the task from its goal, constraints, and success conditions | Cross-model and cross-framework reuse |

Side effects are denied by default. Verified and Semantic Replay require caller-supplied adapters, current authorization, and verifiers. Historical approvals never authorize a new run. Imported OTLP snapshots and observation snapshots without a verifiable final state are not executable.

## Development

The repository is a TypeScript monorepo managed with pnpm. Node.js `24.20.x` and pnpm `11.19.x` are required:

```bash
pnpm install
pnpm run check
```

Useful commands:

```bash
pnpm build              # Build all workspace packages
pnpm run examples:check # Run the offline examples
pnpm run benchmark:als-502
pnpm run release:verify # Quality gate, packaging, and consumer smoke test
```

CI runs `pnpm run check`. Real OpenTelemetry Collector end-to-end verification requires Docker and can be run with `pnpm run collector:verify`.

## Documentation

- [User Guide](docs/user-guide.md)
- [Workflow IR v0.1](docs/workflow-ir-v0.1.md)
- [Schema compatibility and migration](docs/schema-compatibility.md)
- [OTLP export and platform integration](docs/otel-export.md)
- [Security and release guide](docs/security-and-release.md)
- [Implementation plan](docs/implementation-plan.md)
- [Changelog](CHANGELOG.md)
- [Architecture Decision Records](docs/adr/)

## License

Agent Loop Snapshot is released under the [MIT License](LICENSE).

## Contributing

Issues, ideas, and pull requests are welcome on [GitHub Issues](https://github.com/SinglePoi/agent-loop-snapshot/issues). When protocol or security semantics change, update the schemas, migration tests, and relevant documentation together.
