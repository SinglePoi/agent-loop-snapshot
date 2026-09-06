# ADR-0001：使用 TypeScript 实现首个版本

- 状态：已接受
- 日期：2026-09-06
- 决策者：项目维护者
- 关联任务：ALS-001

## 背景

Agent Loop Snapshot 需要同时提供运行时 Recorder、事件与 Workflow 类型、CLI、回放引擎以及后续的 Web Viewer。首个实现需要在 TypeScript 和 Python 之间选择主要语言，以避免早期维护两套行为尚未稳定的 SDK。

## 决策

首个版本使用 TypeScript 实现，运行于 Node.js 当前活跃 LTS 版本。以下组件使用同一个 TypeScript workspace：

- Snapshot schema 类型与校验器
- Recorder SDK
- Trace Loader 与 Graph Projector
- Replay Runner 与 Policy Engine
- CLI
- Web Viewer

持久化协议不绑定 TypeScript：manifest、events、checkpoint 和 Workflow IR 继续使用版本化 JSON Schema 定义。Node.js 的精确版本和包管理器在初始化仓库时锁定。

## 理由

- Recorder、CLI 和 Viewer 可以共享事件类型、Workflow 类型与校验逻辑。
- TypeScript 的判别联合适合对事件类型做编译期穷尽检查。
- Node.js 的异步上下文、Stream 和 Promise 模型适合记录并行工具调用与 JSONL 事件。
- Viewer 不需要维护一套与后端重复的数据模型。
- 单一 workspace 可以降低 MVP 阶段的构建、测试和发布复杂度。

## 后果

### 正面影响

- MVP 只维护一套核心实现和测试夹具。
- Schema、CLI 和 Viewer 的类型变更可以在同一变更中检查。
- 第一版图投影和交互式查看器能够复用相同的查询模型。

### 代价

- Python Agent Runtime 不能直接导入首个 Recorder SDK。
- 接入 LangGraph 等 Python Runtime 时，需要 Python adapter 或进程间事件桥接。
- 团队需要约束 TypeScript 类型不能取代持久化 JSON Schema，避免协议只在编译器中存在。

## 兼容策略

- JSON Schema 是跨语言持久化协议的唯一事实来源。
- TypeScript 类型应由 schema 生成，或通过自动化测试证明与 schema 一致。
- 将来的 Python SDK 必须通过与 TypeScript SDK 相同的 golden snapshot 兼容性套件。
- 不允许为 Python 单独设计不兼容的事件格式。

## 未在本 ADR 中决定的事项

- 首个接入的具体 Agent Runtime
- 包管理器与 workspace 工具
- 测试框架
- Viewer 框架
- 开源许可证

这些事项由 ALS-001 和后续 ADR 决定。
