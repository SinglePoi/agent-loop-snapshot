# 发布前 Code Review 与修复清单

审查日期：2026-09-07  
范围：ALS-001 至 ALS-503 当前实现及审查时的未提交改动；不包含规划中延期的 Viewer。  
文档整理时 HEAD：`cd51c7f`；已重新核对下述主要代码位置。  
最新复审日期：2026-09-07（首轮修复后）。  
最新结论：暂缓公开发布。首轮发现 5 项 P1、2 项 P2；复审确认 4 项可关闭。ALS-CR-002、ALS-CR-006 与 ALS-CR-007 均已补充修复，待二次复审。正式 `pnpm run release:verify` 已通过，并已覆盖含空格 Windows command launcher 的真实子进程补充场景。

本文供 coding agent 实施修复与补充回归测试。位置按审查时源码记录，后续修改以函数名和行为为准。问题编号 `ALS-CR-001` 至 `ALS-CR-007` 为本轮审查编号，不替代原实施计划编号。

## 当前复审状态

| 编号 | 复审结论 | 后续动作 |
| --- | --- | --- |
| ALS-CR-001 | 复审通过，可关闭 | 保留原型污染及合法状态操作回归测试 |
| ALS-CR-002 | 待二次复审，P1 | 已补充默认 reference 脱敏状态一致性、重复 checkpoint 与 Mock Replay 回归；见下文复审补充 |
| ALS-CR-003 | 复审通过，可关闭 | 保留强制审批、错配审批、策略拒绝与审计顺序测试 |
| ALS-CR-004 | 复审通过，可关闭 | 保留目录边界、链接及延迟读取检查测试 |
| ALS-CR-005 | 复审通过，可关闭 | 保留摘要、长度校验及回放失败诊断测试 |
| ALS-CR-006 | 待二次复审，P2 | 已改为显式栈祖先遍历，并加入 8,000 个中间事件长链回归；见下文复审补充 |
| ALS-CR-007 | 待二次复审，P2 | 已正确引用 Windows command launcher，并加入含空格路径的真实子进程测试；见下文复审补充 |

以下各项保留首轮问题描述和验收要求，历史复现不表示原始缺陷仍全部存在。最新结论以本表、各项状态和文末“首轮修复后复审”记录为准。“可关闭”仅指本轮检查范围内的修复通过，不代表公开发布已获批准。

## 执行约束与完成标准

- 修复以下问题并补充针对真实失败路径的回归测试，保留现有用户改动。
- 不移除任何包的 `private` 标志，不修改正式 scope/registry，不配置发布凭据，不执行发布。
- 测试应先能复现原缺陷，再验证修复；同时覆盖合法输入，避免用全面拒绝功能的方式消除问题。
- 修复完成后更新本文每项状态，记录修改文件、验证命令和结果；未完成项保留明确说明。
- 最终执行 `pnpm run release:verify`。仅单独执行 smoke 脚本成功，不等于正式发布入口通过。
- 完成后交回复审，由产品/发布负责人另行作出发布决策。

下一轮建议顺序：对 ALS-CR-002、ALS-CR-006、ALS-CR-007 进行二次复审。保留已通过项的修复与测试；每项新增修改均应有独立可追溯的修复与验证记录。

## ALS-CR-001 — P1：状态重建允许原型污染

状态：复审通过，可关闭（2026-09-07）。危险路径、自有属性访问及状态操作回归在本轮检查范围内通过。

**位置**：`packages/recorder/src/checkpoints.ts:158`，`getContainerValue()`；同时检查 `parentAtPath()`、`containerAtPath()`、`setContainerValue()` 等状态路径读写函数。

**原因与影响**：对象路径通过 `container[segment]` 读取继承属性，路径遍历可进入 `Object.prototype`。不可信快照的状态事件能够修改进程级原型，影响后续对象读取。

**已复现步骤**：

1. 用 Recorder 创建运行并追加 `state.changed`，payload 为 `{ operation: 'set', path: '/__proto__/als_review_probe', value: 'polluted' }`。
2. 调用 `reconstructState(recorder.getEvents(run))`。
3. 读取普通空对象的 `als_review_probe`，结果为 `polluted`，而重建 state 仍为 `{}`。

