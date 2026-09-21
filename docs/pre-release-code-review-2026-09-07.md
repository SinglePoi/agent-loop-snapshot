# 发布前 Code Review 与修复清单

审查日期：2026-09-07  
范围：ALS-001 至 ALS-503 当前实现及审查时的未提交改动；不包含规划中延期的 Viewer。  
文档整理时 HEAD：`cd51c7f`；已重新核对下述主要代码位置。  
最新更新：2026-09-08，用户将 ALS-CR-002 标记为“暂时完成，下次检查”；基线为 `a09106a` 加现有工作区改动。

最新结论：其余六项维持可关闭；ALS-CR-002 标记为“暂时完成，下次检查”。此前修复及回归记录保留；最近复查发现的全局自定义规则上下文和扩展事件类型边界，留待下次检查处理。发布仍由负责人另行决策。

本文供 coding agent 实施修复与补充回归测试。位置按审查时源码记录，后续修改以函数名和行为为准。问题编号 `ALS-CR-001` 至 `ALS-CR-007` 为本轮审查编号，不替代原实施计划编号。

## 当前复审状态

| 编号 | 复审结论 | 后续动作 |
| --- | --- | --- |
| ALS-CR-001 | 复审通过，可关闭 | 保留原型污染及合法状态操作回归测试 |
| ALS-CR-002 | 暂时完成，下次检查 | 下次优先复核全局 custom redactor 与协议字段隔离的交互，以及任意扩展事件类型在脱敏流水线中的边界；保留既有真实写盘和状态等价组合测试 |
| ALS-CR-003 | 复审通过，可关闭 | 保留强制审批、错配审批、策略拒绝与审计顺序测试 |
| ALS-CR-004 | 复审通过，可关闭 | 保留目录边界、链接及延迟读取检查测试 |
| ALS-CR-005 | 复审通过，可关闭 | 保留摘要、长度校验及回放失败诊断测试 |
| ALS-CR-006 | 二次复审通过，可关闭 | 保留显式栈遍历、8,000 个中间事件长链及已有依赖语义回归 |
| ALS-CR-007 | 二次复审通过，可关闭 | 保留含空格路径真实子进程测试及正式 release:verify |

以下各项保留首轮问题描述和验收要求，历史复现不表示原始缺陷仍全部存在。最新结论以本表和文末最新状态记录为准。“暂时完成，下次检查”表示当前工作在此处停留，不代表公开发布已获批准。

## 执行约束与完成标准

- 修复以下问题并补充针对真实失败路径的回归测试，保留现有用户改动。
- 不移除任何包的 `private` 标志，不修改正式 scope/registry，不配置发布凭据，不执行发布。
- 测试应先能复现原缺陷，再验证修复；同时覆盖合法输入，避免用全面拒绝功能的方式消除问题。
- 修复完成后更新本文每项状态，记录修改文件、验证命令和结果；未完成项保留明确说明。
- 最终执行 `pnpm run release:verify`。仅单独执行 smoke 脚本成功，不等于正式发布入口通过。
- 完成后交回复审，由产品/发布负责人另行作出发布决策。

后续对直接修复及新增错误处理边界进行最终复核，保留已通过六项的修复与测试；不移除 private 标志或自动发布。

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

状态：暂时完成，下次检查（2026-09-08）。此前修复、测试和兼容边界记录保留；最近复查发现的待处理边界见文末最新状态记录。

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

状态：二次复审通过，可关闭（2026-09-08）。显式栈遍历及 8,000 个合法中间事件长链回归通过，B 正确依赖 A；本轮未发现相关回归。

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

状态：二次复审通过，可关闭（2026-09-08）。含空格 `.cmd` 路径可实际启动；真实子进程回归和锁定版本下的正式 release:verify 通过，本轮未发现相关回归。

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

## 第二次修复交付记录（coding agent 原始报告，历史）

以下保留第二次交付时的状态和验证结果；当前结论见文首状态表及随后的二次复审记录。

| 编号 | 当前状态 | 新增修改文件/提交 | 补充回归测试与验证结果 |
| --- | --- | --- | --- |
| ALS-CR-002 | 已补充修复，待二次复审 | `packages/recorder/src/redaction.ts`、`packages/replay/src/index.test.ts` | reference 策略在同一 pipeline 内为相同类别与原始值复用内存中的随机标识，并保留已脱敏占位符。真实写盘/重新加载回归覆盖默认规则、事件流与 checkpoint 双路径恢复、重复原始及已脱敏 checkpoint、Mock Replay 和密钥不落盘；`pnpm run release:verify` 通过（100 passed，0 skipped）。 |
| ALS-CR-006 | 已补充修复，待二次复审 | `packages/replay/src/compiler.ts`、`packages/replay/src/index.test.ts` | 将祖先回溯从同步递归改为显式栈，保留每个请求的 visited 去重、已映射节点停止回溯、自依赖排除和依赖稳定排序。真实 Recorder 写盘/重新加载回归构造 8,000 个 `decision.recorded` 中间事件，断言 B 依赖 A 且 Workflow IR 校验通过；短链、并行、汇合和重试合并回归继续通过；`pnpm run release:verify` 通过（101 passed，0 skipped）。 |
| ALS-CR-007 | 已补充修复，待二次复审 | `scripts/release-smoke.js`、`scripts/release-smoke.test.js` | Windows command launcher 由专用引用函数构造单个 `cmd.exe /d /s /c` 命令，并配合 `windowsVerbatimArguments` 保留其边界；JS、原生可执行文件及缺失 `npm_execpath` 分支继续按参数数组调用。真实子进程回归在含空格临时目录创建可控 `.cmd`，断言退出成功且收到含空格参数；`pnpm run release:verify` 通过（102 passed，0 skipped）。 |

