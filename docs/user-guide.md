# Agent Loop Snapshot 用户使用手册

本手册面向希望记录、查看、导入或导出 Agent 运行过程的使用者。它同时覆盖 npm 安装与源码开发：你可以只安装 CLI，也可以按需要安装 SDK 包。

## 1. 准备环境

需要 Node.js `24.20.x` 或兼容的 Node.js 24 版本。若只使用 CLI，不需要 pnpm。

### 安装 CLI

在自己的项目中安装：

```powershell
npm install --save-dev @agent-loop-snapshot/cli
```

随后用 `npx alsnap <命令>` 执行，例如：

```powershell
npx alsnap validate ./runs/run-123
npx alsnap inspect ./runs/run-123 --json
```

### 安装 SDK

按实际使用场景安装所需包：

```powershell
# 为自定义模型和工具函数记录运行过程
npm install @agent-loop-snapshot/instrumentation

# 为既有 OpenAI / Anthropic SDK 调用自动采集
npm install @agent-loop-snapshot/instrumentation-openai @agent-loop-snapshot/instrumentation-anthropic
```

`@agent-loop-snapshot/instrumentation` 会自动安装它所需的核心依赖。除非直接使用底层 API，否则不需要单独安装 `schema`、`recorder`、`trace`、`graph` 或 `replay`。

### 从源码开发

仓库开发需要 Node.js `24.20.x` 与 pnpm `11.19.x`。在仓库根目录安装依赖并完成离线检查：

```powershell
pnpm install
pnpm run check
```

`pnpm run check` 不需要 API key、Docker 或外网模型服务。它会构建项目、运行单元测试和三个离线示例。

以下命令示例均使用已安装 CLI 的 `npx alsnap`。在本仓库源码目录开发时，可等价改为 `pnpm alsnap -- <命令>`。所有快照目录均应使用新的、尚不存在的输出目录，避免覆盖已有运行记录。

## 2. 先体验：运行离线示例

先构建一次，再选择一个入口执行：

```powershell
pnpm build
node examples/function-instrumentation/demo.mjs
node examples/sdk-instrumentation/demo.mjs
npx alsnap import-otel examples/otel-import/trace.json --output ./runs/otel-import --json
```

也可以一次运行全部示例：

```powershell
pnpm run examples:check
```

示例会在临时或指定的 `runs` 目录生成快照。对应的前置条件和输出说明参见各示例目录的 README。

## 3. 记录自己的函数、模型和工具

如果模型调用与工具调用都是你自己提供的 Promise 函数，使用 `instrument()`。每个工具必须声明副作用等级；`read_only` 表示只读，可能写入外部系统的工具应使用更严格的等级。

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
  { input: { goal: '查资料并总结' } },
  async ({ model, tools, checkpoint }) => {
    const query = await model.call('生成检索词');
    const documents = await tools.search(query);
    await checkpoint({ query, documents });
    return model.call(JSON.stringify(documents));
  },
);
```

调用结果和原始业务错误会保持原样。默认的 `strict` 记录模式下，如果记录本身发生故障，业务调用可能被阻止或抛出记录错误；这适用于你需要把可审计记录作为前提的场景。

`checkpoint()` 只保存你明确传入的全量状态。只有最后记录动作是 checkpoint 的原生快照，才可能具备后续恢复所需的状态 hash；不要把普通模型返回值当作可恢复状态。

## 4. 自动记录 OpenAI 或 Anthropic SDK

如果业务代码已直接调用 OpenAI 或 Anthropic SDK，在加载业务模块之前初始化自动集成，再用 `telemetry.run()` 包住一次业务运行：

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
  await telemetry.run({ input: { goal: '完成任务' } }, () => main());
} finally {
  await telemetry.shutdown();
}
```

当前固定支持 OpenAI `7.15.0` 的 Chat Completions / Responses，以及 Anthropic `0.125.0` 的 Messages；支持其 `create()` 非流式调用与 `stream: true` 异步迭代。流必须由业务代码实际迭代，采集器不会预读。

自动采集默认为 `best-effort`：采集失败会产生诊断，但不会替换 SDK 的结果或业务错误。它只记录 `telemetry.run()` 作用域内的调用；已在初始化前加载的 SDK、打包器静态内联的 SDK 及 Azure、Bedrock、Vertex 专用客户端不在当前支持范围内。

## 5. 查看、校验和绘图

假设快照位于 `./runs/run-123`，可使用以下命令：

```powershell
# 校验目录、事件与 artifact 引用
npx alsnap validate ./runs/run-123

# 查看不包含 payload 的运行摘要
npx alsnap inspect ./runs/run-123

# 输出 Mermaid 因果图
npx alsnap graph ./runs/run-123 --format mermaid

# 输出 JSON 时间线
npx alsnap graph ./runs/run-123 --kind timeline --format json
```

