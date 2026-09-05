---
doc_id: architecture.unified-session-work-orchestrator
title: "Unified Session：跨 Workspace 的全局 Work Orchestrator"
language: zh-CN
implementation_status: experimental
document_status: active_experiment
decision_status: accepted_in_design_discussion
last_verified: 2026-08-18
owners:
  - maka-product
  - maka-desktop
  - maka-runtime
---

# Unified Session：跨 Workspace 的全局 Work Orchestrator

> Unified Session 是用户与 Maka 处理所有工作的默认对话入口。用户不管理路由：Maka 理解当前 referent，把明确工作绑定到正确 Session，在原地展示执行与回答；普通 Session 继续拥有真实历史、模型、权限、文件范围和 Runtime 状态。Unified 是全局 Work Orchestrator，不是把全部 Session transcript 塞进一个上下文窗口的超级 Session。

## 1. 状态与阅读方式

本文记录已确认的产品决策、目标技术形态，以及
`codex/unified-session-experiment` 分支上的实验实现。

实验分支已经具备：永久 Unified 入口、Discussion、普通 Work 的创建与恢复、
Project/Work 标识、受限语义路由、澄清与重定向、权限交互、低噪音生命周期投影，
以及基于依赖图的跨 Work 协调。它仍是 MVP，不应被理解为已经完成生产迁移。

当前已知边界：

- host composition 覆盖当前 Maka 数据根及其中注册的 Project；真正的多数据根 Workspace
  装载仍需后续 app-level registry 演进；
- 实验分支的本地存储 schema 旧于当前发布版，开发试用必须使用隔离 userData，合并到
  最新主分支后才能安全接入日常数据；
- 路由阈值与语义卡片仍需用真实使用数据校准。

必须区分：

- **Current**：当前代码已经存在，可直接复用或需要适配的 authority。
- **Target**：本设计确定的最终行为。

本文仍区分实验能力与 Target。Desktop 的实验 composition 目前把当前数据根和其中的
Project 包装成多个 Workspace host；现有 Agent Graph 仍以一个 root Session 为 graph
namespace。真正的多数据根 Workspace 装载与原生嵌套 Graph contract 仍属于 Target。

## 2. 一句话产品定义

> 用户只需和一个 Maka 对话；Maka 负责理解用户正在谈论哪项 Work，并把工作交给正确 Session。

用户不需要知道：

- 输入被路由到哪个 Session ID；
- 模型如何召回候选 Work；
- Discussion 在何时转为持久 Work；
- 多个 Workspace host 如何被加载；
- 外层 Graph 如何等待依赖。

用户仍能感知：

- 当前是哪个 Workspace、哪项 Work；
- Work 正在处理、等待、阻塞、失败还是完成；
- 哪项 Work 正在请求权限或等待回答；
- 何时形成了一项新 Work；
- 如何进入 Focused View 继续工作。

## 3. 产品原则

### 3.1 弱化 Session，强化 Work

Session 是内部持久与执行结构。用户界面优先使用“工作”而不是“会话”。

- 明确、持续的用户目标称为 Work；
- Session 承载 Work；
- Unified Session 承载跨 Work 的 Discussion、理解与协调；
- Focused View 让用户在需要时进入某项 Work 的完整 Session。

### 3.2 先讨论，后承诺

模糊意图、比较、发散与澄清留在 Unified，不急于创建 Session。出现明确执行承诺时才形成 Work。

~~~text
“登录超时可能有问题”          → Discussion
“比较刷新令牌和延长过期时间”  → Discussion
“就按刷新令牌方案修掉”        → 创建或恢复 Work
~~~

Discussion 转为 Work 时，Work 获得一份有 provenance 的背景摘要，而不是复制整段探索对话：

~~~text
工作背景
目标：解决登录超时
决定：采用刷新令牌提前续期
已排除：延长固定过期时间
~~~

### 3.3 无缝不等于不可见

系统不展示 session ID、置信度或“正在路由”。但每个独立 Work Block 必须用轻量标题说明范围：

