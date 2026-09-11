# 低侵入采集、OpenTelemetry 导入与外部平台导出开发计划

更新时间：2026-09-11。状态：CAP-01、CAP-02 已完成，其余任务待实现，交给 coding agent 执行。

本文替代原函数包装计划，保留文件路径。所有新增 API、命令和能力均为待实现目标，不能按已实现功能宣传。

## 1. 目标与交付边界

用户无需逐次调用 appendEvent，便可获得可查看的 Agent 运行快照。交付三条入口：

| 入口 | 用户操作 | 本次交付 |
| --- | --- | --- |
| 通用函数包装 | 一次注册模型与工具异步函数 | instrument、run、可选 checkpoint |
| 常用 SDK 自动集成 | 初始化一次，继续调用原 SDK | Node.js OpenAI、Anthropic 专用集成 |
| 现有 OpenTelemetry traces | 导入标准 OTLP JSON | SDK 导入器、CLI、可查看快照 |

新增必交付出口：通过 OTLP/HTTP 将流程遥测发送到用户配置的外部平台或 Collector，同时保留本地快照。包括已有快照批量导出，以及采集运行结束后的异步发送。

自动集成在用户进程内工作，不要求请求经过本项目服务器；仍需初始化入口，不能穿透远程黑盒 Agent。自定义工具通过通用包装记录，不能把模型生成的 tool-call 声明当成工具实际执行。

三条入口及外部导出均为本计划的必交付项。OTel“接收”首版落实为离线文件/内存导入；实时逐 span 发送、常驻 HTTP/gRPC 接收器、生产 Collector 部署为后续方向。本次不实现 Python、框架插件、网络抓包、任意对象 Proxy、业务调用自动重试、自动变量采集、自动恢复调用栈、Web Viewer 或 npm 发布。导出传输自身的有界重试属于本次范围。

## 2. 架构和包划分

```text
函数包装 ───────┐
SDK 自动集成 ───┴─ 运行上下文 / 规范化 / 脱敏 ── Recorder / Writer
OTLP JSON ── span 解析 / 来源映射 / 脱敏 ── 导入快照构建器

版本化快照 ── validate / inspect / graph
           └─ 完整性与能力检查 ── replay / compile / resume
           └─ 导出映射 / 出站脱敏 ── 持久化发送队列 ── OTLP HTTP ── 平台或 Collector
```

- `packages/instrumentation`：通用包装、运行生命周期、异步上下文、序列化、诊断和扩展接口。
- `packages/instrumentation-openai`、`packages/instrumentation-anthropic`：可选供应商集成，隔离依赖。
- `packages/otel-import`：OTLP 解析、映射 profile、历史快照构建和导入报告。
- `packages/otel-export`：快照到 span 映射、出站过滤、OTLP HTTP 传输、持久化发送队列及报告。作为可选包，通过 exporter 接口接入采集层，不向 Recorder 增加网络依赖。
- 对 schema、trace、graph、replay、CLI 做必要兼容修改，保留原 Recorder 接入方式。

禁止 recorder 反向依赖 instrumentation/replay。历史 trace 使用专门构建路径保留源时间和标识，不能当作当前时间的实时 Recorder 调用写入。

## 3. 通用函数包装

目标用法：

```ts
const agent = instrument({
  snapshotDir: './runs', // 每次 run 新建唯一子目录
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

const answer = await agent.run({ input: { goal: '查资料并总结' } },
  async ({ model, tools, checkpoint }) => {
    const query = await model.call('生成检索词');
    const documents = await tools.search(query);
    await checkpoint({ query, documents }); // 可选
    return model.call(JSON.stringify(documents));
  });
```

要求：

