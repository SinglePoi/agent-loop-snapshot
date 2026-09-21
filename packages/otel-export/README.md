# @agent-loop-snapshot/otel-export

Map snapshots to OTLP JSON and deliver metadata spans through a durable local queue to an OpenTelemetry Collector or HTTPS endpoint.

```bash
npm install @agent-loop-snapshot/otel-export
```

Configure an explicit endpoint, content policy, retry budget, and queue directory; credentials are resolved only from environment variables.

See [OTLP export and platform integration](https://github.com/SinglePoi/agent-loop-snapshot/blob/development-docs/docs/otel-export.md).