~~~text
maka-agent / 登录超时修复 · 处理中…
~~~

同一 Work Block 内不重复标题。改变 Work、创建新 Work、发生阻塞或完成时才更新。

### 3.4 不猜高风险 referent

普通讨论可以继续澄清。文件修改、外部副作用或跨 Work 执行若目标不明确，必须先问内容层问题：

~~~text
你指的是 maka-agent 的桌面登录，还是官网后台登录？
~~~

不要显示路由候选弹窗，也不要让用户选择 Session ID。

### 3.5 普通 Session 永远可用

功能开启不删除、不替代、不隐藏普通 Session。它只改变默认入口：

- 冷启动进入 Unified；
- 左侧栏默认收起；
- 用户可展开侧栏并进入任何普通 Session；
- Work Block 标题、通知和搜索结果都可打开 Focused View；
- Focused View 提供“返回所有工作”；
- 当前使用期间尊重用户手动展开状态；下次正常冷启动重新收起。

## 4. 非对称投影规则

Unified 不展示所有 Session 的完整混合时间线。规则固定为：

1. 从 Unified 发起并绑定到 Work 的 turn，同时显示在 Unified 和目标 Session。
2. 从普通 Session 直接发起的 turn，只显示在该 Session。
3. 普通 Session 的新状态可被 Unified 理解，但不会整段回灌。
4. Unified 仅接收三类低噪音事件：完成、阻塞、需要用户决定。
5. 跨 Work 的讨论与综合回答只属于 Unified。
6. Discussion 只属于 Unified，直到它形成 Work。

“同时显示”是同一事实的两个视图，不是两个独立 transcript。目标 Session 是工作 turn 的 authority；Unified 保存 Turn Binding 与 Unified Projection。

## 5. 核心用户旅程

### 5.1 启动

功能开启后，正常冷启动：

1. 进入唯一、永久的 Unified Session；
2. 左侧栏收起；
3. 输入框、消息面与普通 Session 保持一致；
4. Unified 入口在功能开启期间一直存在。

崩溃恢复或尚有权限交互未完成时，可以恢复原页面，避免丢失现场。关闭功能后恢复原侧栏与原默认行为；所有 Work、Session 和 Unified 历史保留。重新开启后继续原 Unified。

### 5.2 继续已有 Work

用户输入：

~~~text
继续把登录超时的测试补完。
~~~

系统优先使用硬绑定、Work Focus、项目/文件实体与历史摘要识别 Work，在 Unified 原地创建 Work Block：

~~~text
maka-agent / 登录超时修复 · 处理中…
~~~

回答与工具状态流入该 Work Block，同时写入目标 Session。用户无需导航。

### 5.3 形成新 Work

用户输入：

~~~text
检查登录超时并修掉。
~~~

若没有足够匹配的已有 Work，系统自动创建普通 Session，并显示轻量标识：

~~~text
新工作 · maka-agent / 登录超时修复
~~~

不显示“已创建 Session”。新 Work 立即出现在普通 Session 列表与全局搜索中。

### 5.4 未知 Workspace 或 Project

若用户指向的内容不属于已注册 Maka Workspace 或 Project：

1. 不扫描整台电脑；
2. 解释未找到已注册范围；
3. 询问是否打开或注册新的 Workspace/Project；
4. 用户完成选择后再形成 Work。

附件路径是强信号。附件位于未知范围时同样先请求注册，不能先消费 attachment approval 或创建目标 Session artifact。

### 5.5 跨 Work 执行

用户输入：

~~~text
后端把返回字段改成 userId，前端调用也一起更新。
~~~

系统展示有界范围：

~~~text
将处理两项工作：
1. api-workspace / 用户接口：修改契约与测试
2. web-workspace / 登录前端：等待新契约后更新调用
~~~

用户确认范围后创建 Coordination Graph。A 完成后才解锁 B；无依赖 Work 可以并行。

### 5.6 多 Work 并行

不同 Work 使用独立 Work Block，绝不混进同一 assistant bubble：

