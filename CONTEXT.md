# Maka Domain Language

Maka 将用户的持续目标组织成可聚焦、可执行、可恢复的工作，同时保留跨工作讨论与协调入口。

## Language

**Maka Workspace**:
一个已注册的隔离范围；其中的 Session、设置、隐私与运行状态受同一组 authority 管理。
_Avoid_: Project、repository、folder

**Project**:
用户在 Maka Workspace 中注册的稳定工作来源，可以对应一个或多个可用位置。
_Avoid_: Workspace、Session

**Work**:
用户可识别、可持续推进的目标；目标需要持久上下文时，由一个 focused Session 承载。
_Avoid_: 在用户文案中使用 Session、thread

**Session**:
承载一项 Work 的持久对话与执行上下文，拥有自己的模型、权限、workspace 身份和运行历史。
_Avoid_: Work、Unified Session

**Unified Session**:
跨所有已注册 Maka Workspace 的永久对话入口。它协调 Work，但不拥有或合并各 Session 的权威历史。
_Avoid_: Super Session、全量 transcript、Session folder

**Discussion**:
尚未形成明确执行承诺的探索性对话，只属于 Unified Session。
_Avoid_: Work、Task

**Work Focus**:
Unified Session 当前最可能承接后续指代的 Work。
_Avoid_: Active Session、selected route

**Work Block**:
Unified Session 中按一个 Work 聚合的用户消息、执行状态、交互请求与回答投影。
_Avoid_: Message bubble、Session card

**Focused View**:
只展示一个 Session 的完整工作历史与控制面的视图。
_Avoid_: Unified Session、detail modal

**Work Orchestrator**:
Unified Session 背后的协调角色，负责理解指代、形成或恢复 Work，并协调跨 Work 执行。
_Avoid_: Router、super agent、Graph

**Coordination Graph**:
表达多个 Work 之间依赖与调度状态的外层 Graph；每个 Work 仍可拥有自己的内部 Graph。
_Avoid_: merged Graph、global Runtime

**Turn Binding**:
把 Unified Session 中一个可执行 turn 绑定到一个目标 Work 的持久关系。
_Avoid_: copied message、route hint

**Unified Projection**:
把目标 Session 的权威 turn 或状态显示在 Unified Session 中的引用式视图。
_Avoid_: transcript copy、sync duplicate
