# Agent Loop Snapshot

[English](README.md) · [用户使用手册](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/user-guide.zh-CN.md) · [npm packages](https://www.npmjs.com/search?q=%40agent-loop-snapshot)

Agent Loop Snapshot 是一个面向 Agent Runtime 的开源运行记录、检查、可视化与回放工具。它将一次 Agent Loop 中的模型调用、工具调用、状态变化、检查点和产物保存为可移植快照，帮助你审计运行过程、调试控制流，并在明确的权限和验证规则下复现任务。

项目已在 [GitHub](https://github.com/SinglePoi/agent-loop-snapshot) 开源，核心包已发布到 npm。当前公开版本为 `0.1.2`。

> 当前协议版本为 Snapshot Schema `0.2.0`。OTLP 导入快照始终是 observation-only；OTLP 导出没有默认云端目的地，必须由用户显式配置。

## 特性

- 以追加式 JSONL 事件记录 Agent 运行，并通过 `parent_ids` 保留并行、重试和汇合的因果关系。
- 保存显式 checkpoint 和基于 SHA-256 内容寻址的 artifact，支持完整性校验与状态重建。
- 将 Trace 投影为因果 DAG、调用树或线性时间线，并导出 Mermaid 或 JSON。
- 提供 Mock、Verified 和 Semantic 三种回放模式，以及从 Trace 编译 Workflow IR 的能力。
- 通过 JSON Pointer、数组通配符、正则和自定义规则在持久化前脱敏。
- 为自定义模型/工具函数提供框架无关的 TypeScript instrumentation。
- 自动采集 OpenAI 和 Anthropic SDK 调用，支持非流式调用和 `stream: true` 异步迭代。
- 导入 OTLP/HTTP JSON trace，或通过本地持久化队列将快照导出为 OTLP/HTTP。
- 所有执行和副作用都经过显式安全门禁；历史授权不会自动成为新运行的授权。

项目不会尝试保证模型输出逐 token 一致，也不会记录或依赖模型的隐藏思维链。快照只保存可审计的输入、输出、工具结果、状态变化和简短决策摘要。

## 安装

需要 Node.js `24.20.x`。只使用 CLI 时不需要 pnpm。

```bash
# 校验、查看、绘图、回放以及 OTLP 导入/导出
npm install --save-dev @agent-loop-snapshot/cli

# 记录自定义模型和工具函数
npm install @agent-loop-snapshot/instrumentation

# 自动采集 OpenAI 或 Anthropic SDK
npm install @agent-loop-snapshot/instrumentation-openai
npm install @agent-loop-snapshot/instrumentation-anthropic
```

CLI 命令名为 `alsnap`：

```bash
npx alsnap --help
npx alsnap validate ./runs/run-123
npx alsnap inspect ./runs/run-123 --json
```

也可以按需安装底层包：

| 能力 | npm 包 |
| --- | --- |
| 快照与 Workflow Schema、兼容性检查和迁移 | [`@agent-loop-snapshot/schema`](https://www.npmjs.com/package/@agent-loop-snapshot/schema) |
| 运行记录、checkpoint、artifact 和脱敏 | [`@agent-loop-snapshot/recorder`](https://www.npmjs.com/package/@agent-loop-snapshot/recorder) |
| Trace 加载、查询和状态重建 | [`@agent-loop-snapshot/trace`](https://www.npmjs.com/package/@agent-loop-snapshot/trace) |
| DAG、调用树和时间线投影 | [`@agent-loop-snapshot/graph`](https://www.npmjs.com/package/@agent-loop-snapshot/graph) |
| Mock、Verified、Semantic Replay 和 Workflow 编译 | [`@agent-loop-snapshot/replay`](https://www.npmjs.com/package/@agent-loop-snapshot/replay) |
| OTLP/HTTP JSON 导入 | [`@agent-loop-snapshot/otel-import`](https://www.npmjs.com/package/@agent-loop-snapshot/otel-import) |
| OTLP/HTTP 导出 | [`@agent-loop-snapshot/otel-export`](https://www.npmjs.com/package/@agent-loop-snapshot/otel-export) |

## 快速开始

### 运行离线示例

仓库提供的示例不需要 API key、Docker 或真实模型请求：

```bash
pnpm install
pnpm build

# 通用函数包装
node examples/function-instrumentation/demo.mjs

# OpenAI SDK 自动采集（本地 HTTP fixture，不会访问外网）
node examples/sdk-instrumentation/demo.mjs

# 导入 OTLP/HTTP JSON
pnpm alsnap -- import-otel examples/otel-import/trace.json \
  --output ./runs/otel-import --json
```

一次运行全部离线闭环：

```bash
pnpm run examples:check
```

### 记录自定义 Agent

当模型和工具都是你自己的 Promise 函数时，使用 `instrument()`：

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

工具必须显式声明副作用等级。`checkpoint()` 只保存调用方明确传入的状态；普通模型返回值、工具结果和决策摘要属于观察状态，不会自动变成可恢复状态。

### 自动采集 SDK 调用

自动集成必须在业务模块加载前初始化，并使用 `telemetry.run()` 包住一次运行：

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

当前支持矩阵：

- OpenAI `7.15.0`：Chat Completions 和 Responses 的 `create()`。
- Anthropic `0.125.0`：Messages 的 `create()`。
- 两者均支持非流式调用和 `stream: true` 异步迭代；流只有在业务代码实际迭代时才会被观测。

SDK 自动采集采用 best-effort：采集故障会产生诊断，但不会替换 SDK 的结果或业务错误。SDK 必须在初始化之后加载；SDK `.stream()` helper、Azure/Bedrock/Vertex 专用客户端以及不在固定版本范围内的 SDK 当前不受支持。

## CLI

假设快照位于 `./runs/run-123`：

```bash
# 校验快照、事件和 artifact 引用
npx alsnap validate ./runs/run-123

# 查看不包含 payload 的运行摘要
npx alsnap inspect ./runs/run-123

# 输出 Mermaid 因果图或 JSON 时间线
npx alsnap graph ./runs/run-123 --format mermaid
npx alsnap graph ./runs/run-123 --kind timeline --format json

# Mock Replay 会写入一个新的快照目录
npx alsnap replay ./runs/run-123 \
  --mode mock --output ./runs/run-123-mock-replay
```

所有命令支持 `--json` 机器可读输出。退出码为 `0`（成功）、`2`（快照校验失败、没有有效导入 trace，或导出未完整接受）和 `1`（参数或运行错误）。

## OTLP 导入与导出

### 导入

`alsnap import-otel` 仅接受 OTLP/HTTP JSON `ExportTraceServiceRequest`（包含 `resourceSpans`），不接受 protobuf、gRPC、控制台文本或厂商 UI 导出文件：

```bash
npx alsnap import-otel trace-a.json trace-b.json \
  --output ./imported-runs --json
```

单个输入文件上限为 64 MiB。导入结果是 observation-only 快照，可以 `validate`、`inspect` 和 `graph`，但不能 replay、resume 或编译为可执行 Workflow。导入不会自动向外部发送数据。

### 导出

`@agent-loop-snapshot/otel-export` 将快照映射为 OTLP/HTTP，并通过本地持久化队列发送。默认 `metadata-only`，不会发送模型输入/输出、工具参数/结果、状态值、异常正文或任意自由文本。endpoint 必须显式配置，生产环境应使用 HTTPS：

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
# 检查映射、过滤和数据损失；不会联网、入队或读取凭据
npx alsnap export-otel ./runs/run-123 \
  --config ./export.json --dry-run --json

# 发送并在重启后续传同一配置指纹的队列
npx alsnap export-otel ./runs/run-123 --config ./export.json --json
npx alsnap export-otel --resume --config ./export.json --json
```

认证信息只能通过环境变量提供，不要把 token 或 API key 写进配置文件、快照或 Git 仓库。完整配置和平台兼容矩阵见 [OTLP/HTTP 导出与平台接入](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/otel-export.md)。

## 快照模型

```text
run-snapshot/
├── manifest.json
├── events.jsonl
├── checkpoints/
│   └── 000001.json
└── artifacts/
    └── sha256-<digest>
```

- `Trace`：运行产生的追加式事件记录。
- `Checkpoint`：调用方显式写入的可恢复状态。
- `Artifact`：以 SHA-256 内容寻址的文件、图片或大型工具输出。
- `Graph Projection`：由事件因果关系生成的 DAG、调用树或时间线。
- `Workflow IR`：从 Trace 提炼出的可参数化执行流程。
- `Replay`：使用记录结果、重新调用工具，或交给另一个 Agent 语义复现。

`events.jsonl` 是事实记录，Workflow 文件是经过审核后提炼出的执行流程。历史运行中的失败尝试、环境偶然性、审批记录和决策文本不会被自动复制到 Workflow 中。

## 回放与安全

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| Mock Replay | 使用快照中保存的模型和工具结果，不重新产生副作用 | 调试控制流、复现 UI |
| Verified Replay | 重新执行调用，并与快照或断言比较 | 回归和兼容性测试 |
| Semantic Replay | 由另一个 Agent 根据目标、约束和成功条件重新完成任务 | 跨模型、跨框架复用 |

副作用默认禁止。Verified 和 Semantic Replay 必须由调用方提供当前的 adapter、权限和验证器；快照中的历史授权不会自动授权新运行。导入的 OTLP 快照和缺少可验证最终状态的观察快照不可执行。

## 开发

仓库是使用 pnpm 的 TypeScript monorepo，需要 Node.js `24.20.x` 和 pnpm `11.19.x`：

```bash
pnpm install
pnpm run check
```

常用命令：

```bash
pnpm build              # 构建所有 workspace packages
pnpm run examples:check # 运行离线示例
pnpm run benchmark:als-502
pnpm run release:verify # 质量门禁、打包和临时消费者 smoke test
```

CI 使用 `pnpm run check`。真实 OpenTelemetry Collector 端到端验证需要 Docker，可运行 `pnpm run collector:verify`。

## 文档

- [用户使用手册](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/user-guide.md)
- [Workflow IR v0.1](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/workflow-ir-v0.1.md)
- [Schema 兼容性与迁移](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/schema-compatibility.md)
- [OTLP/HTTP 导出与平台接入](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/otel-export.md)
- [安全与发布指南](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/security-and-release.md)
- [实施规划](https://github.com/SinglePoi/agent-loop-snapshot/blob/dev/docs/implementation-plan.md)
- [变更日志](CHANGELOG.md)
- [架构决策记录](https://github.com/SinglePoi/agent-loop-snapshot/tree/dev/docs/adr)

## 许可证

本项目采用 [MIT License](LICENSE)。

## 参与开发

欢迎通过 [GitHub Issues](https://github.com/SinglePoi/agent-loop-snapshot/issues) 报告问题、提出建议或提交 Pull Request。协议或安全语义发生变化时，请同时更新 schema、迁移测试和相关文档。
