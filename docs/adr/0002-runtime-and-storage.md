# ADR-0002：首个 Agent Runtime 与快照存储边界

- 状态：已接受
- 日期：2026-09-06
- 决策者：项目维护者
- 关联任务：ALS-001

## 背景

Agent Loop Snapshot 需要一个可重复运行的目标 Runtime，才能在后续任务中验证 Recorder、并行因果关系、失败重试和 Mock Replay。当前项目尚未绑定具体的 Agent 框架或模型供应商；如果一开始直接接入外部框架，协议测试会同时受到供应商 SDK、网络和账号配置影响。

项目还需要明确“事实记录”和“可执行流程”的存储边界。历史运行可能包含失败尝试和环境偶然性，不能把它们未经审核地当作工作流执行。

## 决策

### 首个目标 Runtime

首个目标 Runtime 是仓库内维护的、框架无关的 TypeScript 示例 Agent Runtime，暂称 `Example Runtime`。它是用于协议和 SDK 验收的参考实现，不是新的通用 Agent 编排框架。

它必须提供以下最小能力：

- 通过抽象的 model adapter 和 tool adapter 进行调用；
- 记录顺序调用和并行只读工具调用；
- 表达工具失败、重试和最终成功或失败；
- 产生显式状态变更；
- 通过 Recorder hook 记录事件，而不是由 Runtime 手工拼接持久化 JSONL。

示例 Runtime 不要求真实模型供应商、网络服务或外部账号。需要真实供应商时，通过 adapter 接入；供应商差异不得进入快照协议或 Recorder 核心 API。

### 运行环境

- 实现语言：TypeScript；
- 运行时：Node.js 24.20.0；
- 包管理器：pnpm 11.19.0；
- 精确 Node.js 版本通过 `.nvmrc`、`.node-version`、`package.json` 的 engines 和 CI 配置共同锁定。

截至本 ADR 日期，Node.js 官方发布表将 v24 标为 LTS；仓库初始化时选择了 24.20.0 作为首个基线。

### 快照布局与所有权

一次运行的事实快照使用以下布局：

```text
run-snapshot/
├── manifest.json
├── events.jsonl
├── workflow.yaml          # 可选；由事实记录编译得到
├── checkpoints/
│   └── 000001.json
└── artifacts/
    └── sha256-<digest>
```

- `events.jsonl` 是追加式事实记录。事件写入后不原地修改或重排；
- `manifest.json` 描述运行、协议版本、完成状态和入口元数据；提交时使用临时文件加原子重命名；
- `checkpoints/` 保存可恢复状态的全量快照，并指向对应的最后事件；
- `artifacts/` 使用 SHA-256 内容寻址，事件只保存引用、媒体类型、字节数和可选预览；
- `workflow.yaml` 不是历史事实的替代品，只能由 Trace Compiler 生成或人工审核后保存。

Recorder、Trace Loader 和 Replay Runner 均不得把外部写入或历史授权默认继承为新运行的授权。回放产生新的 Replay Trace，并通过独立的 Policy Engine 决定是否允许副作用。

## 备选方案

### 直接接入 LangGraph、OpenAI Agents SDK 或其他既有框架

暂不采用。它们可以作为后续 adapter，但会把 MVP 的协议验证与某个框架版本、供应商行为和网络条件耦合。

### 先实现真实模型驱动的 Runtime

暂不采用。真实模型不是 schema、事件顺序或 Recorder 生命周期的必要前提；将其放在第一步会增加不确定性，并使固定夹具难以稳定复现。

### 允许事件、checkpoint 和 workflow 共享同一份可变状态文件

不采用。这样会混淆审计事实与可执行意图，也会使崩溃恢复和差异分析难以验证。

## 后果

### 正面影响

- M0 和 M1 可以在无供应商凭据、无网络的环境中完成验收；
- 示例 Runtime 能覆盖 MVP 需要的并行、失败重试和状态变更；
- 未来接入外部 Agent Runtime 时，只需实现 adapter 并复用同一快照协议；
- 事实记录、检查点、artifact 和工作流的边界清晰，便于校验和安全回放。

### 代价

- 需要维护一个只用于参考和测试的示例 Runtime；
- 真实 Agent 框架的特殊能力不会在 MVP 第一版直接获得；
- `workflow.yaml` 与 `events.jsonl` 需要分别校验、迁移和测试。

## 兼容策略

- 任何 Runtime 都必须通过公开的事件和 adapter 接口接入，不得写入供应商专属的持久化格式；
- 示例 Runtime 生成的 golden snapshot 作为其他 adapter 的最低兼容基线；
- 未来的 Python 或其他语言 SDK 必须读写相同的 JSON Schema，而不是复制一套协议。