**修复要求**：路径遍历只允许访问自有属性；安全处理危险路径及属性写入，避免原型访问或修改。审计 set、merge、append、delete 的共享路径逻辑。应明确危险键的拒绝或安全存储语义。

**回归测试验收**：

- 上述路径不能污染 `Object.prototype`，不应产生静默成功的危险写入。
- 覆盖 `__proto__`、`constructor`、`prototype` 相关路径和包含危险键的对象值。
- 覆盖合法嵌套对象、数组及 JSON Pointer 转义；原有状态重建行为继续通过。
- 原型污染复现测试使用隔离子进程或可靠清理，避免污染测试执行器。

## ALS-CR-002 — P1：Checkpoint 绕过脱敏流水线

状态：已补充修复，待二次复审（P1）。原始明文落盘问题已改善；本轮补充默认 reference 脱敏状态一致性、重复 checkpoint 与实际 Mock Replay 回归，详见文末复审补充及第二次交付记录。

**位置**：`packages/recorder/src/index.ts:392`，`Recorder.checkpoint()`；关联 `packages/recorder/src/redaction.ts` 的 `RedactionPipeline.asInterceptor()` 和 `packages/recorder/src/writer.ts` 的 `SnapshotWriter.asInterceptor()`。

**原因与影响**：checkpoint 直接使用 `input.state`，默认脱敏拦截器仅转换事件 payload。checkpoint.created 事件不包含完整 state，因此对事件的脱敏不会保护实际 checkpoint 文件。

**已复现步骤**：

1. 配置拦截器 `[createDefaultRedactionPipeline().asInterceptor(), writer.asInterceptor()]`。
2. 调用 `checkpoint()`，state 为 `{ api_key: 'sk-reviewsecret123456789' }`，stateHash 为该原始 state 的哈希。
3. 完成运行并提交、关闭 writer。
4. `checkpoints/000001.json` 仍包含完整测试密钥。这里的字符串是人工测试值，不是真实凭据。

**修复要求**：在 checkpoint 持久化前执行适用的脱敏逻辑，保证 checkpoint 的实际 state、state_hash 和对应事件引用一致。明确与事件重建、恢复状态及 artifact-backed state 的关系，避免修复后因哈希不一致而无法恢复。

**回归测试验收**：

- 通过真实 Recorder + RedactionPipeline + SnapshotWriter 写盘，断言原始测试密钥不存在于 checkpoint 文件。
- 覆盖嵌套字段、数组及自定义字段规则；验证内存 checkpoint 和磁盘 checkpoint 的一致性。
- 从保存后的 checkpoint 恢复成功，哈希匹配；与脱敏后事件流重建结果一致。
- artifact-backed checkpoint 不应被误当普通对象处理，相关引用与脱敏边界有明确测试。

## ALS-CR-003 — P1：工作流声明的审批要求未被执行

状态：复审通过，可关闭（2026-09-07）。显式审批要求、有效/错配审批和策略 deny 优先级在本轮检查范围内通过。

**位置**：`packages/replay/src/semantic.ts:507`，`SemanticReplayRunner.executeNode()`；关联 `packages/replay/src/policy.ts`。

**原因与影响**：执行前策略动作只纳入副作用等级，没有落实 `node.permissions.requires_approval`。只读操作默认允许，因此工作流显式要求的审批可以被跳过。

**已复现步骤**：

1. 创建合法 Workflow IR，包含一个 `human_approval` 节点，设置 `permissions: { side_effect: 'read_only', requires_approval: true }`。
2. 配置具有 `agent.execute` 能力、声明 read_only 的 adapter，其 execute 返回 completed。
3. 不提供 `approvalForAction`，以默认策略执行。
4. adapter 被调用 1 次，运行状态为 completed，diagnostics 为空。

**修复要求**：显式审批要求必须成为执行前的强制条件，不能仅依赖副作用默认策略。审批必须匹配当前动作，策略 deny 仍应阻止执行；明确 human_approval 节点语义。不得从历史 Trace 自动继承授权。

**回归测试验收**：

- `requires_approval: true` 的只读节点在无审批或审批不匹配时不调用 adapter。
- 当前动作获得有效审批、且其他策略允许时可执行；策略 deny 不因审批而被绕过。
- 对 human_approval 及其他带审批要求的节点验证同一规则。
- 新 Replay Trace 在 adapter 执行前记录实际审批/阻止决策。