第二次交付者报告（复审前）：Node.js 24.20.0、pnpm 11.19.0；`pnpm run release:verify` 通过（102 passed，0 skipped），已执行质量门禁、打包检查与临时消费者的 validate、graph、Mock Replay。交付时 ALS-CR-002、ALS-CR-006、ALS-CR-007 均待二次复审；该历史状态已由以下复审结论更新。

## 第二次修复后复审（2026-09-08）

范围：对提交 `a09106a` 中 ALS-CR-002、006、007 的二次修复及新增测试进行复核，重跑正式发布门禁并补充独立复现。复审期间工作区干净，未修改产品代码。

### ALS-CR-002 剩余问题 — P1：跨脱敏类别仍产生不同状态

**位置**：`packages/recorder/src/redaction.ts:646` 至 `:652`，`RedactionPipeline.placeholderFor()`；关联 `redactEvent()`、`redactCheckpoint()` 和默认字段/正则规则。

**原因与影响**：reference 缓存键包含类别和原始值，只有两者都相同才复用占位符。状态变更事件的值位于 payload.value，默认正则将测试密钥归为 api_key；checkpoint 的同一值若位于 token 或 password 字段，则优先命中相应字段规则，类别成为 token 或 password。即使原始值相同，也会生成不同占位符，导致两种恢复路径状态哈希不同。

**独立复现结果**：

| 状态路径 | 事件流占位符类别 | Checkpoint 占位符类别 | 状态哈希一致 |
| --- | --- | --- | --- |
| /value | api_key | api_key | 是 |
| /token | api_key | token | 否 |
| /password | api_key | password | 否 |

各场景均使用未定制的 `createDefaultRedactionPipeline()`，原始值为人工测试字符串 `sk-reviewsecret123456789`。占位符具体 UUID 无关紧要，关键是类别和引用身份均不一致。

**端到端复现步骤**：

1. 配置默认 pipeline 和真实 SnapshotWriter，创建运行。
2. 追加 `state.changed`，payload 为 `{ operation: 'set', path: '/token', value: 'sk-reviewsecret123456789' }`。
3. 调用 checkpoint，state 为 `{ token: 'sk-reviewsecret123456789' }`，传入该原始 state 的哈希。
4. 以返回的 checkpoint.state_hash 完成运行，提交并关闭 writer。
5. 使用 loadTraceSnapshot 重新加载磁盘快照，并用新 Recorder 执行 MockReplayRunner。
6. 实际结果：源 Trace `valid=true`，回放 `status=failed`，诊断为 `FINAL_STATE_MISMATCH`。

**现有测试缺口**：新增默认 pipeline 端到端测试仅使用 /value 和 /api_key，这两个路径的事件与 checkpoint 恰好都使用 api_key 类别，未覆盖跨类别情况。

**后续修复要求**：保证同一逻辑状态在事件流和 checkpoint 两条路径中形成一致的脱敏表示，不能仅保证“相同类别 + 相同值”的缓存复用。应明确字段规则与正则规则的组合语义，保留密钥不落盘、已脱敏状态稳定及原有定制规则支持；不得通过取消脱敏或一致性比较绕过问题。

**第三次修复验收**：

- 默认 pipeline 下，至少覆盖 /value、/api_key、/token、/password 的状态更新，分别断言事件流和 checkpoint 重建状态及哈希一致。
- /token、/password 必须经过真实写盘、重新加载和 Mock Replay，断言正常完成，无 `FINAL_STATE_MISMATCH`。
- 保留重复原始 checkpoint、已脱敏 checkpoint、原始密钥不落盘及自定义 mask/remove 等已有回归。
- 正式 `pnpm run release:verify` 继续通过；新增跨类别测试必须纳入该门禁。

### 可关闭项及门禁结果