~~~text
maka-agent / 登录超时修复 · 处理中…
web / 营销站按钮调整 · 等待中
docs / 发布说明 · 已完成
~~~

Work Block 原地更新状态。用户不在 Unified 页面时，完成或失败遵守现有系统通知设置；窗口内不重复通知。

### 5.7 权限与问题交互

每个 permission request、sandbox expansion 或 user question 都显示在所属 Work Block 中，复用现有卡片交互。

- 通过卡片回答时强绑定对应 Work；
- 主输入框输入“可以”而同时存在多个等待项时，必须追问对象；
- 用户可在 Unified 中查看并修改目标 Session 的 permission mode；
- 修改持久化到目标 Session，不是 Unified 的临时 override。

## 6. 状态模型

### 6.1 Unified turn disposition

每次输入最终进入一个明确 disposition：

~~~ts
type UnifiedTurnDisposition =
  | { kind: 'discussion' }
  | { kind: 'clarify'; candidates: WorkRef[] }
  | { kind: 'resume_work'; work: WorkRef }
  | { kind: 'create_work'; workspaceId: string; projectId?: string }
  | { kind: 'coordinate'; works: WorkRef[]; planId: string };
~~~

这个 union 是持久决策，不是 renderer 临时状态。对于会修改文件或产生外部副作用的 turn，disposition 必须在 skill preparation、附件 ingest 与 Runtime 启动之前确定。

### 6.2 Work Block 状态

产品层状态保持有界：

~~~ts
type WorkBlockStatus =
  | 'queued'
  | 'processing'
  | 'needs_user'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'stopped';
~~~

状态来自目标 Session、Graph 与 Runtime 的权威事实投影。Unified 不发明第二套运行状态机。

### 6.3 Work 生命周期

- **Active**：参与自动 referent 识别和普通执行。
- **Archived**：仍可搜索、联想和总结；开始新执行时自动恢复，并显示轻量提示。
- **Deleted**：transcript、Unified Projection、路由摘要、检索索引与 Graph 可恢复引用级联清理；只可保留无内容 tombstone。

## 7. 全局范围、隐私与可用性

### 7.1 范围

Target 范围是 Maka 已注册的全部 Workspace，不是当前打开目录，也不是磁盘扫描结果。

当前 Desktop 在 `boot.ts` 中固定组合 `userData/workspaces/default`，而 `ProjectCatalog` 在这个 Workspace 内管理多个 Project。跨 Workspace Target 因此需要新的 app-level Workspace registry，并把当前单 root composition 抽成多个可加载 Workspace host。

Workspace identity 必须稳定。所有全局引用都使用复合 identity：

~~~ts
interface WorkRef {
  workspaceId: string;
  sessionId: string;
}
~~~

不能假定 session ID 在不同 Workspace 间全局唯一。

### 7.2 Workspace 不可用

已注册但路径移动、磁盘未挂载或 host 启动失败时：

- 若 workspace-owned summary 可读，可以回答历史摘要；
- 禁止启动文件或工具执行；
- Work Block 进入 blocked；
- 提供重新连接、重新定位或稍后重试。

### 7.3 现有隐身模式

Current 隐身模式是 Workspace 级 `incognitoActive` 开关，没有 TTL，也不是匿名 Session。它当前暂停本地记忆读写、会话搜索、联网搜索、计划提醒、自动化与系统通知，但不会自动删除 Session transcript。

Unified 必须继承现有 privacy authority：

- 隐身 Workspace 不进入全局候选召回、背景摘要或通知；
- renderer 不能自报隐身状态；
- 进入具体 Focused View 后，Session transcript 仍按现有规则读取；
- 不新增第二个 Unified 隐私开关。

## 8. Authority 与不可破坏的 invariant

