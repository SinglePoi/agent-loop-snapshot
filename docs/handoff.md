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

## M1 收尾状态

M1 的 ALS-001 至 ALS-106 已完成：固定示例快照已纳入仓库，Node.js 24.20.0 质量门禁已通过，下一步进入 M2 的 ALS-201。

## 验证结果

最后一次完整质量验证：

```text
直接调用项目锁定的 TypeScript、ESLint、Prettier 和 Node.js 工具
类型检查：通过
ESLint：通过
Prettier：通过
测试：32 passed, 0 failed
```

本机 nvm 当前使用 Node.js 24.20.0；项目约束是 Node.js `>=24.20.0 <25` 和 pnpm `>=11.19.0 <12`。最终质量门禁使用 nvm 的 Node.js 24.20.0 执行。

## 下一步

建议继续执行 `ALS-201`：在已完成的快照基础上继续实现 Trace/Graph/CLI 的可用闭环。重点是：

1. 保留 ALS-106 的 Example Runtime 作为端到端夹具；
2. 补齐快照读取、查询、图投影和 CLI 展示；
3. 继续沿用 Recorder hook 和脱敏边界；
4. 为后续 Mock Replay 准备稳定的事件查询接口。

## 新会话提示

新会话开始时可直接粘贴：

> 请阅读 `docs/handoff.md` 和 `docs/implementation-plan.md`，基于当前工作区继续执行 ALS-201。保留现有 ALS-001 至 ALS-106 实现，先检查当前代码和测试，再继续实现 Trace/Graph/CLI 的可用闭环。

## 工作区注意事项

- M1 收尾变更只提交到本地，未执行 push；工作区中的现有文件均属于本项目当前实现。
- 不要使用 destructive git 操作覆盖现有工作区。
- 现有快照布局见 `docs/adr/0002-runtime-and-storage.md`。
- 事件身份、顺序、上下文和错误语义见 `docs/adr/0003-event-ordering-and-identity.md`。
