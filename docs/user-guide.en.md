# Agent Loop Snapshot User Guide

[简体中文](user-guide.md)

This guide is for users who want to record, inspect, import, or export Agent runs. It covers both npm installation and source development: install only the CLI, or add SDK packages as needed.

The current public release is `0.1.1`, published to the official npm registry: <https://registry.npmjs.org/>. All packages use the `@agent-loop-snapshot` scope, and the CLI command is `alsnap`. Each package's npm page also includes a package-level README.

## 1. Set up your environment

Node.js `24.20.x` is required (`>=24.20.0 <25`). pnpm is not required when using only the CLI.

### Install the CLI

Install it in your project:

```powershell
npm install --save-dev @agent-loop-snapshot/cli
```

Then run commands with `npx alsnap <command>`, for example:

```powershell
npx alsnap validate ./runs/run-123
npx alsnap inspect ./runs/run-123 --json
```

### Install the SDK packages

Install the packages for your use case:

```powershell
# Record custom model and tool functions
npm install @agent-loop-snapshot/instrumentation

# Automatically capture existing OpenAI / Anthropic SDK calls
npm install @agent-loop-snapshot/instrumentation-openai @agent-loop-snapshot/instrumentation-anthropic
```

`@agent-loop-snapshot/instrumentation` installs the core dependencies it needs. You do not need to install `schema`, `recorder`, `trace`, `graph`, or `replay` separately unless you use their lower-level APIs directly.

Other public packages can be selected by capability:

| Capability | Package |
| --- | --- |
| Snapshot protocol and validation | `@agent-loop-snapshot/schema` |
| Run recording and persistence | `@agent-loop-snapshot/recorder` |
| Trace loading and indexing | `@agent-loop-snapshot/trace` |
| DAGs, call trees, and timelines | `@agent-loop-snapshot/graph` |
| Mock, Verified, and Semantic Replay | `@agent-loop-snapshot/replay` |
| OTLP JSON import/export | `@agent-loop-snapshot/otel-import`, `@agent-loop-snapshot/otel-export` |

To pin the current public version, append `@0.1.1` to a package name, for example `npm install @agent-loop-snapshot/cli@0.1.1`. Future releases follow Semantic Versioning and will document compatibility in the changelog.

### Develop from source

Repository development requires Node.js `24.20.x` and pnpm `11.19.x`. Install dependencies and run the offline checks from the repository root:

```powershell
pnpm install
pnpm run check
```

`pnpm run check` does not require an API key, Docker, or an external model service. It builds the project, runs unit tests, and runs the three offline examples.

The examples below use the installed CLI as `npx alsnap`. When developing in this source repository, you can use `pnpm alsnap -- <command>` instead. Always use new, non-existent output directories for snapshots so existing run records are not overwritten.

## 2. Try it first: run the offline examples

Build once, then choose an entry point:

```powershell
pnpm build
node examples/function-instrumentation/demo.mjs
node examples/sdk-instrumentation/demo.mjs
npx alsnap import-otel examples/otel-import/trace.json --output ./runs/otel-import --json
```

Run all examples together:

```powershell
pnpm run examples:check
```

The examples create snapshots in a temporary or configured `runs` directory. See the README in each example directory for prerequisites and output details.

## 3. Record your own functions, model, and tools

If your model and tools are Promise-based functions provided by your application, use `instrument()`. Every tool must declare a side-effect level; use `read_only` for read-only operations and a stricter level for tools that may write to an external system.

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

Call results and original business errors are preserved. In the default `strict` recording mode, a recording failure may prevent the business call or throw a recording error; this is appropriate when an auditable record is a prerequisite for execution.

`checkpoint()` stores only the complete state explicitly supplied by the caller. A native snapshot may support later recovery only when its last recording action is a checkpoint. Do not treat an ordinary model response as recoverable state.

## 4. Automatically record OpenAI or Anthropic SDK calls

When application code calls the OpenAI or Anthropic SDK directly, initialize the integration before loading application modules and wrap one application run with `telemetry.run()`:

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

The fixed support matrix currently covers OpenAI `7.15.0` Chat Completions and Responses, and Anthropic `0.125.0` Messages. Both support non-streaming `create()` calls and `stream: true` async iteration. A stream must be actually iterated by application code; the instrumentation does not read ahead.

SDK instrumentation is best-effort: capture failures produce diagnostics without replacing the SDK result or business error. It records only calls inside the `telemetry.run()` scope. SDKs loaded before initialization, SDKs statically inlined by a bundler, and Azure, Bedrock, or Vertex-specific clients are outside the current support scope.

## 5. Inspect, validate, and graph a snapshot

Assuming the snapshot is at `./runs/run-123`:

