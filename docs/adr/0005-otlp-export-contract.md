# ADR-0005：OTLP/HTTP 导出契约与发送边界

- 状态：已接受
- 日期：2026-09-11
- 关联任务：EXP-01、EXP-02、EXP-03

## 背景

快照需要能够发送到用户指定的 OTLP/HTTP traces endpoint 或 Collector，同时保持本地快照为事实来源。导出不能改变 Recorder 的提交语义，也不能把导入的观察快照升级为可执行记录。导出协议还必须区分映射损失、内容过滤、排队和远端接收状态。

## 决策

### 包边界

导出契约和实现放在独立的 `@agent-loop-snapshot/otel-export` 包中。Recorder、schema 和 replay 不依赖该包；instrumentation 通过 exporter 接口可选接入。EXP-01 只定义类型、版本和纯契约，不执行网络请求、不创建队列、不读取环境变量。

### 目标与凭据

导出目标必须由调用方显式提供完整 endpoint，或提供 endpoint 环境变量名。鉴权 header 只允许通过环境变量名引用；解析后的 header 只能存在于发送过程的内存中，不能进入快照、spool、报告或日志。目标配置不从快照内容、trace attributes 或重定向推导。默认不允许自动跟随重定向。

### 内容策略

默认策略为 `metadata-only`：只发送流程名称/类型、状态、时间、关系、安全资源信息和必要的来源元数据。模型输入输出、工具参数结果、状态值、异常消息、任意自由文本 attributes/events 默认丢弃。只有显式选择 `redacted-content`，并经过独立的出站脱敏与字段限额处理后，才允许发送内容。

过滤必须发生在持久化发送队列之前，因为旧快照和 OTel 导入快照不能假设已经脱敏。artifact 只发送安全元数据，不发送内容、预览或本地绝对路径。

### Trace/span 映射

- 一个原生或 SDK Run 映射为一个 OTLP trace；同一 Run 的重复导出使用稳定的非零十六进制 trace/span ID。
- requested 与其 completed/failed 终态组成一个 span；未配对调用保留为不完整并产生映射损失，不伪造成功。
- 快照的多父 DAG 必须选择一个稳定主 parent；其他关系转为 links 和来源属性，并在报告中记录 `multiple_parents_collapsed`。
- 并行兄弟不按时间串行化；业务失败、未知状态和导出失败分别表示，`UNSET` 不转换为 OK。
- OTel 导入快照优先保留合法源 ID、resource、scope 和 links，但始终保留 `observation-only` 语义，往返导出不得提升执行能力。

### 状态与损失

导出状态至少区分 `dry_run`、`queued`、`accepted`、`retryable`、`rejected`、`exhausted` 和 `unknown_delivery`。HTTP 2xx 不自动等同于完整接受；OTLP `partial_success` 必须保留拒绝数量并按协议判定，不自动重发该批次。

映射报告必须包含快照来源、完整度、生成的 trace/span 数量、丢弃字段数量、映射损失、限制和配置指纹。报告不得包含凭据或未过滤的原始内容。网络失败不能使已成功完成的业务 Run 失败，也不能把本地快照标成采集不完整。

导出不承诺 exactly-once。响应丢失可产生重复 span；稳定 ID 只提供平台可去重的机会，不构成平台去重保证。

### OTLP/HTTP 传输

EXP-03 固定使用 OTLP/HTTP JSON：对配置的完整 traces endpoint 发起 `POST`，请求使用 `application/json`，并禁用自动重定向。HTTPS 为默认要求；仅明确的 loopback 本地测试 endpoint 可使用 HTTP。响应读取上限为 4 MiB，超限或无效 JSON 响应均视为不可重试错误。

HTTP `200` 且包含 `partialSuccess` 时按 partial success 报告已接受和已拒绝 span 数，不自动重发。只有 `429`、`502`、`503`、`504` 进入有界重试；`Retry-After`（秒数或 HTTP 日期）优先于带随机抖动的指数退避。超时、断连和调用取消无法确认最终送达时报告 `unknown_delivery`；重试耗尽的已知临时 HTTP 失败报告 `exhausted`。业务模型和工具调用永不参与重试。

### 持久化队列

EXP-04 使用队列目录下的独立批次文件保存已过滤 OTLP request、span 数、目标别名、非敏感配置指纹、批次 ID、时间和尝试次数；不保存 endpoint、已解析 header、凭据、原始快照或业务调用。每个新批次先写入并同步临时文件，再以同一文件系统上的原子链接发布；更新尝试次数使用同步临时文件与原子替换。

队列以全局条数、字节数和保留期限限制增长。满额、无效批次或磁盘提交失败返回 `not_queued`，不会修改源快照。成功、partial-success 或不可重试拒绝会移除批次；`exhausted` 与 `unknown_delivery` 保留批次，因而后续重发可能产生重复 span。到期批次在入队或 flush 时清除。

flush/shutdown 使用一个文件锁确保单消费者；活跃锁拒绝第二个消费者，过期锁可在明确的 stale 阈值后恢复。flush 只发送目标别名和配置指纹都匹配的批次，目的地或内容策略变化后的旧批次保持在队列中，必须由用户显式重新导出。deadline 到期会中止当前发送并保留未确认批次。

## 后果

- EXP-02 可以实现为无副作用的快照到 OTLP 映射器和 dry-run，不需要网络或队列。
- EXP-03/04 可在不改变公共快照协议的情况下实现 HTTP 分类、重试和持久化队列。
- SDK 自动发送只能在本地快照终结后入队；exporter 自身 HTTP 不得被 SDK instrumentation 递归采集。
- 平台兼容只在固定版本 Collector 和官方配置依据上声明；Collector 验证不等同于云平台 UI 实测。
