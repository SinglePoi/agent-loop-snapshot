# Agent Loop Snapshot 交接记录

更新时间：2026-09-06

## 当前进度

已完成：

- ALS-001：完成运行时、存储边界和事件顺序相关 ADR。
- ALS-002：初始化 TypeScript workspace、六个核心包、CI、lint、格式和测试门禁。
- ALS-003：定义 Snapshot Schema v0.1 JSON Schema 和协议类型。
- ALS-004：实现 Ajv 2020 校验器、目录校验、固定夹具和完整性诊断。
- ALS-101：实现 Recorder 生命周期 API、事件上下文、并发串行提交和拦截器。
- ALS-102：实现耐崩溃 JSONL Writer、flush 策略、临时 manifest、原子提交和恢复诊断。
- ALS-103：实现基于 SHA-256 的 Artifact Store。
- ALS-104：实现 Checkpoint Store、可恢复状态边界和状态重建。
- ALS-105：实现持久化前脱敏流水线。
- ALS-106：接入首个框架无关 Example Runtime，支持环境变量模型配置、并行只读工具、失败重试和示例快照验收。
- ALS-201：实现 Trace Loader、查询索引、artifact metadata 加载和结构完整性诊断。
- ALS-202：实现因果 DAG、调用树、时间线投影、过滤和连续噪声折叠。
- ALS-203：实现 `validate`、`inspect` 和 `graph` CLI、稳定退出码、JSON 输出和 Mermaid 导出。
- ALS-301：实现框架无关的 Replay Adapter 协议、稳定 correlation key、live/recorded adapter 切换与记录结果适配器。
- ALS-302：实现副作用 Policy Engine、当前授权检查、执行守卫与 Replay Trace 审计事件。
- ALS-303：实现基于 recorded-result adapter 的 Mock Replay Runner、新 Replay Trace 与结构化调用差异。
- ALS-304：实现 checkpoint resume、经策略守卫的 live adapter 验证回放，以及声明式差异比较。

## ALS-103 已实现内容

实现文件：

- `packages/recorder/src/artifacts.ts`
- `packages/recorder/src/artifacts.test.ts`

`ArtifactStore` 提供：

- 字符串、`Uint8Array`、`ArrayBuffer` 写入；
- `artifacts/sha256-<digest>` 内容寻址布局；
- 同内容并发去重；
- 临时文件写入、刷盘和原子重命名；
- `verify()`、`get()` 和 `verifyReferences()`；
- 缺失 artifact、字节数不匹配、SHA-256 不匹配和非法引用诊断；
- 未知 `media_type` 作为元数据保留，不进行解码。

`packages/recorder/src/index.ts` 已导出 Artifact Store API，根目录测试脚本已包含 `artifacts.test.js`。

## ALS-104 已实现内容

实现文件：

- `packages/recorder/src/checkpoints.ts`
- `packages/recorder/src/checkpoints.test.ts`

`CheckpointStore` 和 `reconstructState()` 提供：

- 全量 checkpoint 的原子持久化和 JSON 读取诊断；
- 通过最后事件 ID、sequence 和 state hash 校验 checkpoint；
- 从最近有效 checkpoint 应用后续 `state.changed` 事件；
- checkpoint 缺失、JSON 损坏、引用事件不匹配或状态哈希不一致时回退到事件流；
- `set`、`merge`、`append` 和 `delete` 状态操作；
- 从头重建与 checkpoint 重建的状态哈希一致性测试；
- `SnapshotWriter.asInterceptor()` 自动保存 Recorder 创建的 checkpoint。

## ALS-105 已实现内容

实现文件：

- `packages/recorder/src/redaction.ts`
- `packages/recorder/src/redaction.test.ts`

`RedactionPipeline` 提供：

- JSON Pointer 字段规则和数组通配符；
- 正则脱敏规则，覆盖 API key 和 authorization 等默认模式；
- 自定义 redactor，以及 `mask`、`reference`、`remove` 策略；
- Error 对象、嵌套对象和数组的安全规范化与脱敏；
- `asInterceptor()`，在 Recorder 进入 JSONL 持久化边界前替换 payload；
- `redactArtifact()`，在 artifact 写入前处理 JSON、文本内容和 preview；
- 仅记录脱敏类别、路径和策略，不记录原始敏感值。

## ALS-106 已实现内容

实现文件：

- `packages/example-runtime/src/openai-compatible.ts`
- `packages/example-runtime/src/example-agent.ts`
- `packages/example-runtime/src/cli.ts`
- `packages/example-runtime/src/index.test.ts`
- `packages/example-runtime/fixtures/example-run/`
- `examples/example-agent/.env.example`

Example Runtime 提供：

- OpenAI-compatible `/chat/completions` 模型 adapter，不依赖供应商 SDK；
- `ALS_MODEL_API_KEY`、`ALS_MODEL_BASE_URL`、`ALS_MODEL_NAME` 和超时配置，密钥只从环境变量读取；
- Recorder 驱动的模型请求/结果/失败、工具请求/结果/失败、状态变更、决策和 checkpoint 事件；
- 并行只读工具调用，以及可重试工具失败的独立 request/failed 事件链；
- 使用 RedactionPipeline 和 SnapshotWriter 生成并校验完整示例快照；
- 提交固定的脱敏示例快照，覆盖模型调用、并行只读工具、失败重试和 checkpoint，并由测试持续通过 ALS-004 校验器；
- `examples/example-agent/README.md` 中的本地运行说明，`.env` 不会被提交。