## ALS-CR-004 — P1：Artifact 目录链接可绕过读取边界

状态：复审通过，可关闭（2026-09-07）。共享读取边界检查及加载后替换链接的回归在本轮检查范围内通过。

**位置**：`packages/trace/src/index.ts:561`，`loadArtifactMetadata()`；同类问题位于 `packages/schema/src/validator.ts:753` 的 artifact 文件校验。

**原因与影响**：`lstat(artifactPath).isFile()` 只检查末级文件，不能拒绝祖先目录中的链接。快照的 artifacts 目录可以指向快照外部，破坏文档声明的快照目录读取边界。

**已复现步骤**：

1. 在测试临时目录中创建 source 和 external 两个目录。
2. 将 source/artifacts 创建为指向 external 的 Windows junction。
3. 在 external 写入内容为 `"good"` 的文件，文件名为其 SHA-256 对应的 `sha256-<digest>`。
4. source 的合法运行输入包含该 artifact 引用，byte_length 为 6。
5. `validateSnapshotDirectory(source).valid` 和 `loadTraceSnapshot(source).valid` 均为 true；`readArtifact()` 成功返回外部文件内容。

**修复要求**：同时处理目录链与最终文件的可信性，验证真实目标位于所选快照边界内。统一 Loader 与 Validator 的规则，检查 manifest、checkpoint 等其他读取入口是否也遵循已声明的链接策略。延迟读取不能只依赖加载时缓存的判断。

**回归测试验收**：

- Windows junction 和支持平台上的目录 symlink 均不能将 artifact 读取引向边界外。
- 最终文件 symlink、其他特殊文件及正常快照内普通文件均有测试。
- 加载后将 artifact 路径替换为目录外链接，再调用 readArtifact，也不能读取目录外内容。
- 测试仅使用自行创建的临时文件，不访问真实用户私密文件。

## ALS-CR-005 — P1：回放接受被篡改的 Artifact

状态：复审通过，可关闭（2026-09-07）。按需读取的摘要/长度检查，以及 Mock/Verified Replay 和 checkpoint artifact 的相关失败路径在本轮检查范围内通过。

**位置**：`packages/trace/src/index.ts:766`，`readArtifact()`；关联 `packages/replay/src/mock.ts` 的 artifact 物化、源状态重建和最终状态比较。

**原因与影响**：Loader 仅检查 artifact 大小，readArtifact 不核验 SHA-256。独立 Validator 能发现摘要不匹配，但 Replay 使用 Loader 的 valid 标志，未获得同等内容完整性保护。

**已复现步骤**：

1. 以 `JSON.stringify({ operation: 'set', path: '/answer', value: 'good' })` 的 UTF-8 字节计算 digest 和 byte_length。
2. 让 `state.changed` 的整个 payload 为这个 JSON artifact 的引用，并记录原始最终状态 `{ answer: 'good' }` 的哈希。
3. 保留文件名、引用和长度，将 artifact 内容中的 good 替换为 evil。
4. `validateSnapshotDirectory()` 返回 invalid，但 `loadTraceSnapshot()` 仍为 valid，readArtifact 返回被修改内容。
5. MockReplayRunner 返回 `status: completed`、`finalState: { answer: 'evil' }`，diagnostics 为空。

**修复要求**：在 artifact 内容被物化或交给回放消费之前核验摘要与长度，并落实读取时大小限制。保留 Loader 的按需读取能力，不要求加载阶段一次性读取全部 artifact。失败须以可诊断方式阻止回放成功，不应继续消费损坏内容。

**回归测试验收**：

- 同长度篡改必须被 readArtifact 拒绝；合法内容继续可读。
- 加载后再修改文件内容或增大文件，读取时仍能发现问题。
- 上述 artifact-backed state 的 Mock Replay 不能返回成功或接受 evil 状态。
- 覆盖依赖同一读取入口的 checkpoint 恢复及 Verified Replay，保证完整性规则一致。

## ALS-CR-006 — P2：编译器丢失跨中间事件的因果依赖

状态：已补充修复，待二次复审（P2）。祖先回溯已改为显式栈；真实 Recorder 写盘、重新加载后的 8,000 个合法中间事件长链可完成编译，B 正确依赖 A，详见文末复审补充和第二次交付记录。