1. **Session store 拥有工作 transcript。** Unified 只保存 Discussion、binding 和 projection reference。
2. **RuntimeEvent Log 拥有执行事实。** Unified 与 Graph 只投影 committed facts。
3. **目标 Session 拥有模型和权限。** Unified 为新 Work 提供默认值，并可显式调用现有 Session 设置路径。
4. **Workspace privacy authority 仍在 main/host。** Unified 不合并或缓存可绕过隐身策略的数据。
5. **一个 turn 只能有一个工作 authority。** 跨 Work 输入由 Coordination Graph 拆成多个明确 Work turn。
6. **附件先绑定，后 ingest。** 未确定目标 Work 前不消费 approval token，不写 artifact。
7. **删除必须可证明。** 所有 derived data 带 provenance，能按 WorkRef 级联 purge。
8. **Focused Session 保持正常。** Unified 不改变已有 Session 的 send、stop、revision、read 或 recovery 语义。
9. **不注入所有历史。** referent resolution 使用有界候选与摘要，模型上下文只加载命中的 Work。
10. **低置信度副作用 fail closed。** 不明确时询问，不静默尝试。

## 9. 目标架构

### 9.1 分层

~~~mermaid
flowchart TD
    UI["Unified Session UI"] --> WO["Work Orchestrator"]
    WO --> WR["Workspace Host Registry"]
    WR --> H1["Workspace Host A"]
    WR --> H2["Workspace Host B"]
    H1 --> S1["Session / Runtime / Project Catalog / Privacy"]
    H2 --> S2["Session / Runtime / Project Catalog / Privacy"]
    WO --> UP["Unified Conversation + Projection Store"]
    WO --> CG["Coordination Graph"]
    CG --> H1
    CG --> H2
~~~

Unified Session UI 是一个普通对话外壳。复杂性集中在 Work Orchestrator deep module；renderer 不实现候选检索、置信度、workspace availability、archive restore 或跨 Work 调度。

这张纵向组件图回答 ownership 与 authority；一次输入的横向决策流则是
`Intent → Recall → Action → Gate → Execute → Project`。两者不是两套架构：组件图定义决策发生在哪里、谁有权做，流水线定义决策按什么顺序发生。Work Orchestrator 是交点，但具体分类、召回、策略与 Gate 都是它的内部 module，不扩张 external interface。

### 9.2 Work Orchestrator external interface

外部 seam 保持小：命令进入，typed event 出来。

~~~ts
interface WorkOrchestrator {
  handle(command: UnifiedCommand): Promise<UnifiedCommandResult>;
  subscribe(listener: (event: UnifiedEvent) => void): () => void;
}

type UnifiedCommand =
  | { kind: 'submit'; turnId: string; text: string; attachments?: PendingAttachment[] }
  | { kind: 'answer_interaction'; work: WorkRef; requestId: string; answer: unknown }
  | { kind: 'set_permission'; work: WorkRef; mode: PermissionMode }
  | { kind: 'stop_work'; work: WorkRef }
  | { kind: 'stop_all' };
~~~

调用者不需要知道 routing pipeline、Workspace host 数量、候选索引、Graph topology 或 projection schema。测试也通过同一 interface。

### 9.3 Workspace Host internal seam

每个 Workspace Host 封装一个 Workspace 的：

- SessionManager 与 SessionStore；
- ProjectCatalog；
- Agent Graph coordinator；
- RuntimeEvent/AgentRun stores；
- privacy authority；
- attachment、artifact、skill preparation 与 permission interaction；
- Session 和 Runtime event subscription。

Work Orchestrator 通过内部 `WorkspaceHostPort` 调用这些能力。生产 adapter 包装真实 host；测试 adapter 使用内存 stores。这个 seam 是真实的，因为同一 Orchestrator 同时面对多个生产 Workspace adapter，并需要本地替身测试。

### 9.4 为什么不放进 SessionManager

SessionManager 的 public facade 以一个 session store 和 runtime composition 为中心。跨 Workspace referent resolution、多个 host lifecycle 和 Coordination Graph 不属于单 Session lifecycle。把它们放进 SessionManager 会让一个 Workspace 内的 Runtime authority 变成全局 product brain。