- ALS-CR-006：显式栈祖先遍历与 8,000 个中间事件长链回归通过，可关闭。
- ALS-CR-007：通过生产调用组合逻辑实际执行 `C:/Program Files/nodejs/pnpm.cmd --version`，退出码为 0，输出 11.19.0；含空格路径真实子进程测试及正式门禁通过，可关闭。
- ALS-CR-001、003、004、005：本轮未发现相关回归，维持可关闭状态。
- 正式 `pnpm run release:verify` 在 Node.js 24.20.0、pnpm 11.19.0 下通过，包括质量检查、测试、打包和临时消费者安装 smoke；仍未覆盖上述剩余失败场景。
- 发布结论：六项可关闭，一项 P1 未通过。继续暂缓公开发布，完成 ALS-CR-002 补充修复后再次复审。

## 第三次修复交付记录（coding agent 原始报告，历史）

以下保留第三次交付时的报告和“待三次复审”状态；当前结论由随后的三次复审记录更新。

| 编号 | 当前状态 | 新增修改文件/提交 | 补充回归测试与验证结果 |
| --- | --- | --- | --- |
| ALS-CR-002 | 已补充修复，待三次复审 | `packages/recorder/src/redaction.ts`、`packages/replay/src/index.test.ts` | reference 身份缓存改为仅以原始 JSON 值为键；同一值即使由字段规则和正则规则归入不同类别，也会复用同一个占位符，避免事件流与 checkpoint 状态分裂。默认 pipeline 真实写盘、重新加载与 Mock Replay 回归逐一覆盖 /value、/api_key、/token、/password，并保留重复原始 checkpoint、已脱敏 checkpoint 与密钥不落盘断言；`pnpm run release:verify` 通过（102 passed，0 skipped）。 |

第三次交付者报告（复审前）：Node.js 24.20.0、pnpm 11.19.0；`pnpm run release:verify` 通过（102 passed，0 skipped），已执行质量门禁、打包检查与临时消费者的 validate、graph、Mock Replay。交付时 ALS-CR-002 待三次复审；最新结论见下文。

## 第三次修复后复审（2026-09-08）

范围：复核 ALS-CR-002 最新代码及回归测试，独立验证上轮样例和未被正则完整匹配的状态值，执行真实写盘、恢复与回放。复审未修改产品代码。

### ALS-CR-002 剩余问题 — P1：字段规则与逻辑状态路径不一致

**位置**：`packages/recorder/src/redaction.ts:662` 至 `:666`，`RedactionPipeline.redactEvent()`；关联 `redactCheckpoint()` 的字段规则应用。

**原因与影响**：事件脱敏直接处理 payload，字段规则看到的是 `/value`，而非 `state.changed.path` 指定的逻辑字段。checkpoint 直接处理 state，可以命中 `/password`、`/token` 等规则。仅将 reference 缓存改为以原始 JSON 值为键，不能解决两处匹配范围不同的问题：未命中正则时事件不脱敏；部分命中时事件仅替换子串，checkpoint 却替换整个字段。

**独立验证结果**：

| 逻辑路径 | 人工测试值 | 事件流行为 | Checkpoint 行为 | 结果 |
| --- | --- | --- | --- | --- |
| /token | `sk-reviewsecret123456789` | 替换完整正则匹配值 | 复用同一 reference | 状态哈希一致，上轮样例已修复 |
| /password | `review-only-opaque-password` | 原样保留密码 | 替换整个字段 | 明文落盘且状态哈希不一致 |
| /token | `prefix sk-reviewsecret123456789` | 保留前缀，仅替换 API-key 子串 | 替换整个字段 | 状态哈希不一致 |

上述字符串均为人工测试值，不是真实凭据。

**实际写盘与回放复现步骤**：

1. 对表中后两种场景分别创建新运行，配置未定制的默认 pipeline 和 SnapshotWriter。
2. 追加 `state.changed`，payload 为 `{ operation: 'set', path: '/password', value: 'review-only-opaque-password' }`；另一场景将 path 改为 `/token`、value 改为带前缀的测试值。
3. 以对应原始 state 和哈希创建 checkpoint，再使用返回的 checkpoint.state_hash 完成运行，提交并关闭 writer。
4. 检查磁盘 `events.jsonl`，普通密码场景仍能找到完整原始测试值。
5. 重新调用 loadTraceSnapshot，再使用新 Recorder 执行 MockReplayRunner。
6. 两种场景均为源 Trace `valid=true`、回放 `status=failed`，诊断均为 `FINAL_STATE_MISMATCH`。

**现有测试缺口**：第三次交付测试虽遍历 /value、/api_key、/token、/password，却始终使用完整匹配 API-key 正则的同一个字符串。它证明了整值命中时的 reference 复用，没有覆盖字段规则独立命中和正则仅匹配子串的情况。

**后续修复要求**：

- 统一事件增量与 checkpoint 的逻辑状态路径脱敏语义；state.changed 的目标字段必须参与规则匹配，不能仅依赖事件包装中的 payload.value 路径或密钥格式。
- 保证同一逻辑状态值在两条恢复路径中形成相同表示，处理字段规则整值替换与正则子串替换的关系。
- 保留现有非状态事件的规则语义、自定义规则以及已脱敏占位符稳定性；不得通过保留明文、取消脱敏或关闭状态一致性校验使回放通过。

