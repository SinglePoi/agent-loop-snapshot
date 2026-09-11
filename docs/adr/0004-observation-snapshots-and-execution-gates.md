# ADR-0004：观察快照、来源完整度与执行门禁

- 状态：已接受
- 日期：2026-09-11
- 决策者：项目维护者
- 关联任务：CAP-01、CAP-02、CAP-06、EXP-01

## 背景

现有 `0.1.0` Run Snapshot 是由本地 Recorder 生成的可恢复运行记录。函数包装、供应商 SDK 自动集成和 OTLP 历史 Trace 导入将增加不完整、仅观察和来源不受本项目控制的快照。结构校验通过、来源声称成功、记录完整，以及允许 replay/resume 是四个不同问题，不能再由当前 schema 版本相同这一条件混为一谈。

`RunCompletedPayload.final_state_hash` 在 `0.1.0` 中是必填字段。因此没有可重建状态的历史 Span 不能伪造 `run.completed`，也不能以空对象的 hash 填补缺失事实。

## 决策

### 公共语义

从 CAP-01 起，公共类型统一采用下列术语；CAP-02 将其持久化到版本化 manifest 和观察事件中：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `source` | `native`、`sdk`、`otel-import` | 快照产生路径，而不是可信度或权限声明。 |
| `completeness` | `unknown`、`partial`、`complete` | 对采集证据的判断；有效快照不必完整。 |
| `limitations` | 稳定限制代码及已脱敏说明 | 解释缺损、截断、采样、未知副作用等限制。 |
| `execution eligibility` | `eligible_for_validation`、`observation_only` | 只表达是否能进入后续执行验证，永远不是执行授权。 |

`complete` 只可由本项目采集路径在已知所有必需证据完整时写入。未发现问题不能推导为 `complete`；导入 Trace 默认为 `unknown`，一旦发现采样、缺父、截断或缺 payload 则为 `partial`。

### 观察终态和状态 hash

CAP-02 新增观察型终态和 `otel.span` 表示。它们保留已知的来源业务状态（包括 `UNSET` 或未知），但不表示可恢复的本地状态。只有具备实际重建证据的原生 Run 才能发出 `run.completed` 并携带 `final_state_hash`。没有该证据的快照使用观察终态；禁止生成空对象 hash、虚假的 `run.completed`、虚假 checkpoint，或将业务输出当作最终状态。

### 执行门禁

所有来源都可在结构有效时查看；执行入口还必须通过版本兼容、完整度、限制、Replay 验证器、适配器和当前 Policy 的独立检查。来源元数据或任何未来 `replay` 布尔字段不能绕过这些检查。

| 来源与证据 | validate / inspect / graph | replay / resume / compile |
| --- | --- | --- |
| 既有 `0.1.0` 原生快照 | 保持既有行为 | 保持既有版本、结构和 Replay 校验。 |
| 新原生完整记录 | 支持 | 仅可进入既有验证和 Policy；不承诺恢复业务代码。 |
| SDK 完整记录 | 支持 | 必须再验证适配器、权限和无截断记录。 |
| SDK 不完整或降级记录 | 支持并展示限制 | 拒绝。 |
| OTLP 导入（任何完整度） | 支持 | 首版无条件 `observation_only`，拒绝。 |

公共 `assessSnapshotExecution()` 只给出保守的证据判断：OTLP 导入、非 `complete` 记录和执行阻断限制都返回 `observation_only`。返回 `eligible_for_validation` 也不授予任何权限。

### 版本与兼容

观察快照的持久化协议将在 CAP-02 作为 `0.2.0` 引入。该变更遵循 ADR-0003 的 minor 版本规则：新增字段和事件必须保持旧字段可读；新读取器需为 `0.1.0` 注册显式、输出到新目录的迁移；旧读取器不得把 `0.2.0` 快照当成可执行快照。不得静默改变既有 `0.1.0` 语义。

CAP-02 还必须更新 TypeScript 类型、JSON Schema、validator、migration、trace/graph/CLI 展示、Replay/Resume 门禁和 fixtures。协议有效但 `partial` 的观察快照校验通过并产生警告；只有结构非法才校验失败。

### 副作用和来源数据

OTLP attributes、Span 名称和模型生成的 tool-call 声明都不是工具实际执行的证明。无法证实的副作用标记为 `unknown_side_effect`，并阻断执行。导入器不执行输入内容、不跟随 URL、不读取属性指向的路径；所有来源信息、限制信息和导入报告必须在落盘前脱敏。

## 备选方案

### 用 `run.completed` 加空 hash 表示历史 Trace 结束

不采用。它会把“Span 已结束”错误表示为“Agent 状态可重建”，并可能绕过恢复门禁。

### 用一个 `replay: true` 元数据字段决定执行

不采用。来源可伪造该字段，且它无法表达采样、流截断、缺 payload、适配器能力和当前授权。

### 让 OTLP 导入和原生 Recorder 走同一实时写入路径

不采用。导入必须保留源时间和标识，且不能把历史事实伪装成当前 Recorder 的实时事件。

## 后果

- 查看能力与执行能力具有可测试的明确边界；
- CAP-02 会涉及跨包兼容修改，但可避免以后为导入、SDK 和导出重复定义来源语义；
- 观察快照的 schema 与 CLI 输出会增加字段，用户需理解 `valid` 不代表 `complete` 或可执行；
- 外部导出可保留来源和完整度，而不会把历史导入记录升级为可执行工作流。