Work Orchestrator 应位于 Desktop main 的 host-level composition；只有稳定纯类型进入 `@maka/core`。若未来 CLI、bot 或 remote host 成为第二个正式 caller，再把实现提取到共享 package。

## 10. 持久数据

### 10.1 App-level Workspace Registry

保存已注册 Workspace 的稳定 identity、展示名、位置与可用性元数据。它不复制 Workspace 内 transcript、凭据或 privacy state。

### 10.2 Unified Conversation Store

保存：

- Unified Session identity 与 feature state；
- Discussion messages；
- Work Block identity 与顺序；
- Turn Binding；
- 目标内容的 reference/provenance；
- Coordination Graph reference；
- read state 与无内容 tombstone。

不保存目标 Session 完整 assistant/tool transcript。Focused content 在渲染或流式执行时由 Workspace Host 投影。

### 10.3 Turn Binding

~~~ts
interface UnifiedTurnBinding {
  bindingId: string;
  unifiedTurnId: string;
  work: WorkRef;
  targetTurnId: string;
  origin: 'unified';
  disposition: 'resume_work' | 'create_work' | 'coordinate_child';
  createdAt: number;
  basis: RoutingBasis[];
}
~~~

`basis` 是内部诊断与纠错依据，不默认展示置信度。它不得包含无界 transcript 或 secret。

### 10.4 Work descriptor 与摘要

候选检索使用 Workspace-owned、可删除、可重建的 Work descriptor：

- Session title；
- Project identity 与 cwd hints；
- labels；
- 最近活动时间与状态；
- 有界背景摘要；
- Goal/blocked/interaction 状态；
- privacy/archive 标记。

全局层最多缓存 derived metadata。任何 cache 都必须携带 WorkRef、source revision 与 purge path，不能成为隐藏的第二份记忆。

## 11. Referent resolution pipeline

代码中的决策流水线固定为四个内部 contract：

~~~ts
interface IntentClassifier {
  classify(context: DecisionContext): IntentResult;
}

interface WorkRetriever {
  recall(intent: IntentResult, context: DecisionContext): Promise<WorkRecall>;
}

interface ActionPolicy {
  select(intent: IntentResult, recall: WorkRecall, context: DecisionContext): Promise<ActionProposal>;
}

interface ActionGate {
  evaluate(proposal: ActionProposal, recall: WorkRecall, context: DecisionContext): Promise<GateDecision>;
}
~~~

`ActionProposal` 不能产生副作用。只有 `ActionGate` 返回 `allow` 后，Orchestrator 才能创建或恢复 Work、启动 Runtime；`clarify` 和 `block` 都留在无执行路径。每次流水线结果产生有界 `DecisionTrace`，记录 intent、候选 identity、proposal、Gate 结果、证据与 policy version，不记录完整 transcript 或 secret。

优先级固定：

1. **硬绑定**：回复某 Work Block、permission card、interaction card、显式 Work mention。
2. **资源绑定**：附件路径、引用 artifact、Project/Workspace identity。
3. **连续性**：Work Focus 与“继续、改一下、再跑一次”等 follow-up。
4. **实体匹配**：Work 名、Project 名、文件、任务、人物或稳定术语。
5. **候选召回**：各 Workspace Host 返回有界候选。
6. **模型 rerank**：在候选上判断 resume/create/discussion/clarify/coordinate。
7. **副作用 gate**：目标或范围不明确时 fail closed。

Current `search/thread-search.ts` 可提供首版 lexical signal，但它是当前 Workspace 内有界 substring scan，并受隐身模式 gate；它不能直接承担全局 referent authority。

路由结果不得仅由 LLM 自由生成 session ID。模型只能从系统提供的 candidate identity 中选择，或返回 create/discussion/clarify/coordinate。

## 12. 发送与流式事件

Current `sessions:send` 在 `sessions-ipc-main.ts` 中先进行 skill preparation，再解析附件，最后调用 `runtime.sendMessage(sessionId, ...)`。Unified 的 target resolution 必须发生在这条链路之前。