- run 返回原始业务结果，保留身份和类型；提供 onSnapshot 和 onDiagnostic，不使用并发不安全的 lastRun。
- 保留参数元组、返回类型推断。对象方法用箭头函数或 bind 适配，不丢失 this。首版通用入口支持 Promise 返回函数。
- 工具副作用等级必填。原参数/结果不变，脱敏仅作用于独立的记录副本。
- 默认支持安全 JSON；多参数记为 `{ args: [...] }`，undefined 返回在副本中规范化为 null。调用和 run 均支持 serializeInput/serializeOutput。
- 输入在调用前捕获，输出在返回时捕获。循环引用、BigInt、Response、类实例、Stream 等需明确适配；禁止隐式调用任意 toJSON/getter 猜测序列化。
- checkpoint 保存用户显式全量状态，内部计算脱敏后一致的 hash；不扫描局部变量，不自动把模型/工具结果变成 state.changed。
- 首版不自动把大对象存入 ArtifactStore；保留显式 artifact 接口，限制记录副本大小并明确诊断。

## 4. SDK 自动集成

目标体验：启动时安装专用拦截器，业务代码继续使用原 SDK 方法。以下为示意 API，必须提供真实可运行的启动示例：

```ts
// telemetry.ts，先初始化，再动态加载业务模块
const telemetry = initInstrumentation({
  snapshotDir: './runs',
  integrations: [openAIIntegration(), anthropicIntegration()],
  recordingFailure: 'best-effort',
});
const { main } = await import('./app.js');
try {
  await telemetry.run({ input: { goal: '完成任务' } }, () => main());
} finally {
  await telemetry.shutdown();
}
```

业务 main 继续调用 `client.chat.completions.create()`、`client.responses.create()`、`client.messages.create()`。通用包装工具可以加入同一运行上下文，无需创建嵌套 run。

### 4.1 首批适配与加载

必须覆盖 OpenAI Chat Completions、Responses 和 Anthropic Messages：先非流式，再支持各自 `stream: true` 异步迭代路径。专用 `.stream()` 等其他 helper 未覆盖时在支持矩阵中明确列出。

采用模块加载钩子或成熟 OTel instrumentation 机制，按模块名、版本及具体方法安装。实施时查官方 SDK 源码，固定依赖和测试版本，公布精确支持区间及 Node.js、ESM/CJS 启动方式。不能把静态 import 的文本顺序当成初始化保障；打包环境不支持时明确诊断。

自动集成验收必须使用真实 SDK 配合本地 HTTP fixture，不能用仅有 attachClient 的手动方式冒充。提供显式客户端接入作为提前加载或打包器环境的退路。

初始化幂等，支持安全卸载。不得卸载/覆盖第三方后来安装的包装。不得替换应用已有全局 OTel provider/context manager 或关闭其 exporter。文档写清共存范围并测试。

同一调用经过通用包装和自动集成时，通过 suppression/context 标记避免重复记录；不能用相同参数去重，也不能抑制合法嵌套调用。默认只捕获显式 run 内的 SDK 调用，run 外原调用正常执行并给出一次范围提示。

### 4.2 保持 SDK 行为和流语义

SDK 方法可能返回带 `.withResponse()`、`.asResponse()` 等辅助能力的 Promise-like 对象。不能简单 async 包装后破坏已支持 API；保留 this、参数、结果、业务错误、取消信号及供应商 SDK 自带重试。

流不能被记录器提前消费或导致第二次请求。只在用户迭代时观察数据，保留背压、return、取消、错误及正常结束。副本有容量上限，明确标记截断、未消费、提前结束。拿到 Stream 对象不等于调用完成。

记录实际可得的模型名、请求/响应、usage、finish reason、tool-call 声明及错误；提供 metadata-only 选项。不可见的 SDK 内部重试不编造 attempt。流式记录不完整时禁止承诺可回放。

## 5. 实时记录共用契约

每个 run 独立上下文、Recorder/Writer、排他创建的随机唯一目录及临时 manifest。自动记录 run.started、调用 requested、对应 completed/failed、最终终态；结束时提交、刷盘并关闭。