**第四次修复验收**：

- 默认 pipeline 下，普通密码和不匹配密钥正则的 token 在对应敏感逻辑字段中不得明文落入事件或 checkpoint。
- 对普通密码、完整 API-key 字符串、带前缀密钥分别进行真实写盘、重新加载、事件流/checkpoint 双路径恢复和 Mock Replay；断言状态及哈希一致、回放成功且无 FINAL_STATE_MISMATCH。
- 补充逻辑路径相关的嵌套状态、JSON Pointer 转义和 set/merge/append 等适用增量操作测试，防止仅针对顶层 set 样例修补。
- 保留重复原始 checkpoint、已脱敏 checkpoint、自定义 mask/remove、artifact 边界及其余六项已通过的回归测试。
- 新增用例必须纳入正式 `pnpm run release:verify`，最终门禁继续通过。

### 三次复审验证与发布结论

- Node.js 24.20.0、pnpm 11.19.0 下，正式 `pnpm run release:verify` 通过，含质量检查、测试、打包及临时消费者安装 smoke。
- 上轮完整 API-key 字符串的跨类别问题已改善；本轮两个补充失败场景均通过实际文件和 Mock Replay 独立复现，现有门禁未覆盖。
- ALS-CR-002 保持 P1 未关闭；其余六项维持可关闭状态。建议继续暂缓发布，完成逻辑状态路径脱敏修复后再次复审。

## 第四次修复交付记录（coding agent 原始报告，历史）

| 编号 | 当前状态 | 新增修改文件/提交 | 补充回归测试与验证结果 |
| --- | --- | --- | --- |
| ALS-CR-002 | 已补充修复，待四次复审 | `packages/recorder/src/redaction.ts`、`packages/recorder/src/redaction.test.ts`、`packages/replay/src/index.test.ts` | state.changed 会将增量 value 投影至其逻辑 path 后执行字段、正则和自定义规则，再写回事件，保证与 checkpoint 的整值/子串脱敏粒度一致；artifact 引用和非状态事件边界保持不变。默认 pipeline 真实写盘、重新加载和 Mock Replay 覆盖普通密码、完整 API-key、带前缀密钥并断言密钥不落盘；逻辑路径回归覆盖嵌套、JSON Pointer 转义、set、merge、append、通配符与自定义规则；`pnpm run release:verify` 通过（103 passed，0 skipped）。 |

第四次交付者报告（复审前）：Node.js 24.20.0、pnpm 11.19.0；`pnpm run release:verify` 通过（103 passed，0 skipped），已执行质量门禁、打包检查与临时消费者的 validate、graph、Mock Replay。交付时 ALS-CR-002 待四次复审；以下为后续发现和修复记录。

## 第四次复审后的直接修复（2026-09-08）

用户授权直接修复四次复审中的两处问题：

1. `/password` 的 remove 规则删除目标后，投影查找返回 undefined，原逻辑回退到普通 payload 脱敏，导致原始密码落入 events.jsonl。
2. 对 `/tokens/1` 配置 mask，先 set tokens 为 `['public']` 再 append 测试值，虚拟数组下标始终为 0，导致新增值未脱敏；checkpoint 按真实下标脱敏后与事件状态分裂。

两者修复前均已实际写盘复现：原始测试值存在于事件文件、Trace valid=true、Mock Replay 报 FINAL_STATE_MISMATCH。

### 实现与兼容边界

- `STATE_REDACTION_UNREPRESENTABLE`：整个变更目标被删除、祖先被替换导致目标不可取出，或 append 容器不再是数组时，直接抛出错误，不回退原始值。
- `STATE_REDACTION_CONTEXT_REQUIRED`：append 或 trailing `/-` 写入遇到指定新增元素下标的字段规则、或重叠的自定义回调时，拒绝在未知真实位置上执行规则。自定义回调可依赖 context.path 中的具体下标，因此同样需要完整上下文。
- 错误由 RedactionPipeline 在持久化前返回；在 pipeline → SnapshotWriter 的配置下，不写入被拒绝事件，不推进 Recorder 的事件序列，错误文本不包含原始测试值。
- 对可表达的父对象/数组，调用方可改用完整更新后的 `set`，再应用相同规则。完整父对象内删除嵌套字段、完整数组的指定下标脱敏均可保持状态与 checkpoint 一致。
- 无法用当前协议表达的整个目标删除不会被伪装为成功；调用方必须处理错误。没有新增空操作事件或更改快照协议。位置无关的字段通配符 append 仍可使用。
- 使用说明见 `docs/security-and-release.md` 的 Secrets 段。此限制是有意的安全失败行为，不能通过移除脱敏拦截器重试。

### 新增验证

