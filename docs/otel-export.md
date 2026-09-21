# OTLP/HTTP 导出与平台接入

`@agent-loop-snapshot/otel-export` 发送的是经过二次脱敏的 OTLP/HTTP JSON trace。它不会上传 checkpoint、artifact 内容、artifact preview 或本地路径。默认 `metadata-only` 不发送模型/工具 payload、状态值、异常消息和自由文本属性；只有 `redacted-content` 才会发送经过出站脱敏和限额处理的内容。

发送目标必须由调用方给出完整 `endpoint`，或给出仅在发送时解析的 `endpointEnv`。两者不能同时出现。认证 header 也只能以“header 名 → 环境变量名”的 `headersEnv` 映射提供，不能把值放进配置、命令行或快照。HTTPS 是默认要求；仅 `localhost`、`127.0.0.1`、`::1` 的本地测试 endpoint 可以使用 HTTP。

## 可靠快照导出

`createOtlpExporter(config)` 在 `queueDir` 内维护队列和独立的 `delivery-records` 意图日志。`exportSnapshot(snapshot)` 先写入意图，再按 `batchSpanLimit` 与 `batchMaxBytes`（编码后的 OTLP JSON 字节数）进行稳定拆批并入队；返回的是包含每个 batch、pending 数量与诊断的 `otel-export-2.0` 报告。`pending` 只表示本地已登记，不能当作接收端已接受。

`resume()` 仅恢复这个 `queueDir` 下、目标和策略摘要仍匹配的意图；它不会扫描其他目录或自动补发历史导入快照。单个 span 超过 `batchMaxBytes` 时会被诊断为未发送而不会无限重试。重复提交相同快照只在本地按稳定 batch ID 去重，不保证远端 exactly-once。`shutdown({ deadlineMs })` 停止接收新快照并有限期收尾；调用后仍可 `flush()`，但不能再创建新的发送循环。已接受或 unknown-delivery 的记录不会自动补传；其档案过期后，人工重新导出可能重复。

SDK 的 `instrument()` 与 `initInstrumentation()` 都接受 `exporters`。run 在本地快照提交后、返回业务结果前只等待交付意图的可靠登记，不等待网络接受；登记失败只产生 `EXPORT_FAILED` 诊断，不改变业务结果或原始异常。默认 `exporterOwnership: 'owned'` 会在 controller/agent shutdown 时收尾 exporter；复用给多个 controller 时设为 `'shared'`，由调用方统一关闭。`maxConcurrentExports`（默认 2）和 `maxPendingExports`（默认 32）限制登记压力，超限时源快照仍保留并报告诊断。

```ts
const exporter = createOtlpExporter(config);
const agent = instrument({
  snapshotDir: './runs',
  runtime: { name: 'my-agent', version: '1.0.0' },
  model,
  tools,
  exporters: [exporter],
  exporterOwnership: 'owned',
});
```

命令行只处理显式路径或配置队列：`alsnap export-otel <snapshot> --config export.json --dry-run --json` 不写队列；省略 `--dry-run` 会登记并发送；`alsnap export-otel --resume --config export.json --json` 只恢复该配置 `queueDir` 下的意图。退出码 `0` 表示有效 span 均已确认接受（可带 warning）或有效 dry-run，`1` 表示配置、交付或 no-data 未完成，`2` 表示源快照无效。

## 本地 OpenTelemetry Collector

仓库固定使用 Linux amd64 的 `otel/opentelemetry-collector-contrib:0.114.0@sha256:43168fa5acb6989f40e8a2493275e30a62df8ee3f3dde1ba15c906cb8c9f3fb9` 做端到端验证。配置在 [`examples/otel-export/collector-config.yaml`](../examples/otel-export/collector-config.yaml)：它只接收 OTLP/HTTP 的 `/v1/traces`，并用可检查的 file exporter 将解码后的 trace 写到容器内 `/output/traces.json`。