父关系只表达可证实的结构：顶层 requested 关联 run.started；嵌套 requested 关联外层 requested；调用终态关联自己的 requested。并行兄弟不按时间串成依赖；sequence 仅为单次 Run 写入顺序。不能仅凭 await 顺序推断业务数据流。

回调结束后等待已启动调用及其内部调用，处理 Promise.all 提前失败、未 await 和逃逸函数。drain 有可配置超时，超时标记采集不完整，防止后续写入已关闭 Writer；不宣称能取消任意业务函数。关闭后通用包装拒绝新调用；自动拦截的遗留上下文调用按故障策略诊断，不写入旧 Run。首版拒绝嵌套 run，支持外部并发 run。

| 记录故障策略 | 默认入口 | 契约 |
| --- | --- | --- |
| strict | 通用包装 | 请求记录失败不执行原函数；执行后记录失败抛记录错误，不重试业务 |
| best-effort | SDK 自动集成 | 保留原调用结果/异常，诊断记录失败；快照标记不完整且禁止执行 |

业务与记录同时失败时保留原始业务抛出值，次级错误通过安全诊断暴露。strict 模式只有记录失败也必须让 run 失败。best-effort 无法写 manifest 时从运行外诊断明确报告，不能静默成功。通知回调异常不得遮蔽业务错误。记录器自身活动不得递归采集。

## 6. OpenTelemetry 导入

首版接受 OTLP/HTTP JSON 的 ExportTraceServiceRequest 结构：resourceSpans/scopeSpans/spans。SDK 接受已解析对象，CLI 接受一个或多个文件并在一次导入中合并；每个 traceId 生成独立快照，可筛选单 trace。

```sh
alsnap import-otel trace-a.json trace-b.json --output ./imported-runs --json
alsnap inspect ./imported-runs/<run-id> --json
alsnap graph ./imported-runs/<run-id> --kind timeline --format json
```

首版不支持 protobuf/gRPC、OTel console 文本或任意厂商 UI 导出格式。报告需包含目录、源 trace ID、导入/拒绝/截断/去重数量、完整度、能力和诊断。

### 6.1 映射

| 源数据 | 目标规则 |
| --- | --- |
| traceId/spanId | 保留来源，生成符合项目 ID 语法的稳定映射 |
| parentSpanId | 有效同 trace 父子关系；缺父明确报告，不捏造实际父 span |
| links | 独立关联，不直接转换为执行依赖或 parent_ids |
| 时间 | 源纳秒值保留字符串，用 BigInt 做差；展示时间另行转换 |
| resource/scope | 安全保留服务、SDK、语义约定版本等来源 |
| attributes/events | 限长、脱敏后保存；未知语义保持可查看 |
| status/exception | 区分 OK、ERROR、UNSET，不把 UNSET 当作成功 |
| GenAI/工具属性 | 依据固定映射 profile 分类；缺失参数/输出保持缺失 |

基础表示采用通用 otel.span 观察事件，更新图投影使其可查看。具体模型/工具分类由经过测试的 profile 增强；不能仅凭 span 名称证明工具执行，不能填假结果转为 model.completed/tool.completed。

交付通用 profile 和一个固定版本的 OTel GenAI profile。若声明 Langtrace 专有语义支持，需增加真实形状的脱敏 fixture 和专用映射；标准 OTLP 容器可读不等于已理解所有厂商属性。

### 6.2 缺损、排序和导入限制