需要让脚本读取结果时，加上 `--json`。退出码 `0` 表示成功，`2` 表示快照无效、没有有效导入 trace，或导出未被完全接受，`1` 表示命令参数或运行错误。

## 6. 导入已有 OTLP JSON Trace

导入仅接受 OTLP/HTTP JSON 的 `ExportTraceServiceRequest`（包含 `resourceSpans`），不接受 protobuf、gRPC、控制台文本或厂商 UI 导出文件：

```powershell
npx alsnap import-otel trace-a.json trace-b.json --output ./imported-runs --json
npx alsnap inspect ./imported-runs/run_<generated-id> --json
```

每个输入文件最多 64 MiB。导入结果是 `otel-import` 观察快照：可以 `validate`、`inspect` 和 `graph`，但不能 replay、resume 或编译为可执行 Workflow。导入也不会自动向外部发送数据。

## 7. 导出到 OpenTelemetry Collector 或外部平台

导出默认只发送流程元数据，不发送模型输入输出、工具参数结果、checkpoint、artifact 内容、异常正文或本地路径。先创建配置文件，例如 `export.json`：

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

设置 endpoint 后，先 dry-run，再实际发送：

```powershell
$env:OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces'

# 显示映射和过滤结果；不会联网、入队或读取凭据
npx alsnap export-otel ./runs/run-123 --config ./export.json --dry-run --json

# 发送；网络短暂不可用时会保留本地队列
npx alsnap export-otel ./runs/run-123 --config ./export.json --json

# 稍后仅续传相同配置指纹的本地队列
npx alsnap export-otel --resume --config ./export.json --json
```

`endpoint` 与 `endpointEnv` 必须二选一。生产目标应使用 HTTPS；仅 `localhost`、`127.0.0.1` 与 `::1` 可使用 HTTP。认证信息只放在环境变量中，并通过 `headersEnv` 写入“HTTP header 名 → 环境变量名”的映射，例如：

```json
"headersEnv": { "Authorization": "OTLP_AUTHORIZATION" }
```

不要把 token、API key、完整 Authorization 值写进 JSON、命令行、快照或 Git 仓库。

Langtrace 与 Grafana Cloud 的配置边界、Collector 转发方式及兼容矩阵见 [OTLP/HTTP 导出与平台接入](otel-export.md)。

## 8. 是否需要 Docker？

日常记录、查看、OTLP JSON 导入、离线测试和导出到已有 endpoint 都不需要 Docker。

只有以下两种情况需要 Docker Desktop 已启动：

- 想在本机启动仓库提供的 OpenTelemetry Collector；
- 想执行真实 Collector 端到端验收：

```powershell
pnpm run collector:verify
```

该命令会拉取并运行固定镜像 `otel/opentelemetry-collector-contrib:0.114.0`。若镜像下载报 Docker Hub 网络、代理或 TLS 错误，先确认 Docker Desktop 的 daemon 正在运行，并检查其网络/代理配置；这不是 TypeScript 代码构建失败。

## 9. 常见问题

### `pnpm run collector:verify` 失败

先确认 Docker 可用：

```powershell
docker version
docker pull otel/opentelemetry-collector-contrib:0.114.0
```

如果 pull 出现 `EOF`、超时或无法访问 `registry-1.docker.io`，处理 Docker Desktop 的网络、代理或镜像加速设置后重试。镜像成功拉取后再执行 `pnpm run collector:verify`。

### 导出返回非零退出码

先运行 dry-run，检查 endpoint、配置与脱敏后的映射：

```powershell
pnpm alsnap -- export-otel ./runs/run-123 --config ./export.json --dry-run --json
```

随后检查环境变量是否已设置、Collector 是否监听 `/v1/traces`，并使用 `--resume` 续传已入队批次。导出失败不会重跑原始 Agent 业务。

### 为什么快照不能 replay 或 resume？

SDK 自动采集与 OTLP 导入通常只保存观察信息，或没有可验证的最终状态，因此会被安全门禁标记为不可执行。使用 `inspect` 查看快照的来源、完整度和限制原因；需要恢复执行时，应在通用函数包装运行中明确写入可恢复的 checkpoint，并重新获得当前环境所需的权限。

## 10. 发布前自检

修改项目后，可按以下顺序检查：

```powershell
pnpm run check
pnpm run collector:verify  # 可选；需要 Docker
pnpm run release:verify
```

`release:verify` 会执行常规质量门禁、各包打包检查和 tarball 消费者验证；它不替代需要 Docker 的 Collector 验证。
