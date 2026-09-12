# OTLP/HTTP 导出与平台接入

`@agent-loop-snapshot/otel-export` 发送的是经过二次脱敏的 OTLP/HTTP JSON trace。它不会上传 checkpoint、artifact 内容、artifact preview 或本地路径。默认 `metadata-only` 不发送模型/工具 payload、状态值、异常消息和自由文本属性；只有 `redacted-content` 才会发送经过出站脱敏和限额处理的内容。

发送目标必须由调用方给出完整 `endpoint`，或给出仅在发送时解析的 `endpointEnv`。两者不能同时出现。认证 header 也只能以“header 名 → 环境变量名”的 `headersEnv` 映射提供，不能把值放进配置、命令行或快照。HTTPS 是默认要求；仅 `localhost`、`127.0.0.1`、`::1` 的本地测试 endpoint 可以使用 HTTP。

## 本地 OpenTelemetry Collector

仓库固定使用 `otel/opentelemetry-collector-contrib:0.114.0` 做端到端验证。配置在 [`examples/otel-export/collector-config.yaml`](../examples/otel-export/collector-config.yaml)：它接收 OTLP/HTTP 的 `/v1/traces`，并用 file exporter 将收到的 trace 写到容器内 `/output/traces.json`。

```sh
docker run --rm -p 4318:4318 \
  -v "$PWD/examples/otel-export/collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v "$PWD/runs/collector-output:/output" \
  otel/opentelemetry-collector-contrib:0.114.0 \
  --config=/etc/otelcol-contrib/config.yaml

pnpm alsnap -- export-otel ./runs/run-123 \
  --config examples/otel-export/export.json --json
```

`pnpm run collector:verify` 在 Docker 可用时会执行真正的端到端检查：先在 Collector 未运行时用 CLI 入队，再启动 Collector 执行 `--resume`，然后验证 `initInstrumentation()` 的运行结束自动发送也被 file exporter 接收。它不访问任何生产平台或用户凭据。Docker 不可用时该命令会失败并明确说明原因；普通 `pnpm run check` 保持离线。

## Langtrace

Langtrace Cloud 的 OTLP JSON trace 接收地址是 `https://app.langtrace.ai/api/trace`；自建部署则使用 `https://<self-host>/api/trace`。认证使用项目级 `x-api-key` header。该 API 接收 JSON OTLP，因此本项目可直接发送；也可经 Collector 转发，以便统一管理凭据、批处理或 fan-out。

```json
{
  "targetAlias": "langtrace",
  "endpoint": "https://app.langtrace.ai/api/trace",
  "serviceName": "my-agent",
  "queueDir": "./runs/langtrace-queue",
  "headersEnv": { "x-api-key": "LANGTRACE_API_KEY" },
  "contentPolicy": "metadata-only"
}
```

若经 Collector，在其 `otlphttp` exporter 中设置 `traces_endpoint: https://app.langtrace.ai/api/trace` 与 `x-api-key: ${env:LANGTRACE_API_KEY}`；不要把 API key 放进任何 JSON。参见 Langtrace 的 [Collector 配置](https://docs.langtrace.ai/supported-integrations/otel-support/otel-configuration) 与 [Trace API](https://docs.langtrace.ai/api-reference/traces/POST-trace)。

## Grafana Cloud

Grafana Cloud 的 OTLP gateway URL 和 OTLP instance ID 必须从该 stack 的 OpenTelemetry 配置卡获取；它使用 `Authorization: Basic <base64(instance-id:access-policy-token)>`。Grafana Cloud 支持 OTLP/HTTP binary protobuf（可选 gzip），也支持 JSON protobuf 编码，但官方建议 JSON 仅用于低流量测试。因此本项目的 JSON exporter 可在低流量测试时直接指向该 stack 的完整 trace endpoint；生产场景仍建议经本地 Collector/Alloy，以获得协议选择、集中凭据管理、批处理与重试能力。

Collector 的接收端仍可用本项目的 `http://127.0.0.1:4318/v1/traces`。配置 Collector 的远端 `otlphttp` exporter 时，以环境变量保存 Grafana endpoint、instance ID 和 token；不将已编码的 Basic header 写入仓库。参见 Grafana 的 [OTLP 接入说明](https://grafana.com/docs/opentelemetry/ingest/) 和 [Agent Observability 配置指南](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/get-started/grafana-cloud/)。

## 兼容矩阵

| 目标                          | 传输路径                                                                                      | 鉴权                                     | 验证等级         | 备注                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| 固定版本 Collector `0.114.0`  | 本项目 JSON → `otlp` receiver → file exporter                                                 | 无（仅本机）                             | 本地端到端已验证 | `collector:verify` 已覆盖 CLI 重发与 SDK 自动发送。                |
| Langtrace Cloud / self-hosted | 本项目 JSON → `/api/trace`，或经 Collector                                                    | `x-api-key`                              | 依据官方文档     | 未使用用户凭据做云端实测。                                         |
| Grafana Cloud                 | 低流量测试：本项目 JSON → Cloud OTLP gateway；生产建议：本项目 JSON → Collector/Alloy → Cloud | Basic，instance ID + access-policy token | 依据官方文档     | Grafana 声明支持 JSON protobuf，但本项目未用用户凭据进行云端实测。 |

“本地端到端”只证明本项目和指定 Collector 版本能传递有效 OTLP，不代表所有厂商 UI 已接收或索引。