- 单元回归：字段 remove、自定义 remove、祖先替换均不回退敏感值；指定下标 append、`set /tokens/-`、依赖路径的自定义回调在持久化前拒绝。
- 真实写盘回归：断言失败调用不改变内存事件、不将测试密钥写入 JSONL；改用完整父对象/数组 set 后，事件流与 checkpoint 恢复状态及哈希一致，Mock Replay 成功，事件及 checkpoint 中均无原始测试值。
- 保留普通密码、完整及带前缀密钥、/value、/api_key、重复 checkpoint、已脱敏 checkpoint、嵌套/转义路径、merge、通配符 append 和此前六项的回归。
- 修改文件：`packages/recorder/src/redaction.ts`、`packages/recorder/src/redaction.test.ts`、`packages/replay/src/index.test.ts`、`docs/security-and-release.md` 及本文。

验证结果：定向测试 35 passed；Node.js 24.20.0、pnpm 11.19.0 下正式 `pnpm run release:verify` 通过，106 passed、0 failed、0 skipped，包含类型检查、lint、格式、打包及临时消费者 validate、graph、Mock Replay。产品包的 private 标志、scope、registry 和发布凭据未修改，未执行发布。

## 最新复审与 merge 补充修复（2026-09-08）

最新复审仍发现 ALS-CR-002 的 P1 遗漏：对 `/profile` 整体 mask 后，合法的对象 merge 被改为字符串值，但操作仍为 merge。事件会被接受并落盘，真实 Mock Replay 抛出 `STATE_VALUE_INVALID`；当时正式门禁通过，但未覆盖此分支。

按用户授权补充修复：

- `redactStateChangeValue()` 在返回前检查 merge 的脱敏结果。非对象值（包括数组、null、字符串、数字和布尔值）以 `STATE_REDACTION_UNREPRESENTABLE` 在持久化前拒绝，不改变操作类型或回退原值。
- 调用方可改用完整更新后的目标值执行 set；不能仅把原 merge 补丁改名为 set，否则会覆盖原有字段。脱敏结果仍为对象的 merge 保持支持。
- 单元回归覆盖 mask、reference、自定义非对象替换和合法对象替换；错误文本不包含原始测试密钥。
- 真实写盘回归覆盖 mask 与 reference：拒绝后内存事件及 JSONL 文件逐字不变，后续安全 set 的序列连续；重新加载后事件流和 checkpoint 的恢复状态与哈希一致，Mock Replay 完成，事件及 checkpoint 无原始测试密钥。

验证：新增两个测试在修复前均报 `Missing expected rejection`；修复后 recorder redaction 与 replay 定向测试 37 passed、0 failed、0 skipped。正式 `pnpm run release:verify` 通过，包含类型检查、lint、格式、全量测试、打包检查及临时消费者安装后的 validate、graph、Mock Replay；`git diff --check` 通过。

修改文件为 redaction 实现及单元测试、replay 集成测试、安全指南和本文。ALS-CR-002 状态为已补充修复、待再次复审，不等于已批准发布；未提交、未发布，未修改 private、scope 或 registry。

## 最新复审与 delete 补充修复（2026-09-08）

最新复审确认 merge 修复通过，但 delete 未带 value 时绕过逻辑状态脱敏，带 value 时也被明确跳过。独立复现：

- `/profile/password` 配置 remove，先 set 完整 profile 再 delete password，事件落盘且 Trace valid=true，但 Mock Replay 抛出 `STATE_EVENT_INVALID`，因为脱敏状态中目标已不存在；该场景未泄露原始密钥。
- `/tokens/0` 配置 remove，先 set `['hidden', 'public', 'keep']` 再 delete `/tokens/1`，事件恢复为 `['public']`，checkpoint 为 `['keep']`。

按用户授权补充修复：

- delete 无论是否附带 value 均进入检查，安全事件保留原 payload，不人为添加 value。
- 目标可能被 remove 或祖先被 mask/reference/remove 时，返回 `STATE_REDACTION_UNREPRESENTABLE`。
- 数组元素 remove 可能改变寻址、数组删除影响固定下标字段规则、或相关自定义规则需要上下文时，返回 `STATE_REDACTION_CONTEXT_REQUIRED`。检查涵盖嵌套数组、通配符、转义路径和全局自定义规则。数字对象键在缺少容器状态时保守地视为可能的数组下标。
- 保留普通对象字段删除、精确 mask/reference 字段删除、整父对象删除（含已移除子字段）和位置无关的通配符数组删除；无关路径规则不阻止普通对象删除。不能安全表达时，需以完整更新后的父对象/数组 set 重试，不可跳过错误或将所有缺失删除改成 no-op。

回归验证：新增拒绝单元测试及真实写盘测试在修复前均报 `Missing expected rejection`。修复后覆盖对象 remove、数组 remove、固定下标 mask、自定义 remove 四种实际落盘流程，拒绝后内存事件和 JSONL 逐字不变、后续序列连续；完整 set 重试后事件与 checkpoint 的恢复状态/哈希一致，Mock Replay 完成且原始测试密钥不落盘。