**位置**：`packages/replay/src/compiler.ts:179`，`requestParentDependencies()`；关联 `sourceNodeByEventId` 的构建。

**原因与影响**：依赖查找仅查看请求的直接父事件，而事件到工作流节点的映射仅包含调用请求和响应。中间存在 state.changed、decision.recorded 等非调用事件时，调用间因果依赖被丢弃。

**已复现步骤**：

1. 用 Recorder 构造合法串行链：run.started → A.requested → A.completed → state.changed → B.requested → B.completed → run.completed。
2. 经 loadTraceSnapshot 加载，确认 valid 为 true。
3. 调用 compileTraceToWorkflow。
4. 生成的 A、B 节点的 depends_on 均为 `[]`，且无诊断。

**修复要求**：沿未映射为工作流节点的中间事件追溯调用祖先，保留必要的依赖并去重；不能把真实并行分支错误地串行化，也不能产生节点对自身的依赖。

**回归测试验收**：

- 上述链编译后 B 依赖 A。
- 覆盖多层中间事件、多父节点汇合、并行分支和重试合并。
- 编译后的 Workflow IR 仍通过校验，依赖及 provenance 输出稳定。

## ALS-CR-007 — P2：正式发布门禁无法启动独立版 pnpm

状态：已补充修复，待二次复审（P2）。Windows command launcher 现在将启动器和参数编码为一个正确引用的 `cmd.exe /d /s /c` 命令，并仅为该分支启用原样参数传递；真实含空格 `.cmd` 启动器与参数回归通过，详见文末复审补充和第二次交付记录。

**位置**：`scripts/release-smoke.js:12` 至 `:23`，`pnpmCommand` 与 `runPnpm()`。

**原因与影响**：脚本假设非空 npm_execpath 是 JavaScript 入口，一律通过 process.execPath（node）运行。当前 pnpm 11.19.0 的入口是原生 pnpm.exe，导致文档要求的发布命令失败。

**已复现步骤**：

1. 在 Node.js 24.20.0、pnpm 11.19.0 环境执行 `pnpm run release:verify`。
2. 质量检查与 pack:check 通过。
3. smoke 尝试执行 `node.exe <npm_execpath 指向的 pnpm.exe> ...`。
4. Node 报 `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".exe"`，整个 release:verify 退出码为 1。

**修复要求**：区分原生可执行入口与 JavaScript 入口，采用正确的启动方式；同时支持 npm_execpath 缺失时的可靠回退。不要为了绕过缺陷而更改项目已锁定的包管理器版本或跳过 smoke。

**回归测试验收**：

- 覆盖 JavaScript pnpm 入口、原生 pnpm.exe 入口、缺失 npm_execpath 的命令构造。
- 覆盖含空格的路径，避免引入 shell 字符串拼接问题。
- 在项目锁定版本下通过正式 `pnpm run release:verify`，并确认临时消费者安装、validate、graph、Mock Replay 实际执行。

## 首轮审查验证记录（修复前，历史）

- Node.js：24.20.0；正式发布入口使用 pnpm 11.19.0。
- 类型检查、ESLint、Prettier：通过。首次沙箱内 lint 因依赖读取权限失败；沙箱外重跑通过，不作为代码缺陷。
- 自动化测试：77 passed，0 failed。
- `pnpm run pack:check`：通过。
- 单独运行 `node scripts/release-smoke.js`：通过；该路径实际回退使用 pnpm 12.3.4，不能替代锁定版本正式入口的验收。
- `pnpm run release:verify`：失败，原因见 ALS-CR-007；是在解除沙箱限制后仍可复现的脚本问题。
- 本轮仅审查与复现，未修复产品代码；临时复现脚本已清理。现有测试通过不代表上述缺陷已被覆盖。

## 首次修复交付记录（coding agent 原始报告，历史）

下表及随后的交付结论保留 coding agent 首次交付时的报告，包括当时的“待复审”状态；不作为最新复审结论。当前状态见文首表格，下一轮交付请填写文末记录表。