- ended spans 不证明源任务成功；采样、drop 计数、缺 root/缺 payload 明确报告。完整度默认 unknown，有缺损则 partial，不能以未发现问题推导 complete。
- 相同 trace/span ID 同内容去重，冲突内容报告并隔离；自父、环、非法 ID、负时长有确定错误策略。跨 trace 父引用不合并运行。
- 对有效父关系做稳定拓扑排序生成 sequence；源时间保留，时钟偏移不冒充单调时间。links 可跨 trace，不产生因果拓扑环。
- 导入操作完成与源业务终态分开表示。源状态未知时不伪造 run.completed 或 final_state_hash。
- 限制总字节、span 数、属性长度、嵌套深度及 trace 数；超限默认拒绝，显式截断必须报告。
- 输入视为不可信；不执行内容，不读取 attributes 指向的外部文件或 URL。临时文件、报告、原始副本都必须在写盘前脱敏，输出不覆盖旧快照。

## 7. 协议兼容与执行门禁：前置任务

已核对当前代码：RunCompletedPayload.final_state_hash 必填，旧计划称其可选不准确；当前 manifest 尚无来源、完整度、执行能力字段。实施前写 ADR，决定版本化观察快照表示；不使用空对象 hash 或假终态迎合旧 schema。

建议新版本增加 source（native/sdk/otel-import）、completeness（unknown/partial/complete）、限制原因及能力，必要时扩展观察型事件/终态。同步 TypeScript、JSON schema、校验器、迁移及夹具，按照仓库政策确定版本，不静默改变 0.1.0 语义。旧快照读取必须回归通过。

valid 与 complete 分离：协议有效的 partial 观察快照可 validate 成功并附警告；inspect/graph 展示来源、未知状态和采集限制，结构非法才校验失败。

| 来源 | 查看 | 执行能力 |
| --- | --- | --- |
| 通用包装完整记录 | 支持 | 由实际记录和现有 Replay 验证器判断，不承诺恢复代码 |
| SDK 记录 | 支持 | 缺损/截断/降级则禁止回放；完整也要校验适配器和权限 |
| OTel 导入 | 支持 | 首版统一 observation-only，禁止 replay/resume/生成可执行 Workflow |

门禁必须覆盖 SDK 和 CLI，不能只隐藏 UI。能力字段不是授权，伪造 replay=true 不能绕过完整性和 Policy。导入器强制覆盖源自报执行能力；未知副作用在观察元数据记 unknown，执行检查拒绝，不能默认 read_only。

checkpoint-only 记录与事件回退恢复能力单独测试。业务结果不能自动当作可重建状态，也不应给无状态采集填造最终状态 hash。OTel 导入验收仅要求可信查看。

## 8. 外部平台导出

### 8.1 范围和用户接口

优先交付 OTLP/HTTP JSON 发送到用户提供的完整 traces endpoint；支持经 Collector 转发至平台。首版不实现厂商专有 API、通用 webhook、gRPC 或完整快照压缩包上传。OTLP 传递可观察流程，checkpoint/二进制 artifact 本体仍留在本地。

拟议 CLI：

```sh
# 默认只发送元数据；endpoint 和鉴权从本机环境配置读取
alsnap export-otel ./runs/<run-id> --config ./export.json --dry-run --json
alsnap export-otel ./runs/<run-id> --config ./export.json --json
# 重启后续传，只处理显式指定的本地发送队列
alsnap export-otel --resume --config ./export.json --json
```

配置至少包含目标别名、完整 endpoint 或 endpointEnv、headersEnv、service.name、内容策略、超时、批次上限、重试预算和 queueDir。不把凭据直接放入命令行、版本库或快照。缺配置时不发送，不预设云端收集地址；不从快照内容读取发送目的地。

提供 `createOtlpExporter(config)`，通用 instrument 与 initInstrumentation 均接受 exporters。采集层在本地快照终结后异步入队，失败 run 的已提交快照也能发送；实时逐事件发送不在首版范围。flush/shutdown 返回有界等待的发送报告，不修改业务返回值，不替换或关闭应用已有 OTel provider。

提供 SDK 的显式 exportSnapshot，以及 CLI 的 dry-run。dry-run 展示经过过滤的目标、span 数、丢弃字段和映射损失，不联网、不落发送队列、不输出认证信息。已有导入快照可由用户显式导出，但导入不会自动触发发送，避免转发循环。

