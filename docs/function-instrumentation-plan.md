# 低侵入采集与 OpenTelemetry 导入开发计划

更新时间：2026-09-09。状态：待实现，交给 coding agent 执行。

本文替代原函数包装计划，保留文件路径。所有新增 API、命令和能力均为待实现目标，不能按已实现功能宣传。

## 1. 目标与交付边界

用户无需逐次调用 appendEvent，便可获得可查看的 Agent 运行快照。交付三条入口：

| 入口 | 用户操作 | 本次交付 |
| --- | --- | --- |
| 通用函数包装 | 一次注册模型与工具异步函数 | instrument、run、可选 checkpoint |
| 常用 SDK 自动集成 | 初始化一次，继续调用原 SDK | Node.js OpenAI、Anthropic 专用集成 |
| 现有 OpenTelemetry traces | 导入标准 OTLP JSON | SDK 导入器、CLI、可查看快照 |

自动集成在用户进程内工作，不要求请求经过本项目服务器；仍需初始化入口，不能穿透远程黑盒 Agent。自定义工具通过通用包装记录，不能把模型生成的 tool-call 声明当成工具实际执行。

三条入口均为本计划的必交付项。OTel“接收”首版落实为离线文件/内存导入；实时 exporter 桥接、常驻 HTTP/gRPC 接收器、Collector 部署为后续方向。本次不实现 Python、框架插件、网络抓包、任意对象 Proxy、自动重试、自动变量采集、自动恢复调用栈、Web Viewer 或 npm 发布。

## 2. 架构和包划分

```text
函数包装 ───────┐
SDK 自动集成 ───┴─ 运行上下文 / 规范化 / 脱敏 ── Recorder / Writer
OTLP JSON ── span 解析 / 来源映射 / 脱敏 ── 导入快照构建器

版本化快照 ── validate / inspect / graph
           └─ 完整性与能力检查 ── replay / compile / resume
```

- `packages/instrumentation`：通用包装、运行生命周期、异步上下文、序列化、诊断和扩展接口。
- `packages/instrumentation-openai`、`packages/instrumentation-anthropic`：可选供应商集成，隔离依赖。
- `packages/otel-import`：OTLP 解析、映射 profile、历史快照构建和导入报告。
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

## 8. 任务拆分

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

CAP-06 可在 CAP-02 后独立实施；可由单个 coding agent 顺序完成，不要求委派或创建外部任务。

## 9. 必要测试与交付标准

1. 包装：配对、类型/身份/this、原错误、序列化和脱敏、原函数只执行一次。
2. 并发：多 run 隔离、乱序、嵌套、未 await、提前失败、drain 超时、逃逸调用和资源关闭。
3. 故障：请求写失败、结果写失败、业务/记录同时失败，两种策略及完整度落盘。
4. SDK：支持版本边界、非支持版本诊断、真实 ESM/CJS 初始化、显式退路、重复安装/卸载和第三方共存。
5. 流：完整消费、取消、break、未消费、错误、超限及 usage 缺失，保证不提前读或重复请求。
6. 去重：双入口同调用不重复，合法相同参数调用和嵌套调用不丢失。
7. OTel：多 resource/scope/trace、输入乱序、64 位时间、缺父、links、环、重复冲突、未知语义、UNSET、采样、缺 payload、限额和恶意属性。
8. 兼容：旧快照、新观察快照的 validate/inspect/graph；全部 SDK/CLI 执行入口拒绝 observation-only，伪造能力不能绕过。
9. 三套离线示例及 tarball 安装验证，无真实 API key、付费请求和生产 trace；供应商测试使用本地服务。

检查根 tsconfig references、测试脚本、workspace、锁文件及 release smoke 显式包清单，纳入全部新包。保持 private、ESM、files 白名单。执行 pnpm run check 与 pnpm run release:verify，核对最终退出码，不把中途输出当完成；网络/权限阻断与代码失败分别报告并按环境规则处理。

更新 README：入口选择、可复制命令、模型/工具可见范围、支持版本、ESM/CJS/打包限制、流、故障模式和观察快照限制。交付 ADR、代码、测试、脱敏 fixtures、离线示例及本计划完成状态；未完成的 SDK/导入不能以“接口预留”算交付。

开始前读取适用 AGENTS.md、检查工作区，保留用户修改。历史对话示例可能遗漏事件配对/状态记录，必须以实际协议和测试为准。coding agent 获授权实现本计划及必要兼容修改，不要求发布、修改 private、推送或升级无关依赖。

## 10. 参考资料

- [Langtrace SDK 拦截源码](https://github.com/Scale3-Labs/langtrace-typescript-sdk/blob/main/src/instrumentation/openai/instrumentation.ts)：参考方法包装机制，不照搬版本范围。
- [Langtrace Quickstart](https://docs.langtrace.ai/quickstart)：参考初始化体验。
- [OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)：导入 JSON 编码与 trace 结构依据。
- [OpenTelemetry 语义约定](https://opentelemetry.io/docs/specs/semconv/)：实施时查找并固定 GenAI profile，不能假设不同厂商属性一致。