| 编号 | 状态 | 修改文件/提交 | 回归测试及结果 |
| --- | --- | --- | --- |
| ALS-CR-001 | 已修复，待复审 | `packages/recorder/src/checkpoints.ts`、`packages/recorder/src/checkpoints.test.ts` | 隔离子进程原型污染回归、危险路径和值、合法嵌套数组及 JSON Pointer 覆盖；`pnpm test` 通过（84 passed），`pnpm format:check` 与 `git diff --check` 通过。 |
| ALS-CR-002 | 已修复，待复审 | `packages/recorder/src/index.ts`、`packages/recorder/src/redaction.ts`、`packages/recorder/src/redaction.test.ts` | 真实 Recorder + RedactionPipeline + SnapshotWriter 写盘与恢复、嵌套/数组/自定义规则、artifact-backed checkpoint 边界覆盖；`pnpm test` 通过（84 passed），`pnpm format:check` 与 `git diff --check` 通过。 |
| ALS-CR-003 | 已修复，待复审 | `packages/replay/src/policy.ts`、`packages/replay/src/semantic.ts`、`packages/replay/src/index.test.ts` | 覆盖无审批、错配审批、有效当前审批、显式策略拒绝，以及 human_approval 与普通节点；断言策略决定在 adapter 执行前写入新 Replay Trace。`pnpm test` 通过（86 passed），`pnpm format:check` 与 `git diff --check` 通过。 |
| ALS-CR-004 | 已修复，待复审 | `packages/schema/src/snapshot-path.ts`、`packages/schema/src/index.ts`、`packages/schema/src/validator.ts`、`packages/trace/src/index.ts`、`packages/trace/src/index.test.ts` | Loader 与 Validator 共用真实路径边界校验；覆盖 Windows junction/目录 symlink、checkpoint 目录链接、加载后替换链接、普通文件及非普通条目。`pnpm test` 通过（89 passed，1 skipped：当前 Windows 配置不允许文件 symlink），`pnpm format:check` 与 `git diff --check` 通过。 |
| ALS-CR-005 | 已修复，待复审 | `packages/trace/src/index.ts`、`packages/trace/src/index.test.ts`、`packages/replay/src/mock.ts`、`packages/replay/src/verified.ts`、`packages/replay/src/index.test.ts` | `readArtifact()` 保持按需读取，并在每次物化前重验当前字节长度与 SHA-256；Mock/Verified Replay 将受损 artifact 转为失败诊断，checkpoint artifact 也按同一规则处理。覆盖有效读取、加载后同长度替换、加载后增大、Mock/Verified 状态 artifact、checkpoint 恢复；`pnpm test` 通过（92 passed，1 skipped：当前 Windows 配置不允许文件 symlink），`pnpm format:check` 与 `git diff --check` 通过。 |
| ALS-CR-006 | 已修复，待复审 | `packages/replay/src/compiler.ts`、`packages/replay/src/index.test.ts` | 编译器会跨未映射的中间事件递归回溯调用祖先，收集、去重并稳定排序依赖；已映射节点即停止回溯，避免重试组自依赖与并行分支被按序串行化。覆盖多层中间事件、双父汇合、并行分支、重试合并及 Workflow IR 校验；`pnpm test` 通过（94 passed，1 skipped：当前 Windows 配置不允许文件 symlink），`pnpm format:check` 与 `git diff --check` 通过。 |
| ALS-CR-007 | 已修复，待复审 | `scripts/release-smoke.js`、`scripts/release-smoke.test.js`、`package.json` | pnpm 调用构造会区分 JavaScript 启动器、原生可执行文件与 Windows command launcher；缺失 `npm_execpath` 时使用 PATH 回退，所有参数保持数组传递。覆盖含空格的 JS/.exe 路径、Windows `.cmd` 及缺失/空 `npm_execpath`；正式 `pnpm run release:verify` 通过（99 passed，0 skipped），并完成临时消费者安装、validate、graph、Mock Replay。 |

首次交付者报告（复审前）：Node.js 24.20.0、pnpm 11.19.0；`pnpm run release:verify` 通过。质量门禁、打包检查和 release smoke 均已执行；临时消费者从生成的本地 tarball 安装后，validate、graph、Mock Replay 均通过。交付者当时报告未发现未解决问题；复审随后发现以下三项遗漏。

## 首轮修复后复审（2026-09-07）

范围：对照七项清单检查修复代码与新增测试，并进行补充复现。复审期间未修改产品代码。

### ALS-CR-002 复审补充 — P1：默认脱敏破坏状态一致性

**位置**：`packages/recorder/src/redaction.ts:638`，`RedactionPipeline.redactCheckpoint()`；关联同文件 `placeholder()` 中 reference 策略的随机 UUID 生成。