推荐把现有 per-session send 主体提取为可复用的 `dispatchResolvedSessionTurn()`：

~~~text
Unified submit
  → resolve disposition and WorkRef
  → ensure Workspace Host available
  → prepare Skill against target Session
  → ingest attachments into target Session
  → dispatch existing Runtime turn
  → bind target Turn
  → multiplex target events into Work Block
~~~

Work Orchestrator 订阅目标 Session 的事件，并增加 envelope：

~~~ts
interface UnifiedEventEnvelope {
  blockId: string;
  work: WorkRef;
  turnId: string;
  event: SessionEvent;
}
~~~

renderer 不应在发送后临时切换 active session 再订阅；那会产生首 token race，并把路由知识泄漏进 UI。

## 13. Coordination Graph

### 13.1 复用边界

Current Agent Graph 已有 operator、edge、readiness、claim、supervisor wake 与 RuntimeEvent reference projection。这些调度语义应复用。

Current Graph 由 `agentGraphIdForRootSession(rootSessionId)` 派生 namespace，并假定一个 root Session/Workspace composition；没有原生 `parentGraph/childGraph` contract。因此 Target 不是声称“现有 Graph 已经支持嵌套”，而是新增外层 Coordination Graph composition。

### 13.2 外层与内层

~~~text
Unified Coordination Graph
├── Work A（Workspace A / Session A）
│   └── 可拥有内部 Agent Graph
└── Work B（Workspace B / Session B）
    └── 可拥有内部 Agent Graph

A completed → 解锁 B
~~~

外层 operator identity 是 WorkRef，不是 child Session 的本地 session ID。外层 Graph 只协调 Work lifecycle、依赖、blocked/failed/completed 与重试，不复制内部 Runtime。

### 13.3 失败与恢复

- 上游失败时，下游保持 blocked；
- 用户修复后从失败节点继续，不重跑已成功节点；
- 不自动回滚成功 Workspace 的文件修改；
- scope 扩大时重新确认；
- stop 单个 Work 只停止对应节点；
- “停止全部”是二级操作并要求确认；
- 重启后从 Graph control facts 与各 Workspace Runtime facts 重建 Work Block。

并发沿用 Graph/Runtime 容量。超出容量的 Work 显示 queued，不无限并发、不丢弃。

## 14. 模型、权限与修订

### 14.1 模型

- Unified 配置控制 Work Orchestrator model，并作为新 Work 默认模型；
- 已有 Work 保留自己的 connection/model/thinking level；
- Unified 不静默修改目标 Session sticky model；
- 目标 Work 的回答由该 Session model 产生。

### 14.2 权限

- 新 Work 继承 Unified 当前默认 permission mode；
- 已有 Work 使用自己的 permission mode 与 execution boundary；
- 所有工具、文件、sandbox expansion 继续走目标 Session 现有 gate；
- 用户可在 Work Block 中调用现有 `setPermissionMode` 修改目标 Session；
- Unified 自身不获得所有 Workspace 的 bypass 权限。

### 14.3 Revision

单 Work Block 的编辑、重新生成和 branch 复用目标 Session revision family。已部分执行的跨 Work Graph 不重写历史；编辑原指令产生修订计划，并从安全节点继续。

## 15. 已读、归档、删除与搜索

### 15.1 已读

同一 target turn 共享 read state。在 Unified 实际展示后，目标 Session 视为已读；只收到系统通知但未打开内容时仍为未读。

### 15.2 归档

归档 Work 仍可参与全局搜索与 referent resolution。若新执行明确命中它，先恢复 Session，再开始 Runtime turn，并显示“继续已归档工作”。

### 15.3 删除

删除必须按 provenance 级联：

1. Session transcript 与 metadata；
2. Unified Turn Binding 与 Work Projection；
3. Work descriptor、summary 与 search index；
4. Coordination Graph 中可恢复的内容引用；
5. completion/blocked notification payload；
6. cache 与 derived projection。

Unified 可以保留无内容 tombstone 维持时间线顺序，但不能留下标题、摘要、snippet 或可反推出已删除内容的文本。

