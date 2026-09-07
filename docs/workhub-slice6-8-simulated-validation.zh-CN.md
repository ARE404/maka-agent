<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# WorkHub Slice 6 / Slice 8 中文模拟验收记录

> 历史记录：以下模拟描述的是重构前的整体 routing strategy 实验。
> 当前实现已改为独立 Intent / Resolver 组合，共用固定 Policy / Gate；
> 旧 R3 disposition 描述和 Gate 集成表述不代表当前架构或真实 Host 验证。
> 当前组件契约与组合表以 `workhub-domain-language.md` 为准，当前验证以 PR 最新 head 为准。

本记录按实验分支上的《WorkHub 中文手工验收指南》逐项模拟，但被测对象是正式的
**Coordination Session WorkHub**。旧指南包含 Unified Session experiment 的 Work 色彩、
消息级 Anchor Rail、纠错学习和跨 Work 依赖图；这些不能当成正式 tracking issue 已承诺的能力。

## 测试环境

| 项目 | 记录 |
| --- | --- |
| 分支 | `codex/workhub-slice6-8` |
| 被测提交 | `e4420dfc4`（对抗审查修复后） |
| 基线 | `upstream/main` @ `dd7d1d595` |
| 操作系统 | macOS |
| 测试时间 | 2026-09-06（Asia/Shanghai） |
| 模型 | 固定 fake model port；未声称真实模型结果 |
| 测试方式 | controller / Action Gate 壳集成模拟、静态 Rail 渲染、生产构建；Electron 窗口测试见阻塞项 |

当前 GitHub 状态也在测试前重新核对：tracking issue #3492 仍为 OPEN；进行中的
#4713 提供命名 `resume_work`，但尚未合入 `main`，且当前显示为 CONFLICTING；#4819 是
决策流水线的文档映射。为了不复制或偷偷改写正在审查的 #4713，本分支没有把它合并进来。
因此这里的“基础体验”结论只覆盖 `main + Slice 6 + Slice 8`，恢复中断工作仍依赖 #4713。

## 模拟结果

结果只使用 `通过`、`失败`、`阻塞`、`不适用`。其中“通过（自动）”说明行为由用户输入级
测试穿过正式 controller / Action Gate 路径验证，不等价于真实模型和桌面窗口手测。

| 编号 | 结果 | 实际行为与证据 | 与旧 experiment 指南的差异 |
| --- | --- | --- | --- |
| SETUP | 通过（自动） | 明确的新工作指令经 `create_new` 创建普通 Session，标题去除过程性措辞；guide topic 集成用例覆盖支付、布局和登录主题。 | 不显示旧版 Work 标识色。 |
| WH-01 | 通过（自动） | 完整 Session 名称直接路由到唯一已有 Session，不新建、不澄清，并经 Action Gate 的 `candidateRef` 提交。 | 正式版不展示“高置信度”标签。 |
| WH-02 | 通过（自动） | “继续它”使用当前 visit focus；提交后 controller 投影出的 `focusSessionId` 同步更新，Rail 标记真实当前目标。 | Rail 是工作导航，不是消息刻度。 |
| WH-03 | 通过（自动） | 先切到支付，再输入“回到上一个工作”，路由回登录 Session。 | 无旧版置信度 UI。 |
| WH-04 | 通过（自动） | `routingEvidence` 从普通 Session 权威日志重建 origin prompt；强核心证据可覆盖最近焦点，候选冲突则澄清。 | 没有独立的 Work 记忆数据库。 |
| WH-05 | 通过（自动） | “继续处理重复问题”在登录/支付两个真实候选间返回 clarification；未自动执行或创建。 | 选择结果由 Coordination Session / Action Gate 持久化，不使用旧版置信度卡语义。 |
| WH-06 | 不适用 | 正式版已覆盖 linked correction：原 delegation 被精确替换，错误目标不会继续；但不会把“青鸟检查点”写入独立的纠错学习记忆。 | “纠错后学习别名”未进入 #3492 Slice 6/8，不能伪报通过。 |
| WH-07 | 不适用 | Slice 8 的筛选只筛选由普通 Session facts 重建的工作导航投影；它不把 Composer 绑定到筛选目标。 | 旧指南要求筛选整个消息时间线并直接工作，这是 experiment UX，不是当前 Slice 8 contract。 |
| WH-08 | 不适用 | 当前 Anchor Rail 按 focus、active delegations、Session state 和 recency 生成，去重且最多 8 项；20 个匹配项显示 `8/20 anchors · 20 total`。 | 旧指南要求普通 Session 同款的消息刻度、hover 摘要和滚动同步；当前 Rail 是 Session 导航。 |
| WH-09 | 阻塞 | 静态/集成路径证明 assignment 和 Rail 都能调用 `onOpenSession`；真实窗口中的进入、返回、滚动恢复未完成。 | Electron fixture 在测试正文前超时，不能用静态渲染替代桌面验收。 |
| WH-10 | 不适用 | 单输入有且只有一个 disposition；没有创建跨 Work 依赖图。 | #3492 明确把 full cross-Work dependency planning 列为首个里程碑 non-goal。 |
| WH-11 | 通过（自动） | `waiting_for_user` 阻止第二个 root Turn，返回可理解的 waiting 结果；surface 保留 Composer 草稿，retry 仍经过 durable Action Gate replay。 | #4713 的“恢复已中断 delegated work”是另一条尚未合入的能力。 |
| EXTRA | 阻塞 | Runtime-owned candidate set 保留 workspace 身份，模型只看到 bounded opaque refs；未在两个真实 Workspace 中跑窗口流程。 | 首个里程碑仍不做跨 Runtime Host 协调。 |

