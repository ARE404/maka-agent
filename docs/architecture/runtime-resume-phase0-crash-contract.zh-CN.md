# Runtime Resume Phase 0 崩溃契约

[English](./runtime-resume-phase0-crash-contract.md)

Phase 0 定义了完整提交的 `RuntimeEvent` 前缀应具备的重放安全性。它不恢复执行，不对工具副作用做 reconcile，也不引入未来的 SQLite Tool Journal。

生产 API 是一个纯函数：

```text
已提交的 RuntimeEvent 前缀
  -> ToolOperation 投影
  -> ResumePlan
  -> safe_replay 或 blocked
```

## 稳定故障点

`RUNTIME_RESUME_FAILPOINTS` 是机器可读的事实源。`committedPrefix` 列表示崩溃后最后一个完整可用的 RuntimeEvent 前缀；它刻意不把未来的 T1/T2 Journal 当作已经存在。

| ID | 注入边界 | 最后完整提交的 RuntimeEvent 前缀 |
|---|---|---|
| P0 | 工具准备（T1）之前 | `before_function_call` |
| P1 | function call 已提交，prepared journal 尚未提交 | `after_function_call` |
| P2 | prepared journal 已提交，implementation 尚未开始 | `after_function_call` |
| P3 | 工具 implementation 执行中 | `after_function_call` |
| P4 | 副作用已完成，outcome transaction（T2）尚未提交 | `after_function_call` |
| P5 | function response 已提交，outcome journal 尚未提交 | `after_function_response` |
| P6 | outcome 已提交，结果尚未交付给模型 | `after_function_response` |
| P7 | 结果已交付，provider 的下一步尚未开始 | `after_function_response` |
| P8 | terminal RuntimeEvent 提交 | `after_function_response` |
| P9 | terminal run header 提交 | `after_terminal_event` |
| P10 | recovery decision 提交 | `after_terminal_event` |
| P11 | continuation run 创建 | `after_terminal_event` |

对于 P8，Phase 0 只根据追加 terminal event 之前的前缀进行判断；追加后的前缀由 P9 表示。被撕裂的 JSON 行属于存储损坏，不是合法的已提交前缀，也绝不能被提升为恢复事实。

## 必须得到的判定

| 前缀 | 预期结果 |
|---|---|
| `before_function_call` | `safe_replay`；不存在工具 operation |
| `after_function_call` | `blocked`；operation 为 `indeterminate`；原因为 `dangling_tool_state`；provider replay 不包含未解决的 call |
| `after_function_response` | `safe_replay`；operation 为 `succeeded` 或 `failed`；provider replay 中的 call 与 response 保持配对 |
| `after_terminal_event` | 工具判定与之前的前缀相同；terminal fact 保留在 canonical ledger 中 |

预期的 RuntimeEvent high-water 只要与重新打开后得到的前缀不一致，就必须以 `runtime_offset_mismatch` 拒绝。

## 进程测试框架

Phase 0 崩溃测试必须使用真实的文件型 `RuntimeEventStore`：

1. 创建临时 workspace。
2. 启动一个 Node.js 子进程。
3. 通过 `RuntimeEventStore` 追加故障点对应的完整前缀。
4. 只有在 append Promise resolve 后才向父进程发送信号。
5. 由父进程使用 `SIGKILL` 终止子进程。
6. 验证 `finally` cleanup marker 没有写入。
7. 使用新的 `RuntimeEventStore` 实例重新打开 workspace。
8. 对重新打开的前缀投影两次，并要求得到完全相同的 `ResumePlan`。
9. 验证投影没有修改 durable ledger。

该测试框架在 Windows、macOS 和 Linux 上覆盖全部 12 个稳定故障点 ID。它测试的是进程崩溃恢复，不测试断电持久性或文件系统 `fsync` 保证。

## 阶段边界

Phase 0 不改变任何工具执行行为。以下能力仍不在范围内：

- 自动续跑；
- workspace 恢复；
- T1/T2 事务型工具边界；
- 副作用 reconcile；
- 工具幂等重执行；
- 以 SQLite 作为 canonical RuntimeEvent 和 Tool Journal store。

这些能力依赖后续阶段。Phase 0 只保证：根据当前已有证据进行的判定是确定性的，并且遵循 fail-closed 原则。