验证结果：redaction 与 replay 定向测试 40 项通过；最终 delete 定向测试 3 项通过；正式 `pnpm run release:verify` 111 passed、0 failed、0 skipped，类型检查、lint、格式检查、打包及临时消费者 validate、graph、Mock Replay 全部通过；`git diff --check` 通过。

修改文件：redaction 实现、redaction 单元测试、replay 集成测试、安全指南及本文。ALS-CR-002 保持“已补充修复，待再次复审”，未提交、未发布，未修改 private、scope 或 registry。

## 最新复审与控制字段补充修复（2026-09-08）

最新复审确认 delete 修复通过，但逻辑规则 `/path`、`/operation` 同时作用于事件 metadata，会破坏协议控制。实际复现：`set /path` 的 path 被 mask 成占位符，事件成功落盘且 Trace valid=true，但 Mock Replay 抛出 `STATE_EVENT_INVALID`；该场景未泄露原始测试密钥。

按用户授权补充修复：

- 从待脱敏 metadata 中分离 operation/path，逻辑字段和自定义规则仅处理状态数据及扩展 metadata；输出时恢复精确的原控制字段。状态本身名为 path/operation 的字段仍正常脱敏。
- set、merge、append、delete 共用此隔离逻辑；delete 不人为增加 value，附带 value 和 artifact 引用仍在各自既有脱敏边界内处理。
- 如正则规则要求修改控制字段，拒绝并返回 `STATE_REDACTION_UNREPRESENTABLE`，提示使用非敏感状态路径，不静默改坏指针或保留正则命中的明文。
- 无法投影的状态增量、metadata 被替换成非对象时明确拒绝，不回退对原 payload 的通用处理。

验证：新增真实写盘回归在修复前因 operation 从 set 变为占位符而失败。修复后 mask/reference 两组均覆盖 set、merge、append、delete、扩展字段脱敏、无 value 删除；控制字段保持原值，事件与 checkpoint 状态/哈希一致，Mock Replay 完成，原始测试密钥未落盘。单元回归另覆盖自定义同名规则、artifact/可选 delete value 的控制字段保留、正则命中控制字段及非对象 metadata 拒绝。

最终 `pnpm run release:verify`：115 passed、0 failed、0 skipped，类型检查、lint、格式、打包及临时消费者安装后的 validate、graph、Mock Replay 全部通过。`git diff --check` 通过。安全指南与本记录已同步；ALS-CR-002 状态为已补充修复、待再次复审，未提交、未发布。

## 最新复审与自定义上下文补充修复（2026-09-08）

最新复审确认控制字段隔离通过，但自定义回调只接收当前增量的投影，无法读取已有状态。实际写盘复现：`/profile` 回调在 `private: true` 时删除 `label`；先完整 set `{ private: true }`，再 merge `{ label: 'review-only-secret' }`，回调看不到既有 private 标记，原值进入 `events.jsonl`。checkpoint 正确删除 label，Trace valid=true，而 Mock Replay 以 `FINAL_STATE_MISMATCH` 失败；局部 set `/profile/label` 同样可泄露。

按用户授权补充修复：

- 增量写盘前分析自定义规则与目标 JSON Pointer 的关系。merge 落在自定义规则目标或其后代、set 落在自定义规则目标之下时，返回 `STATE_REDACTION_CONTEXT_REQUIRED`，不调用带有合成部分对象的回调。
- 无 path 的全局自定义规则始终拒绝状态增量：协议无法表达完整根状态 set。append 及 trailing `/-` 的既有自定义上下文保护保持不变；delete 使用已有状态/下标检查。
- set 在自定义规则的完整目标上、以及 merge 包含完整的 scoped descendant 值仍可用。完整更新后的父对象可作为被拒绝 merge 或局部 set 的安全替代路径。

回归验证：新增单元测试覆盖精确 custom merge、局部 custom descendant set、全局 custom、完整 parent set 以及可安全的 scoped descendant merge。新增真实写盘测试先断言 merge 与局部 set 均在写盘前拒绝，内存事件和 JSONL 不变；随后完整 `/profile` set 成功，事件和 checkpoint 恢复状态/哈希一致，Mock Replay 完成，事件和 checkpoint 均不含原始测试密钥。

验证结果：recorder redaction 与 replay 定向测试 46 passed、0 failed、0 skipped；正式 `pnpm run release:verify` 117 passed、0 failed、0 skipped，类型检查、lint、格式检查、打包及临时消费者安装后的 validate、graph、Mock Replay 全部通过；`git diff --check` 通过。修改文件：redaction 实现与单元测试、replay 集成测试、安全指南及本文。ALS-CR-002 保持“已补充修复，待再次复审”，未提交、未发布。

## 结构变更修复与自复审（2026-09-08）

用户要求修复最新两项发现，并在修复后自行复审。修复前已通过真实快照独立复现：