### 15.4 全局搜索

搜索覆盖所有已注册且 privacy 允许的 Workspace、普通 Session 与归档 Work。结果显示 `Workspace / Work`，点击进入 Focused View。删除和隐身内容不进入结果。

## 16. UI contract

### 16.1 Work Block

每个 Work Block 至少包含：

- Workspace/Work 标题；
- queued/processing/needs_user/blocked/completed/failed/stopped 状态；
- 流式 assistant content；
- tool/permission/user-question 交互；
- stop；
- 打开 Focused View；
- 目标 Session permission mode 控制。

### 16.2 Completion 与背景事件

普通 Session 中直接产生的内容不回灌 Unified。只投影：

- completed；
- blocked/failed；
- needs_user。

这些事件生成可点击的轻提示，不伪装成新的 assistant 回答。

### 16.3 导航

- 冷启动默认 Unified、侧栏收起；
- 用户展开后，当前使用期间保持；
- Focused View 是真正页面跳转；
- 顶部提供返回 Unified；
- Work Block、通知、全局搜索都可进入同一 Focused View。

## 17. 失败策略

| 情况 | 行为 |
|---|---|
| referent 模糊且只讨论 | 继续澄清，不创建 Work |
| referent 模糊且将修改文件 | 先确认 Workspace/Work |
| 同时多个 interaction，用户只说“可以” | 追问目标，不猜 |
| Workspace 未注册 | 询问是否打开/注册 |
| Workspace 不可用 | block，提供重连或重定位 |
| target Session archived | 恢复后执行 |
| target Session deleted | 不召回；按新 Work 处理或澄清 |
| Graph 上游失败 | 下游 blocked |
| event stream 中断 | 从 Session/Runtime authority 恢复 projection |
| projection store 损坏 | 从 Discussion store、Turn Binding 与 Workspace facts 重建；不可证明时 fail closed |
| 模型返回未知 session ID | 拒绝；只能选择系统候选 |

错误路由已经产生副作用时，不静默移动消息或假装撤销。明确说明实际执行的 Workspace/Work，并提供检查、恢复或继续选择。

## 18. 代码落点建议

### 18.1 Core contracts

新增 `packages/core/src/unified-session.ts`：

- WorkRef；
- UnifiedCommand/Result/Event；
- disposition 与 Work Block 状态；
- Turn Binding/provenance codec；
- runtime shape guards。

### 18.2 Desktop main

新增 `apps/desktop/src/main/unified-session/`：

- `work-orchestrator.ts`：唯一 deep module；
- `decision/decision-pipeline.ts`：串联 Intent、Recall、Action 与 Gate；
- `decision/intent-classifier.ts`：提取硬绑定、交互与执行信号；
- `decision/work-retriever.ts`：按 Workspace privacy/availability 召回有界候选；
- `decision/action-policy.ts`：确定性策略与受限模型策略的 seam；
- `decision/action-gate.ts`：执行前唯一许可出口；
- `decision/decision-types.ts`：内部 contract 与有界 Decision Trace；
- `workspace-host-registry.ts`：全局 registry 与 host lifecycle；
- `workspace-host-adapter.ts`：包装每个 Workspace 的现有 runtime；
- `model-intent-resolver.ts`：只在有界候选上做模型语义判断；
- `unified-projection-store.ts`：Discussion、binding、block 与 tombstone；
- `coordination-graph.ts`：外层 Graph composition；
- `unified-events.ts`：多 Session event multiplexing。

`boot.ts` 需要把当前单 Workspace store/runtime/Graph 创建流程提取成可加载 Workspace Host。这个重构是跨 Workspace 能力的前置，不应藏在 renderer。

### 18.3 Existing send seam

从 `sessions-ipc-main.ts` 提取已解析目标后的发送实现。普通 `sessions:send` 与 Unified submit 共用它，避免两套 skill、attachment、voice、revision 与 stream 语义。

### 18.4 Renderer

