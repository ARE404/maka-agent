---
status: accepted
---

# Unified Session 是全局 Work Orchestrator，不是超级 Session

Maka 采用一个功能开启后永久存在、跨所有已注册 Maka Workspace 的 Unified Session 作为默认对话入口。它先承载 Discussion，在用户形成明确执行意图时创建或恢复 Work；真正的消息、模型、权限、工具、workspace 与 Runtime 事实仍由目标 Session 拥有。Unified 中发起的工作 turn 通过 Turn Binding 同时投影到 Unified 与目标 Session，而在 Focused View 中直接产生的普通 turn 不会整段回灌 Unified，只向它提供可检索状态与低噪音完成、阻塞、待决定事件。

跨 Work 修改由 Coordination Graph 表达依赖，复用现有 Graph 与 Runtime 语义，但不建立一个永不结束、拥有所有 cwd 和权限的超级 Graph。选择该形态，是为了同时满足“用户只需和一个 Maka 对话”、Session 隔离、删除语义、权限继承、崩溃恢复与普通 Session 可继续使用。被否决的方案包括合并全部 transcript、把 Unified 限定到当前 Workspace、隐藏或替代普通 Session，以及让 Unified 静默获得所有 Work 的文件权限。

## Consequences

- Desktop 必须从单 Workspace composition 演进为全局 Workspace registry 加多个 Workspace host。
- Unified feed 必须保存引用和 provenance，不能成为第二份 Session transcript authority。
- 删除 Work 必须级联清理 Unified Projection、路由摘要、检索索引与 Graph 可恢复引用。
- 已有 Session 权限与模型保持有效；Unified 只为新 Work 提供默认值，并可显式修改目标 Session 权限。
- 跨 Work Graph 是外层协调，不改变每个 Work 内部 Session、AgentRun、RuntimeEvent 和 Graph 的 authority。