### 8.2 快照到 span 的映射

- 一个原生 Run 映射一个 trace；requested 与对应 completed/failed 配对成调用 span。未配对调用标记不完整，不伪造成功或最终输出。
- 使用稳定的合法非零 OTel trace/span ID，重试和相同映射版本的重复导出保持一致；保存映射版本。区分不同 Run，不能按参数去重。
- OTel span 只有一个 parent。对快照多父 DAG 定义稳定、明确的主父选择，其余关系保留为 links 和来源属性；不串行化并行兄弟。导出报告明确这一映射差异。
- 状态变化、checkpoint 和决策可按语义作为 span events/摘要；artifact 默认仅安全元数据，不发送内容、预览或本地绝对路径。
- 保留真实时间、错误、可得 usage、来源、采集完整度和限制。业务失败与导出失败分开，UNSET/未知状态不变成 OK。
- 对 OTel 导入快照优先保留合法源 ID、resource、scope 和 links，但保持 observation-only；再次导出/导入不提升执行能力。未知或有损字段在报告说明，不能声称无损往返。
- CAP-01 的协议设计需覆盖导出所需来源信息。共享规范化类型可以抽公共模块，不能制造 import/export 包之间的循环依赖。

### 8.3 出站内容策略

默认 metadata-only：只发送允许列表内的流程名称、类型、状态、时间、关系和安全资源信息。模型输入/输出、工具参数/结果、状态值、异常消息、任意 attributes/事件文本默认不发送；名称等自由文本也需脱敏。

用户显式选择 redacted-content 后，才发送经过出站 RedactionPipeline 和字段限额处理的内容。本地快照可能来自旧版本或外部导入，不能假设已经脱敏；过滤先于队列落盘。凭据只在发送时解析，不写入 spool、报告或日志。

使用 HTTPS，显式本地测试 endpoint 可使用 HTTP。重定向不自动携带凭据转发；首版禁用自动重定向并报告错误。最终配置只接受用户给定的目的地，不解引用 trace 中的 URL。

### 8.4 队列、传输和故障

记录与发送独立：远端不可达不让 Agent run 失败，不把本地完整快照标记成采集不完整；单独报告 export 状态。导出器不能以可能抛错的网络操作直接挂到 Recorder 提交拦截器上。

发送队列有字节/条数/保留期限上限，保存脱敏 payload、目标别名及非敏感配置指纹、批次 ID、尝试次数。使用原子文件更新和单消费者锁，测试进程中断与恢复。目标 endpoint 或内容策略变化时不可悄悄把旧队列发往新目标，需显式重新导出。

队列满或磁盘失败报告未入队状态，原快照保留，用户可以后续重新导出。内存工作队列也必须有界。处理发送超时、取消、429、可重试错误和不可重试鉴权/格式错误；采用指数退避、抖动、最大次数和总时限，按实施时锁定的 OTLP 规范处理 Retry-After。

正确解析 OTLP partial_success，不把 HTTP 2xx 一律视为完整接收；按规范不自动重发 partial-success 批次，保留拒绝数量与人工处理报告。其余失败区分 pending/retryable、rejected、exhausted、accepted 和 unknown-delivery，避免把请求已发但响应丢失当作未执行。

传输不承诺 exactly-once：响应丢失可能产生重复 span，稳定 ID 不保证每个平台都会去重。CLI 显式发送仅在全部批次被完整接受时返回成功，入队待发送/部分拒绝/预算耗尽返回非零及机器可读报告；HTTP 接受也不等于平台 UI 已索引。

flush/shutdown 有 deadline，超时保留队列并报告未发送数量；重试只涉及遥测请求，绝不重跑模型或工具。禁止 exporter 自身 HTTP 被 SDK/OTel 集成递归采集。

### 8.5 平台兼容验收