## ALS-201 已实现内容

实现文件：

- `packages/trace/src/index.ts`
- `packages/trace/src/index.test.ts`

Trace Loader 提供：

- 流式读取 `events.jsonl`，保留完整事件并报告非法 JSONL 行和损坏尾部；
- 优先读取临时 manifest，支持识别未提交或不完整快照；
- 读取 checkpoint JSON 和 artifact metadata，不在加载阶段一次性读取 artifact 内容；
- 建立 event-by-id、children、actor、type 和事件行号索引；
- 提供按 ID、父子关系、actor、事件类型、sequence 和时间范围查询的稳定 API；
- 检测 schema 错误、重复/断裂引用、因果环、异常根节点、缺失 artifact 和字节数不匹配；
- 通过 `readArtifact(digest)` 按需读取 artifact 内容。

## ALS-202 已实现内容

实现文件：

- `packages/graph/src/index.ts`
- `packages/graph/src/index.test.ts`

Graph Projector 提供：

- 因果 DAG 投影，保留并行分支和多父节点汇合；
- 调用树投影，按稳定顺序选择主父节点；
- 按 timestamp、sequence 和 event ID 稳定排序的线性时间线；
- actor、事件类型、状态和 sequence 范围过滤；
- 连续模型流式事件和低层噪声事件折叠，并保留全部源 event ID；
- 每个图节点包含源事件 ID、事件类型、actor、状态和父事件引用。

## ALS-203 已实现内容

实现文件：

- `packages/cli/src/index.ts`
- `packages/cli/src/index.test.ts`

CLI 提供：

- `validate <snapshot-directory>`：合并 schema、JSONL、checkpoint、artifact 和 Trace 结构诊断；
- `inspect <snapshot-directory>`：输出运行状态、耗时、模型/工具调用计数、失败代码和事件统计；
- `graph <snapshot-directory>`：输出因果 DAG、调用树或时间线，默认 Mermaid，也支持 JSON 和文本；
- `--actor`、`--type`、`--status`、`--min-sequence`、`--max-sequence` 和 `--no-fold-noise` 图过滤选项；
- `--json` 机器可读模式，路径归一化为快照内相对路径，终端摘要不打印 payload；
- 退出码：`0` 成功、`2` 快照校验失败、`1` 参数或运行错误。

M2 收尾补充：

- `packages/trace/benchmarks/loader-100k.js` 提供 100k 事件基准，三次运行的中位加载耗时为 2446.90 ms，基线记录见 `docs/benchmarks/trace-loader-100k.md`；
- `packages/graph/golden/parallel-calls.causal-dag.json` 固定并行分支与多父节点汇合的 DAG 输出；
- `packages/cli/golden/parallel-calls.causal-dag.mmd` 固定 Mermaid flowchart 输出，并由 CLI 测试回归；
- 根目录 `pnpm run alsnap -- ...` 提供 workspace 内可直接调用的 CLI 入口。

## 里程碑状态

M1 的 ALS-001 至 ALS-106、M2 的 ALS-201 至 ALS-203，以及 M3 的 ALS-301 至 ALS-304 均已完成。M3 收尾已补齐：`alsnap replay --mode mock --output <directory>` 会落盘一个新快照，artifact-backed state 会被物化，且 Windows 与 Unix 的换行差异不再导致测试失败。固定示例快照继续作为 Trace Loader、Graph、CLI 和 Replay 的端到端夹具，下一步进入 `ALS-401` Workflow IR。

## 验证结果

最后一次完整质量验证：

```text
直接调用项目锁定的 TypeScript、ESLint、Prettier 和 Node.js 工具
类型检查：通过
ESLint：通过
Prettier：通过
测试：60 passed, 0 failed
```

本机使用 Node.js 24.20.0；项目约束是 Node.js `>=24.20.0 <25` 和 pnpm `>=11.19.0 <12`。最终质量门禁和 100k Trace Loader 基准均使用本机 Node.js 24.20.0 执行。

## 下一步

建议继续执行 `ALS-401`：定义 Workflow IR v0.1。重点是：

1. 保留 ALS-106 的 Example Runtime 和 CLI 作为端到端夹具；
2. 定义 input、node、dependency、condition、retry、output schema、verifier 与权限元数据；
3. 支持 agent task、tool call、verification、human approval 四类节点，并表达分支、并行、汇合、重试和失败终止；
4. 使 YAML 与 JSON 共享一份 schema，并保证所有节点都有明确成功条件。

## 新会话提示

新会话开始时可直接粘贴：

> 请阅读 `docs/handoff.md` 和 `docs/implementation-plan.md`，基于当前工作区继续执行 ALS-401。保留现有 ALS-001 至 ALS-304 实现，先检查当前代码和测试，再定义 Workflow IR v0.1。

## 工作区注意事项

- 当前工作区变更只提交到本地，未执行 push；工作区中的现有文件均属于本项目当前实现。
- 不要使用 destructive git 操作覆盖现有工作区。
- 现有快照布局见 `docs/adr/0002-runtime-and-storage.md`。
- 事件身份、顺序、上下文和错误语义见 `docs/adr/0003-event-ordering-and-identity.md`。