**原因与影响**：checkpoint 对原始 state 再次独立脱敏。默认 reference 策略每次生成新的 UUID，因此同一密钥在事件流和 checkpoint 中形成不同占位符，重建出的状态哈希不同。真实快照即使通过 Loader 校验，Mock Replay 仍可能失败。

**补充复现**：

1. 使用默认 `createDefaultRedactionPipeline()` 和真实 SnapshotWriter。
2. 创建运行，追加 `state.changed`，payload 为 `{ operation: 'set', path: '/value', value: 'sk-reviewsecret123456789' }`。该值为人工测试字符串。
3. 调用 `checkpoint()`，state 为 `{ value: 'sk-reviewsecret123456789' }`，传入该原始 state 的哈希。
4. 对比从事件流重建和从 checkpoint 重建的状态，两者 reference 占位符及哈希不同。
5. 完成运行、提交并关闭 writer，再通过 loadTraceSnapshot 加载并用新 Recorder 执行 MockReplayRunner。
6. 实际结果：源 Trace `valid=true`，回放 `status=failed`，诊断为 `FINAL_STATE_MISMATCH`。

**现有测试缺口**：新增一致性测试使用固定 `mask` 占位符及自定义规则；默认流水线的写盘测试仅验证 checkpoint 自身哈希与恢复，没有证明其与事件流或实际 Mock Replay 一致。

**后续修复要求**：让 checkpoint 与事件流使用一致的脱敏状态表示，并明确已脱敏值的处理语义。不得通过关闭脱敏、恢复明文或移除一致性比较绕过问题。

**补充验收**：

- 使用未定制的默认 pipeline，验证从事件流、checkpoint 重建的状态与哈希一致。
- 测试必须真实写盘、重新加载并执行 Mock Replay，断言正常完成且无 `FINAL_STATE_MISMATCH`。
- 覆盖同一运行内重复 checkpoint 和已脱敏状态输入，确保再次处理不会改变已建立的状态身份。
- 保留密钥不落盘及自定义 mask/remove 等规则的原有测试。

### ALS-CR-006 复审补充 — P2：长链祖先回溯栈溢出

**位置**：`packages/replay/src/compiler.ts:194`，`requestParentDependencies()` 内部 `visitAncestor()`。

**原因与影响**：新增祖先遍历通过同步递归调用实现，每个未映射的中间事件都会增加调用栈深度。合法长链可以触发未捕获的 RangeError，无法生成 Workflow IR。

**补充复现**：

1. 构造合法事件链：run.started → A.requested → A.completed → 8,000 个 decision.recorded → B.requested → B.completed → run.completed。
2. 每个中间事件以此前事件为唯一 parent，并使用合法 payload，例如 `{ decision: 'continue', basis_summary: 'review', success_conditions: ['continue'] }`。
3. 保证 ID 唯一、sequence 连续，并同步 manifest 的 root_event_id、event_count 和 last_sequence。
4. 约 3.7 MB 的事件输入通过 `validateSnapshot()`，无诊断。
5. `compileTraceToWorkflow()` 抛出 `RangeError: Maximum call stack size exceeded`。

**现有测试缺口**：仅覆盖少量中间事件、汇合和重试，没有长链输入测试。

**后续修复要求**：使用显式栈或队列进行祖先遍历，避免以 JavaScript 调用栈深度限制合法 Trace；保留 visited 去重、已映射节点停止回溯、自依赖排除及稳定排序。

**补充验收**：

- 上述 8,000 个中间事件的输入可完成编译，B 正确依赖 A，生成的 Workflow IR 校验通过。
- 现有短链、并行、汇合、重试合并及 provenance 测试继续通过。
- 不通过截断祖先链或静默省略依赖来避免栈溢出。

### ALS-CR-007 复审补充 — P2：含空格的 CMD 启动路径失败

**位置**：`scripts/release-smoke.js:24` 至 `:29`，`resolvePnpmInvocation()` 的 Windows command launcher 分支。

**原因与影响**：将参数数组传给 `cmd.exe /d /s /c` 不等于其后命令字符串一定被正确引用。`.cmd` 路径含空格时，当前启动方式将路径拆成错误命令。原生 pnpm.exe 路径的正式门禁成功不能覆盖这个分支。