1. `/profile/contact` 自定义回调删除 contact 后，merge 补丁变为 `{}`，旧 contact 留在恢复状态中，checkpoint 则不含该字段。
2. `/items/*` 回调删除第 0 个元素后，`set /items/1` 仍使用原下标，恢复结果多出旧元素，checkpoint 只有更新后的元素。

两者均成功落盘、Trace valid=true，Mock Replay 报 `FINAL_STATE_MISMATCH`；对应测试密钥未落盘。新增写盘回归在生产修复前以 `Missing expected rejection` 复现 merge 问题。

### 修复行为

- 比较规范化的原 merge 补丁与脱敏结果的顶层键。任何顶层键被移除时返回 `STATE_REDACTION_UNREPRESENTABLE`，因为浅合并无法用省略键删除旧值。保留对子对象完整替换时的嵌套删除，以及未丢键的合法 merge。
- 所有状态操作在处理值之前检查路径中的数字段。元素级 remove、自定义元素规则或祖先规则可能压缩/替换数组时，返回 `STATE_REDACTION_CONTEXT_REQUIRED`。覆盖固定下标、通配符、嵌套数组、转义路径，以及元素内部的 merge/append。
- 地址检查位于 inline/artifact 值分流之前。缺少容器状态时，数字对象键按可能的数组下标保守处理；完整父对象或数组 set 仍可用。不会自动修改操作类型、猜测新下标或添加 no-op。

### 自复审及验证

- 自复审重新核对浅合并语义、数组压缩后的寻址、各操作入口与 artifact 分流，发现 artifact 引用可绕过值处理内部的地址检查；新增回归复现后，将检查前移。随后又以整数组过滤回调复核 ancestor 规则，修复同类入口。两项补充回归均先失败后通过。
- 新增真实写盘测试覆盖 6 个场景：merge 移除已有子字段、数组 set/merge/嵌套 append，以及元素级/整数组过滤后的 artifact 引用更新。断言拒绝后内存事件和 JSONL 不变、重试序列连续；完整父对象/数组 set 后，恢复状态和 checkpoint 哈希一致，Mock Replay 完成且测试密钥不落盘。
- 新增 525 组确定性组合检查，覆盖对象、数组、嵌套转义路径、mask/reference/remove、自定义条件删除与顺序组合规则。以未脱敏事件恢复的完整状态独立计算预期脱敏结果，所有获准增量均与该结果及其哈希一致；同时保留合法更新与拒绝路径，防止通过全面禁用操作掩盖问题。
- 最终代码的 redaction 与 replay 定向测试 48 passed、0 failed、0 skipped；正式 `pnpm run release:verify` 119 passed、0 failed、0 skipped，类型检查、lint、格式、打包及临时消费者安装后的 validate、graph、Mock Replay 全部通过。`git diff --check` 通过，HEAD 仍为 `a09106a`。

自复审结论：当前检查范围内未发现新的阻断项；ALS-CR-002 在安全指南记录的兼容边界内可关闭。其余六项维持此前结论。修复、自复审与发布批准分开记录，未提交、未发布。

## 数字对象键补充修复（2026-09-08）

后续复审发现 P2 问题：`virtualStateContainer` 将数字 JSON Pointer 段构造成稀疏数组。合法对象键 `1000000` 的小更新产生约 8 MB 堆分配，`4294967295` 等大键则无法提取投影目标，错误返回 `STATE_REDACTION_UNREPRESENTABLE`。

按用户授权修复：虚拟祖先使用单个自有字符串属性，保留数字键原文，不做数字转换、不分配与键值大小相关的数组空间。实际传入的数组及 trailing `/-` 追加保持原语义；已有上下文及数组地址安全检查不放宽。

验证证据：

- 新增单元与真实写盘回归均在修复前失败、修复后通过。覆盖 `4294967295`、超过安全整数的 `9007199254740993`、80 位数字键，以及真实数组下标和追加操作。
- 独立子进程内存回归约束 `1000000` 小更新的堆增量低于 2 MiB；修复后独立探测约 36 KB。该数值为本机探测结果，不作为通用性能保证。
- 写盘回归覆盖 set、merge、append、delete、reference 与 mask；事件恢复和 checkpoint 状态及哈希一致，Mock Replay 完成，测试密钥未落盘。原有 525 组状态等价检查继续通过。
- redaction 与 replay 定向测试 50 passed、0 failed、0 skipped；正式 `pnpm run release:verify` 121 passed、0 failed、0 skipped，包含类型检查、lint、格式、全套测试、打包及临时消费者安装后的 validate、graph、Mock Replay。另一次沙箱内 `pnpm test` 为 120 passed、0 failed、1 skipped；最终以正式发布验证的零跳过结果为准。`git diff --check` 通过。

安全指南已同步。当前修复范围内未发现新的阻断项；未提交、未发布，发布决策仍由负责人作出。

## 短横线对象键补充修复（2026-09-08）