```powershell
# Validate the directory, events, and artifact references
npx alsnap validate ./runs/run-123

# Inspect a run summary without payloads
npx alsnap inspect ./runs/run-123

# Output a Mermaid causal graph
npx alsnap graph ./runs/run-123 --format mermaid

# Output a JSON timeline
npx alsnap graph ./runs/run-123 --kind timeline --format json
```

Add `--json` when a script needs to consume the result. Exit code `0` means success, `2` means the snapshot is invalid, no valid trace was imported, or an export was not fully accepted, and `1` means a command or runtime error.

## 6. Import an existing OTLP JSON trace

Import accepts only OTLP/HTTP JSON `ExportTraceServiceRequest` files containing `resourceSpans`. It does not accept protobuf, gRPC, console text, or vendor UI export files:

```powershell
npx alsnap import-otel trace-a.json trace-b.json --output ./imported-runs --json
npx alsnap inspect ./imported-runs/run_<generated-id> --json
```

Each input file is limited to 64 MiB. The result is an `otel-import` observation snapshot: it can be validated, inspected, and graphed, but cannot be replayed, resumed, or compiled into an executable Workflow. Import never sends data to an external system automatically.

## 7. Export to an OpenTelemetry Collector or external platform

Export sends workflow metadata by default. It does not send model inputs or outputs, tool arguments or results, checkpoints, artifact contents, exception bodies, or local paths. Create a configuration file such as `export.json`:

```json
{
  "targetAlias": "local-collector",
  "endpointEnv": "OTLP_TRACES_ENDPOINT",
  "headersEnv": {},
  "serviceName": "my-agent",
  "queueDir": "./runs/otlp-queue",
  "contentPolicy": "metadata-only",
  "batchSpanLimit": 512,
  "timeoutMs": 10000,
  "retryMaxAttempts": 3,
  "retryBudgetMs": 30000
}
```

Set the endpoint, run a dry-run first, and then send:

```powershell
$env:OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces'

# Show mapping and filtering results; no network, queue, or credentials are used
npx alsnap export-otel ./runs/run-123 --config ./export.json --dry-run --json

# Send; a temporary network failure leaves the local queue intact
npx alsnap export-otel ./runs/run-123 --config ./export.json --json

# Later, resume only queued batches with the same configuration fingerprint
npx alsnap export-otel --resume --config ./export.json --json
```

`endpoint` and `endpointEnv` are mutually exclusive. Production targets should use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`, and `::1`. Keep authentication values in environment variables and map HTTP header names to environment variable names with `headersEnv`, for example:

```json
"headersEnv": { "Authorization": "OTLP_AUTHORIZATION" }
```

Do not put tokens, API keys, or complete Authorization values in JSON, command lines, snapshots, or the Git repository.

See [OTLP export and platform integration](otel-export.md) for Langtrace and Grafana Cloud boundaries, Collector forwarding, and the compatibility matrix.

## 8. Do you need Docker?

Daily recording, inspection, OTLP JSON import, offline tests, and export to an existing endpoint do not require Docker.

Docker Desktop must be running only when you want to:

- Start the OpenTelemetry Collector supplied by the repository.
- Run the real Collector end-to-end verification:

```powershell
pnpm run collector:verify
```

This command pulls and runs the pinned image `otel/opentelemetry-collector-contrib:0.114.0`. If image download fails because of Docker Hub networking, proxy, or TLS issues, check that the Docker Desktop daemon is running and review its network or proxy configuration. This is separate from a TypeScript build failure.

## 9. Troubleshooting

### `pnpm run collector:verify` fails

First confirm that Docker is available:

```powershell
docker version
docker pull otel/opentelemetry-collector-contrib:0.114.0
```

If pull reports `EOF`, a timeout, or an inability to reach `registry-1.docker.io`, fix Docker Desktop's network, proxy, or registry mirror settings and retry. Then run `pnpm run collector:verify` again.

### Export returns a non-zero exit code

Run a dry-run first to inspect the endpoint, configuration, and redacted mapping:

```powershell
npx alsnap export-otel ./runs/run-123 --config ./export.json --dry-run --json
```

Then check that the environment variables are set, the Collector is listening on `/v1/traces`, and use `--resume` for queued batches. An export failure does not rerun the original Agent business logic.

### Why can't the snapshot be replayed or resumed?

SDK instrumentation and OTLP import usually capture observations only, or do not contain a verifiable final state. The safety gate therefore marks them as non-executable. Use `inspect` to view the snapshot source, completeness, and restriction reason. For recovery, write an explicit recoverable checkpoint during a generic function-instrumented run and obtain the permissions required by the current environment again.

## 10. Pre-release checks

After making changes, run these checks in order:

```powershell
pnpm run check
pnpm run collector:verify  # Optional; requires Docker
pnpm run release:verify
```

`release:verify` runs the normal quality gate, package checks, and a tarball consumer verification. It does not replace the Collector verification, which requires Docker.