首版必须用固定版本的本地 OpenTelemetry Collector + debug/file exporter 跑真实端到端测试，证明发送的是有效 OTLP。提供可复制的 Collector 配置示例及自建后端接入说明，不部署生产服务。

为 Langtrace 和 Grafana 的 OTLP 接入编写配置指南；coding agent 实施时核对各自官方 endpoint、协议和鉴权要求。若后端不直接支持 JSON，则示例经 Collector 转换协议。兼容矩阵分别标注“本地验证”“依据官方文档”“云端实测”，不能把 Collector 验证当成所有厂商 UI 的实测。没有用户凭据不阻塞本地交付，不主动发送生产数据。

## 9. 任务拆分

| 编号 | 工作 | 依赖 | 验收 |
| --- | --- | --- | --- |
| CAP-01 | 协议审查、ADR、公共类型与能力矩阵 | 无 | 明确 hash、观察终态、版本、未知副作用 |
| CAP-02 | 协议扩展、兼容读取、查看和执行门禁 | CAP-01 | 旧夹具通过；观察快照可看不可执行 |
| CAP-03 | 通用包装、上下文、serializer、checkpoint | CAP-02 | 离线 Loop 无需 appendEvent |
| CAP-04 | 自动集成加载框架、抑制去重、故障策略 | CAP-03 | ESM/CJS、幂等卸载及共存测试通过 |
| CAP-05 | OpenAI/Anthropic 非流式及 stream:true | CAP-04 | 真实 SDK + 本地服务测试通过 |
| CAP-06 | OTLP 解析、profiles、来源与时间映射 | CAP-02 | 正常/未知/缺损 trace 有确定输出 |
| CAP-07 | import-otel CLI 和离线查看闭环 | CAP-06 | 多 trace 可导入、可看，执行被拒绝 |
| CAP-08 | 三类示例、文档、打包验证 | CAP-05、CAP-07 | tarball 消费者与质量门禁通过 |
| EXP-01 | exporter 接口、内容策略、DAG/span 映射 ADR | CAP-01 | 固化版本、损失报告、凭据和发送状态契约 |
| EXP-02 | 纯映射器和出站过滤、dry-run | CAP-02、EXP-01 | 原生/SDK/导入快照生成合法 OTLP，默认无正文泄露 |
| EXP-03 | OTLP HTTP 客户端、响应分类与有界重试 | EXP-02 | 本地服务验证鉴权、超时、partial_success 和重试规则 |
| EXP-04 | 有界持久化队列、恢复、锁与 flush/shutdown | EXP-03 | 中断可恢复，目标不串写，故障不影响业务 |
| EXP-05 | SDK 运行结束自动发送、CLI export/resume | CAP-03、CAP-04、EXP-04 | 两种实时入口及已有快照均可发送，业务不被重跑 |
| EXP-06 | Collector 端到端、平台指南、打包与回归 | CAP-08、EXP-05 | 本地完整验证、兼容矩阵、示例和 tarball 通过 |

**CAP-01 完成记录（2026-09-11）**

- 已新增 ADR-0004，冻结观察快照的来源、完整度、限制原因、观察终态、状态 hash 与执行门禁语义；
- `@agent-loop-snapshot/schema` 已导出公共观察元数据类型和保守的执行资格评估；该评估不构成授权，OTLP 导入固定为 observation-only；
- 持久化 schema、迁移、查看输出与实际执行门禁仍属于 CAP-02，尚未实现。

**CAP-02 完成记录（2026-09-11）**

- Snapshot 协议已升级到 `0.2.0`；新 manifest 持久化 `source`、`completeness` 与限制原因，`run.observed` / `otel.span` 用于不含可恢复状态的观察记录；
- `0.1.0` 夹具继续可读和校验，迁移以新目录输出 `0.2.0` 并补充原生来源元数据；`partial` / `unknown` 快照结构有效时保留为 warning；
- inspect 与图的文本/JSON 输出展示来源、完整度、限制和执行资格；CLI replay、Mock Replay、Verified Replay、Trace Compiler 均拒绝 observation-only 记录。