```sh
docker run --rm -p 4318:4318 \
  -v "$PWD/examples/otel-export/collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  -v "$PWD/runs/collector-output:/output" \
  otel/opentelemetry-collector-contrib:0.114.0@sha256:43168fa5acb6989f40e8a2493275e30a62df8ee3f3dde1ba15c906cb8c9f3fb9 \
  --config=/etc/otelcol-contrib/config.yaml

pnpm alsnap -- export-otel ./runs/run-123 \
  --config examples/otel-export/export.json --json
```

`pnpm run collector:verify` 在 Docker 可用时会执行真正的端到端检查：使用脱敏的 `example-run`、`tool-failure-retry` 和 `parallel-calls` fixture，外加脚本生成的无敏感内容模型失败 run；先制造本地队列容量故障，再恢复配置并执行 `--resume`，随后验证 `initInstrumentation()` 的运行结束自动发送。脚本读取并解码 Collector file exporter 的 JSON，逐个比对 span ID、名称、状态、时间戳和 links，并断言 tool retry 与 model failure 的 ERROR、并行/多父 links、来源与完整度属性都被接收；HTTP 200 本身不算通过。它不访问任何生产平台或用户凭据。Docker 不可用时该命令会失败并明确说明原因；普通 `pnpm run check` 保持离线。多进程队列、映射和本地网络故障仍由包测试分层覆盖。

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

## Langfuse

Langfuse 的官方 Observability 文档提供基于 OpenTelemetry 的接入说明。使用前应以当前文档确认项目区域对应的 OTLP endpoint、认证 header 和 ingestion version；这些值必须从环境变量注入 Collector 或调用方配置，不能写进快照或仓库。这里完成的是**官方文档核对**，未使用凭据进行本地接收或 Langfuse UI 实测。参见 [Langfuse Observability 接入](https://langfuse.com/docs/observability/get-started)。

## Arize Phoenix

Phoenix 官方文档说明其使用 OpenTelemetry/OpenInference 追踪。可将本项目的 OTLP/HTTP JSON 先发送到已配置的 Collector，再由该 Collector 按 Phoenix 当前接入文档转发；直接端点、认证和 UI 索引行为均应以部署版本文档为准。这里完成的是**官方文档核对**，未启动 Phoenix 服务也未做平台界面实测。参见 [Phoenix 文档](https://arize.com/docs/phoenix/)。

## 兼容矩阵

| 目标                          | 传输路径                                                                                      | 鉴权                                     | 验证等级         | 备注                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| 固定版本 Collector `0.114.0@sha256:43168…f3fb9` | 本项目 JSON → `otlp` receiver → file exporter                                                 | 无（仅本机）                             | 本地接收验证（需 Docker） | `collector:verify` 解码文件输出，覆盖恢复、重试、并行/links 与 SDK。 |
| Langtrace Cloud / self-hosted | 本项目 JSON → `/api/trace`，或经 Collector                                                    | `x-api-key`                              | 官方文档核对     | 未使用用户凭据进行本地接收或云端 UI 实测。                          |
| Grafana Cloud                 | 低流量测试：本项目 JSON → Cloud OTLP gateway；生产建议：本项目 JSON → Collector/Alloy → Cloud | Basic，instance ID + access-policy token | 官方文档核对     | 未使用用户凭据进行本地接收或云端 UI 实测。                          |
| Langfuse                       | 本项目 JSON → Collector → Langfuse 当前 OTLP 接入                                             | 依官方接入配置                           | 官方文档核对     | endpoint/header 需按区域和版本复核；未做本地接收或 UI 实测。        |
| Arize Phoenix                  | 本项目 JSON → Collector → Phoenix 当前 OTLP/OpenInference 接入                               | 依部署配置                               | 官方文档核对     | 未启动 Phoenix；未做本地接收或 UI 实测。                            |

“本地接收验证”只证明本项目和指定 Collector 版本能传递有效 OTLP，不代表任何厂商 UI 已接收、索引或展示。
