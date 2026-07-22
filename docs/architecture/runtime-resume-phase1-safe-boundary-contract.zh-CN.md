# Runtime Resume Phase 1 安全边界契约

[English](./runtime-resume-phase1-safe-boundary-contract.md)

Phase 1 在 Phase 0 的 `RuntimeEvent` 重放投影之上，增加了一条显式且 fail-closed 的续跑路径。只有已提交的源边界完整，并且 host 提供了所有必需的外部安全事实时，它才能创建新的 Run 和 Invocation。

规划与执行仍是两个独立操作。只有设置 `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1` 后，host 才会暴露这两项操作：Desktop 在中断 Turn 横幅上提供 **安全恢复** 操作，CLI/TUI 提供 `/resume`，Desktop 还可以在启动修复完成后自动续跑符合条件的中断 Session。未设置该开关时，普通 Turn 不执行续跑安全检查，并保持 Phase 1 之前的正常路径。

## 续跑单位

续跑不会复活旧的 provider stream、JavaScript 调用栈、Promise 或操作系统进程，而是创建新的执行身份：

```text
源 Session / Invocation / Run / Turn
  -> 经过验证的已提交 RuntimeEvent high-water
  -> 新 Invocation / Run / Turn
  -> continuation-start RuntimeEvent
  -> 不含重复 user message 的 provider replay
```

新 Run 会记录 `parentRunId` 和 `parentTurnId`。它的第一条 canonical event 是由系统拥有的 continuation-start fact，其中引用：

- 源 Invocation、Run 和 Turn ID；
- 源 RuntimeEvent high-water；
- 新执行身份。

必须先持久化 continuation-start event，才能调用 provider。

## Planner gate

`RuntimeContinuationPlanner` 读取源 AgentRun 和 RuntimeEvent ledger。只有同时满足以下全部条件，plan 才是 `continue`：

- 源 run 和 RuntimeEvent ledger 均可读取；
- run header 恰好存在一条匹配且非 partial 的 terminal RuntimeEvent；
- 每一条 RuntimeEvent 都属于同一个源 Session、Invocation、Run 和 Turn；
- Phase 0 投影为 `safe_replay`；
- 每一个已接受的 tool call 都存在已提交且匹配的 response；
- 没有尚未解决的 permission request；
- 没有被报告为 unsettled 的后台 operation 或 child operation；
- 经过平台规范化后，源 cwd 与当前 cwd 相同；
- 源 workspace identity 与当前 workspace identity 相同；
- 该边界需要的每一个历史工具当前都可用；
- provider 可见历史结束于 user 或 tool 边界；
- 续跑使用全新的 Invocation、Run 和 Turn ID；
- 如果提供了可选的 workspace checkpoint，则它必须有 ref、已经恢复，并覆盖同一个 RuntimeEvent high-water。

任何事实缺失或相互矛盾都会产生稳定的 `park` reason。Phase 1 不会把不确定性转换成重试。

## 执行前重新验证

Plan 不是一份执行 lease。开始新 Run 之前，Runtime 会立即重新读取 durable state，并在以下任一情况下拒绝续跑：

- 同一本地 Runtime 中的另一个 Run 处于 active 状态；
- 规划完成后，源 run identity、terminal status、cwd 或 RuntimeEvent high-water 发生变化；
- 源 replay projection 不再等于计划中的 replay context；
- 目标 Run ID 已经存在。

源边界同时也是一个幂等声明。continuation Run 会在调用 provider 之前，把 `continuationSource` 持久化到自己的 header 中。重复规划会以 `continuation_already_exists` park；过期或并发的 plan 会在 provider 执行前被拒绝。如果无法创建这项 durable claim，系统将 fail-closed。

这只是单进程 ownership，不是分布式 fencing。Store 的唯一性约束仍是防止重复创建目标 Run 的最终 guard。

## Provider history

普通 Turn 会合成一条初始 user RuntimeEvent，并把当前 user message 追加到 provider request；续跑不会做这两件事。Provider 会直接收到经过验证的已提交 replay context，而 system prompt 和当前工具配置仍按正常流程重新构建。

这样既不会重复原始请求，也不会仅仅因为创建了新的 model turn，就把已经完成的 tool call 再执行一次。

## 失败行为

如果 continuation-start 持久化失败：

1. 不调用 provider；
2. 不会在缺少 terminal RuntimeEvent 时提交 terminal AgentRun header；
3. 不完整的目标 Run 仍然可以恢复；
4. 现有 startup recovery 随后会写入 recovered terminal RuntimeEvent，再提交对应的 failed run header。

续跑执行绝不修改源 ledger。

## 当前存储边界

Phase 1 继续读写现有的 RuntimeEvent store 和 AgentRun store。它不会让 JSONL 在工具副作用与 event 之间具备事务性。因此，只有每个工具 outcome 都已经提交的边界才允许续跑。

SQLite canonical storage、Tool Journal T1/T2 transaction、operation ID、reconcile 和幂等重执行仍属于后续阶段。Phase 1 不增加 hashing policy、lease、fencing token 或 distributed scheduler ownership。

## Host 职责

在本阶段，workspace identity、后台 operation 是否 settled、当前 tool catalog 和可选 checkpoint restoration 都是受信任的 host fact。Host 只有在能够从权威本地状态生成这些事实时，才能暴露续跑执行入口。Runtime 仍会在执行前立即重新验证 durable source ledger 和 cwd。

本地 inspector 使用 `realpath` 对 Session cwd 进行 canonicalize，并记录由 device、inode 和 canonical path 派生的文件系统 identity。它还会检查 ShellRun 和 child run 状态，并重新构建当前 tool catalog。Plan 会把这些事实记录在 safety snapshot 中，执行时再对其重新验证。

## Host 入口与可观测性

- Desktop 中断 Turn 横幅操作：**安全恢复**；
- Desktop main IPC：`sessions:resumeLatest`；
- CLI TUI 命令：`/resume`；
- Desktop 启动自动续跑：只有同一 feature flag 开启且 interrupted run repair 完成后才会启用；
- 结构化运行事件：`plan_approved`、`plan_parked`、`execution_started`、`execution_completed` 和 `execution_failed`。

生命周期事件只包含 identity、rejection code 和 error class；不记录 prompt、工具参数、工具结果或 secret。Telemetry 是 best-effort，不能改变 resume 行为。

## 验证

Linux 和 macOS 是本契约的主要支持目标。可移植测试使用 POSIX workspace fixture，不得依赖 Windows drive letter，也不得写入固定的 host path。除非测试明确限定为 Windows-only adapter，否则 Windows 行为只提供 best-effort 支持。

Phase 1 测试覆盖：

- planner 的 safe 和 parked 判定；
- terminal header/ledger 不一致；
- permission decision 缺失和未解决的 tool call；
- workspace、cwd、checkpoint、tool catalog 和 background operation gate；
- 新 lineage 和 continuation-start 持久化；
- 不含重复 user message 的 provider replay；
- planning 与 execution 之间发生 source mutation；
- continuation-start 写入失败及随后的 startup recovery；
- provider 执行前 durable claim 创建失败；
- 重复、过期和并发的 continuation claim；
- 在 run-created、continuation-start committed、terminal-event committed 和 terminal-header committed 边界真实地对子进程执行 SIGKILL；
- Desktop IPC/preload/renderer/startup routing contract；
- CLI `/resume` 路由不产生重复 prompt；
- 完整的 Phase 0 P0–P11 SIGKILL prefix harness（由主单元测试任务通过 package `test:dist` 覆盖）。