在 `app-shell-chat-actions.ts` 外增加 Unified owner，而不是伪造 active Session ID。renderer state 以 `blockId + WorkRef + turnId` 索引并行流。

侧栏继续使用现有 Session list。功能开启时只改变冷启动 selection 与默认 collapsed state。

## 19. 交付顺序

跨 Workspace 是首个可用版本的正式范围，不交付 current-workspace-only 产品假象。实现可按内部阶段拆分：

### Phase 0：Contract 与 host foundation

- Core types、codec、provenance 与 tests；
- app-level Workspace registry；
- 把单 Workspace boot composition 提取为 Workspace Host；
- 多 host list/read/send/subscribe smoke test。

### Phase 1：Unified 基本闭环

- 永久 Unified entry 与 feature toggle；
- 冷启动默认与侧栏行为；
- Discussion store；
- 显式 mention、硬绑定、Work Focus；
- existing Work route 与新 Work 创建；
- Work Block stream multiplexing；
- Focused View 往返。

### Phase 2：Referent 与生命周期

- 跨 Workspace candidate retrieval；
- bounded summary 与 model rerank；
- archive restore、delete cascade、shared read state；
- permission cards 与 target permission control；
- low-noise completion/blocked/needs-user events；
- global search。

### Phase 3：Coordination Graph

- 跨 Work scope preview；
- outer operator identity 与 dependency edges；
- blocked/retry/resume/stop；
- Work 内部 Graph composition；
- crash recovery 与 projection rebuild。

### Phase 4：Hardening

- incognito/privacy audit；
- wrong-binding recovery；
- unavailable Workspace/relink；
- performance budget、candidate caps 与 concurrency pressure；
- full E2E matrix。

## 20. 验收条件

首个正式版本至少满足：

1. 功能开启后，冷启动进入唯一 Unified，侧栏收起。
2. 用户可展开侧栏、进入普通 Session，并返回 Unified。
3. 模糊 Discussion 不创建 Session。
4. 明确新工作自动创建普通 Session，显示轻量“新工作”。
5. 可直接继续另一个已注册 Workspace 中的 Work，无需页面切换。
6. 每个回答块显示 Workspace/Work/status，不混流。
7. Unified 发起的工作 turn 在目标 Session 可见；Focused View turn 不整段回灌 Unified。
8. 两个 Work 可并行，分别完成、失败或等待交互。
9. 权限卡片绑定正确 Work；可从 Unified 修改目标 Session permission mode。
10. 跨 Work A→B 只有 A completed 后 B 才运行；A failed 时 B blocked。
11. archived Work 可召回并恢复；deleted Work 无法再被摘要、搜索或路由。
12. shared read state、stop、revision、notification 与 feature toggle 可逆。
13. 隐身 Workspace 不进入全局召回、搜索或通知。
14. 未注册 Workspace 会请求用户打开/注册，不扫描磁盘。
15. 重启后能从持久 authority 恢复 Work Block 与 Coordination Graph 状态。

## 21. 非目标

- 把所有 Session transcript 合成一个聊天记录；
- 把所有历史注入每次模型上下文；
- 删除或隐藏普通 Session 能力；
- 用一个 cwd 或一个 permission mode 覆盖全部 Work；
- 让 Unified 绕过目标 Session sandbox；
- 扫描用户整台电脑寻找未知工作；
- 建立第二套 RuntimeEvent、AgentRun 或 Session state machine；
- 把 Coordination Graph 做成通用可视化 workflow editor；
- 自动回滚跨 Workspace 已成功的真实副作用；
- 首版解决跨设备云同步。

## 22. 尚待实现阶段决定的参数

以下不是产品开放问题，可在实现与评审中按测量结果确定：

- candidate 数量、摘要长度与 freshness budget；
- rerank 模型及 fallback；
- Workspace Host 并发与 idle eviction；
- Graph 最大并发数；
- app-level store 的具体文件名与 schema migration；
- Work Block 动效与最终中文文案。

这些参数不得改变本文已经固定的 authority、隐私、投影、删除和权限 invariant。