**补充复现**：

1. 调用 `resolvePnpmInvocation({ pnpmEntry: 'C:/Program Files/nodejs/pnpm.cmd' })`；已确认本机该文件存在。
2. 按生产逻辑执行 `spawnSync(invocation.command, [...invocation.argsPrefix, '--version'], { encoding: 'utf8' })`。
3. 实际退出码为 1，stderr 为 `'C:/Program' is not recognized as an internal or external command, operable program or batch file.`。

**现有测试缺口**：`scripts/release-smoke.test.js` 对 command launcher 仅断言生成的参数数组，没有实际启动含空格路径的子进程。

**后续修复要求**：正确处理 Windows command launcher 的命令引用和参数传递，或使用经过验证的可执行入口解析方式。保留原生 executable 与 JavaScript launcher 已通过的行为，避免不安全的 shell 字符串拼接。

**补充验收**：

- 在含空格的临时目录放置可控 `.cmd` 测试入口，并通过与生产相同的逻辑真实启动，断言退出码和收到的参数。
- 覆盖可执行路径和参数中的空格，以及 Windows launcher、原生 executable、JavaScript launcher 和缺失 npm_execpath 的相关分支。
- 正式 `pnpm run release:verify` 继续通过，且临时消费者的 validate、graph、Mock Replay 实际执行。

### 复审验证与发布结论

- Node.js 24.20.0、pnpm 11.19.0 下，正式 `pnpm run release:verify` 通过，包含质量检查、测试、打包及临时消费者安装 smoke。
- 首次沙箱内执行仍遇到依赖读取限制；在沙箱外重跑通过，该环境问题不作为未修复项。
- `git diff --check` 通过；上述三个补充失败场景均独立复现，未纳入现有门禁覆盖。
- ALS-CR-001、003、004、005 在本轮检查范围内可关闭。
- ALS-CR-002、006、007 保持未关闭；建议完成补充修复及回归测试后再次复审，暂缓公开发布。

## 第二次修复交付记录（待 coding agent 填写）

| 编号 | 当前状态 | 新增修改文件/提交 | 补充回归测试与验证结果 |
| --- | --- | --- | --- |
| ALS-CR-002 | 已补充修复，待二次复审 | `packages/recorder/src/redaction.ts`、`packages/replay/src/index.test.ts` | reference 策略在同一 pipeline 内为相同类别与原始值复用内存中的随机标识，并保留已脱敏占位符。真实写盘/重新加载回归覆盖默认规则、事件流与 checkpoint 双路径恢复、重复原始及已脱敏 checkpoint、Mock Replay 和密钥不落盘；`pnpm run release:verify` 通过（100 passed，0 skipped）。 |
| ALS-CR-006 | 已补充修复，待二次复审 | `packages/replay/src/compiler.ts`、`packages/replay/src/index.test.ts` | 将祖先回溯从同步递归改为显式栈，保留每个请求的 visited 去重、已映射节点停止回溯、自依赖排除和依赖稳定排序。真实 Recorder 写盘/重新加载回归构造 8,000 个 `decision.recorded` 中间事件，断言 B 依赖 A 且 Workflow IR 校验通过；短链、并行、汇合和重试合并回归继续通过；`pnpm run release:verify` 通过（101 passed，0 skipped）。 |
| ALS-CR-007 | 已补充修复，待二次复审 | `scripts/release-smoke.js`、`scripts/release-smoke.test.js` | Windows command launcher 由专用引用函数构造单个 `cmd.exe /d /s /c` 命令，并配合 `windowsVerbatimArguments` 保留其边界；JS、原生可执行文件及缺失 `npm_execpath` 分支继续按参数数组调用。真实子进程回归在含空格临时目录创建可控 `.cmd`，断言退出成功且收到含空格参数；`pnpm run release:verify` 通过（102 passed，0 skipped）。 |

下一轮正式门禁命令、环境、结果及残留问题：Node.js 24.20.0、pnpm 11.19.0；`pnpm run release:verify` 通过（102 passed，0 skipped），已执行质量门禁、打包检查与临时消费者的 validate、graph、Mock Replay。残留问题：ALS-CR-002、ALS-CR-006、ALS-CR-007 均待二次复审。完成后应同步更新文首状态表和各项状态，保留历史记录。