后续复审发现 P1：对象 `set /byId/-` 被投影为数组追加，精确规则 `/byId/-/password` 未匹配。实际写盘确认测试明文进入事件文件，checkpoint 正确脱敏，Trace valid=true 而 Mock Replay 报 `FINAL_STATE_MISMATCH`。

按用户授权修复：

- 虚拟祖先统一保留原字符串键，包括路径中间的 `-`；merge/append 的末尾 `-` 不再误判为追加标记。
- 仅 set 的末尾 `-` 保留数组追加候选语义。若字段规则在该位置指定精确 `-`，因缺少父容器类型，在 inline/artifact 分流前返回 `STATE_REDACTION_CONTEXT_REQUIRED`，提示完整父对象 set；不会只选择一种解释而漏脱敏。已有固定下标、自定义回调及结构变更检查保持不变。
- 位置无关的通配符规则继续支持合法对象 `-` 键和真实数组追加。

回归与核对：新单元测试在修复前以 `Missing expected rejection` 失败；修复后验证精确规则拒绝、merge `-` 目标、局部 set 及嵌套 append。真实写盘测试增加精确 `-` 规则，断言拒绝前后内存事件及 JSONL 不变，完整父对象重试后可继续更新；另将 `-` 纳入通配符对象键场景。事件与 checkpoint 恢复状态/哈希一致，Mock Replay 完成，测试明文不落盘。复核保留真实数组下标与追加覆盖。

验证结果：定向测试 51 passed、0 failed、0 skipped；正式 `pnpm run release:verify` 122 passed、0 failed、0 skipped，类型检查、lint、格式、打包及临时消费者 validate、graph、Mock Replay 全部通过。`git diff --check` 通过。安全指南已同步，未提交、未发布。

## 整体复审问题集中修复（2026-09-08）

整体检查覆盖输入规范化、字段/正则/自定义规则、set/merge/delete/append、JSONL 写盘失败边界、checkpoint、Trace 加载和 Mock Replay。检查发现并按用户授权集中修复以下四项：

1. 生命周期和回放协议字段会被同名字段规则改写，导致 checkpoint 或终态事件不再符合 schema。
2. reference 缓存键使用对象插入顺序，原始状态哈希相同的换序对象可得到不同占位符，导致最终状态哈希不一致。
3. 数组元素被字段或自定义规则移除时，移除分支遗漏 `security.redactions` 审计条目。
4. append 的虚拟投影总使用下标 0，审计记录可能错误声称脱敏发生在既有第 0 个元素。

修复行为：

- 对 run、model、tool、checkpoint 和 verification 的协议字段按事件类型隔离；精确字段规则不会重写协议值，替换协议容器或正则命中协议值则在写盘前返回 `PROTOCOL_REDACTION_UNREPRESENTABLE`。错误消息/details、输入、输出和诊断仍在正常脱敏范围内。
- reference 以递归、键排序的规范 JSON 身份缓存；对象键顺序不影响占位符，数组顺序仍是身份的一部分，与 `hashState()` 语义一致。
- 数组删除先保留对应审计条目；append 与 trailing `/-` 的审计条目将虚拟 `/0` 映射为协议路径 `/-`。

验证：新增单元测试先覆盖 checkpoint/run.failed 协议控制、规范 reference、字段与 scoped custom 的数组删除、append 和 trailing `/-` 审计路径。新增真实写盘回归同时在状态中使用 `state_hash`、`final_state_hash`、`sequence`、`checkpoint_id`、`last_event_id` 等合法同名字段，并让 event/checkpoint 的 profile 对象仅键顺序不同；断言 Trace valid、事件恢复与 checkpoint 状态/哈希一致、控制字段类型/格式保持有效、测试密钥不落盘、Mock Replay 完成。

整体组合核对：9,598 组状态变更/规则组合中，6,357 组获准更新均与完整状态脱敏后的 checkpoint 一致，3,241 组按既有安全边界拒绝；换序对象检查暴露的 356 组 reference 不一致已由规范身份修复。该组合检查保留数组、对象、转义键、数字/短横线键、mask/reference/remove、自定义规则及规则组合。

最终验证：redaction 与 replay 定向测试 54 passed、0 failed、0 skipped；正式 `pnpm run release:verify` 125 passed、0 failed、0 skipped，包含类型检查、lint、格式、全套测试、打包和临时消费者的 validate、graph、Mock Replay。`git diff --check` 通过。安全指南已同步，未提交、未发布。

## ALS-CR-002 当前状态（2026-09-08）

按用户要求，ALS-CR-002 标记为“暂时完成，下次检查”。本次不继续修复或发布。

下次检查优先复核两项已复现边界：

- 全局 custom redactor 依赖 `error.code` 等协议字段作判断时，协议隔离不能令其丢失脱敏上下文或使敏感 error message 落盘。
- 脱敏流水线必须把任意扩展事件类型视为普通不可信字符串；`constructor`、`toString` 等名称不得触发继承属性并抛出内部异常。

此前的代码、测试、安全指南和验证记录保持现状；未提交、未发布。
