# OTLP JSON 导入（离线）

`trace.json` 是 OTLP/HTTP JSON `ExportTraceServiceRequest` 的最小示例。它不含真实遥测或凭据；导入时仍会测试 `api_key` 属性的落盘前脱敏。

```sh
pnpm build
pnpm alsnap -- import-otel examples/otel-import/trace.json --output ./runs/otel-import --json
pnpm alsnap -- inspect ./runs/otel-import/run_<generated-id> --json
pnpm alsnap -- graph ./runs/otel-import/run_<generated-id> --kind timeline --format json
```

每个 source trace 都会生成一个 observation-only 快照。它可以验证、查看和画图，但 `replay`、`resume` 和 Workflow 编译会拒绝执行。