## Slice 6 对照实验平台模拟

`runWorkHubRoutingExperiment` 使用一个冻结的 Session snapshot、Coordination transcript、
Runtime fixture 和同一个 model port，依次创建 R2.4、R3-A、R3-B 的新 visit，并可重复运行。
集成测试执行 2 次重复、3 个策略，共得到 6 个观察值；三种策略都通过同一个
`createWorkHubController` 和 Action Gate 壳把输入提交到支付 Session。R3-A 与 R3-B 共调用
同一 model port 4 次。这里没有计算准确率、延迟、tokens、成本或选出 winner——这些仍属于
明确跳过的 Slice 7。

## 消融与对抗审查记录

消融基线相对 `upstream/main` 为 17 个文件、`+2348/-629`；数字包含把约 600 行既有
route policy 移入 WorkHub feature 边界的机械移动。

- 删除 active-delegation 优先投影后，5 个 Anchor 测试中 2 个失败；保留该机制。
- 删除 trusted `allowCreate` 解码门后，普通模型请求可变成 `new_session`；保留该门。
- 删除 12 个 model candidate 上限后，模型收到 14 个候选；保留边界。
- 删除只做转发的旧 `workhub-route-policy.ts` seam，减少 52 行，并让消费者只依赖
  `features/workhub` public API；全部回归仍通过。

对抗审查发现并已修复：缺少可执行的 Slice 6 对照壳、Rail 当前焦点使用初始值、可见锚点
计数误导、Rail 文案未进入 validated `UiCatalog`、新按钮未使用 `@maka/ui` primitive。审查还
确认没有第二套 authority、完整 transcript 复制、跨 Host 扩权、R3-B 隐式创建或绕过 Gate。

## 验证结果与阻塞

- WorkHub 聚焦测试：111 passed；Core SessionResolver：3 passed。
- `npm run lint`、`npm run format:check`、`git diff --check`：通过。
- Desktop main build、renderer production build、renderer TypeScript check：通过。
- `npx knip --workspace apps/desktop`：通过。
- renderer architecture：101 fixture tests 通过，并通过 `upstream/main` 增量检查。
- 全 Desktop `typecheck` / test build 仍被未改动的 `packages/ui` Astryx props 类型错误阻塞；
  在 detached `upstream/main` 基线上可复现同类错误，因此不归因于本分支。
- `workhub-layout.spec.ts` 的 3 个 Electron E2E，以及单独重试 Anchor Rail 用例，均在 fixture
  的 `window` setup 阶段超时，未进入测试正文。用户级 state-root 中约有 22,268 个
  `state-root-owners` 锁文件；未删除或修改这些用户 authority 文件。因此 WH-09、EXTRA 和
  真实视觉验收保持 `阻塞`，不能记为通过。

## 结论

正式 `main + Slice 6 + Slice 8` 的安全基础环已经形成：统一 Coordination conversation、
确定性/模型策略可在同一 Gate 下对照运行、现有工作可安全路由或澄清、waiting 不产生第二个
root Turn，并有 bounded、可筛选的工作导航 Rail。

它不等于旧 Unified Session experiment 的完整体验，也不应声称通过旧指南的最低门槛：
WH-06 的纠错学习、WH-07 的筛选后 Composer 绑定、WH-08 的消息级 Rail、WH-10 的跨 Work
依赖图都不属于当前正式 Slice 6/8；WH-09 的真实桌面往返仍受环境阻塞。此外，中断后恢复
要等 #4713 解决冲突并合入后，才能纳入“完整基础体验”的最终窗口验收。