CAP-06 可在 CAP-02 后独立实施；可由单个 coding agent 顺序完成，不要求委派或创建外部任务。

## 10. 必要测试与交付标准

1. 包装：配对、类型/身份/this、原错误、序列化和脱敏、原函数只执行一次。
2. 并发：多 run 隔离、乱序、嵌套、未 await、提前失败、drain 超时、逃逸调用和资源关闭。
3. 故障：请求写失败、结果写失败、业务/记录同时失败，两种策略及完整度落盘。
4. SDK：支持版本边界、非支持版本诊断、真实 ESM/CJS 初始化、显式退路、重复安装/卸载和第三方共存。
5. 流：完整消费、取消、break、未消费、错误、超限及 usage 缺失，保证不提前读或重复请求。
6. 去重：双入口同调用不重复，合法相同参数调用和嵌套调用不丢失。
7. OTel：多 resource/scope/trace、输入乱序、64 位时间、缺父、links、环、重复冲突、未知语义、UNSET、采样、缺 payload、限额和恶意属性。
8. 兼容：旧快照、新观察快照的 validate/inspect/graph；全部 SDK/CLI 执行入口拒绝 observation-only，伪造能力不能绕过。
9. 三套离线示例及 tarball 安装验证，无真实 API key、付费请求和生产 trace；供应商测试使用本地服务。
10. 导出映射：事件配对、DAG 多父转 links、并行、稳定 ID、未知/失败状态、导入往返不提升执行能力。
11. 出站安全：默认无正文、内容模式再次脱敏、spool/日志无凭据或原始敏感 payload，dry-run 不联网。
12. 传输：本地 HTTP 服务覆盖完整接受、partial_success、429/Retry-After、鉴权拒绝、超时/响应丢失、取消和重定向；验证不重复执行业务。
13. 队列：容量/磁盘故障、崩溃恢复、多进程锁、配置变化、过期批次、deadline、未知送达状态及递归采集抑制。
14. 固定版本 Collector 真实接收，SDK 自动发送和 CLI 重发端到端测试；与已有 OTel provider/exporter 共存，关闭时互不影响。

检查根 tsconfig references、测试脚本、workspace、锁文件及 release smoke 显式包清单，纳入全部新包。保持 private、ESM、files 白名单。执行 pnpm run check 与 pnpm run release:verify，核对最终退出码，不把中途输出当完成；网络/权限阻断与代码失败分别报告并按环境规则处理。

更新 README：入口选择、可复制命令、模型/工具可见范围、支持版本、ESM/CJS/打包限制、流、故障模式、观察快照限制、外部平台配置及内容策略。交付 ADR、代码、测试、脱敏 fixtures、离线示例、Collector 示例、平台兼容矩阵及本计划完成状态；未完成的 SDK/导入/导出不能以“接口预留”算交付。

开始前读取适用 AGENTS.md、检查工作区，保留用户修改。历史对话示例可能遗漏事件配对/状态记录，必须以实际协议和测试为准。coding agent 获授权实现本计划及必要兼容修改，不要求发布、修改 private、推送或升级无关依赖。

## 11. 参考资料

- [Langtrace SDK 拦截源码](https://github.com/Scale3-Labs/langtrace-typescript-sdk/blob/main/src/instrumentation/openai/instrumentation.ts)：参考方法包装机制，不照搬版本范围。
- [Langtrace Quickstart](https://docs.langtrace.ai/quickstart)：参考初始化体验。
- [OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)：导入 JSON 编码与 trace 结构依据。
- [OpenTelemetry 语义约定](https://opentelemetry.io/docs/specs/semconv/)：实施时查找并固定 GenAI profile，不能假设不同厂商属性一致。
