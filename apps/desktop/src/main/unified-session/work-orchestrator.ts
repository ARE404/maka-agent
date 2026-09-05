import { randomUUID } from 'node:crypto';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionEvent } from '@maka/core/events';
import type { SandboxBoundaryResponse, UserQuestionResponse } from '@maka/core';
import type {
  UnifiedCoordinationDraftStep,
  UnifiedCoordinationPlan,
  UnifiedCoordinationStep,
  UnifiedDiscussionMessage,
  UnifiedRouteOption,
  UnifiedSendInput,
  UnifiedSendResult,
  UnifiedSnapshot,
  UnifiedWorkBlock,
  UnifiedWorkContentProjection,
  UnifiedWorkEndedEvent,
  WorkRef,
} from '@maka/core/unified-session';
import type { UnifiedProjectionStore } from './projection-store.js';
import { createActionGate } from './decision/action-gate.js';
import { createActionPolicy, resolveUnifiedIntent } from './decision/action-policy.js';
import { createDecisionPipeline } from './decision/decision-pipeline.js';
import { createIntentClassifier } from './decision/intent-classifier.js';
import type {
  DecisionPipeline,
  DecisionTrace,
  UnifiedIntentResolver,
  WorkCandidate,
  WorkspaceHostDirectory,
  WorkspaceHostPort,
} from './decision/decision-types.js';
import { createWorkRetriever } from './decision/work-retriever.js';

export { resolveUnifiedIntent };
export type {
  UnifiedIntentResolver,
  UnifiedIntentResolverInput,
  UnifiedTargetEvent,
  WorkCandidate,
  WorkspaceHostDirectory,
  WorkspaceHostPort,
} from './decision/decision-types.js';

export interface WorkOrchestrator {
  snapshot(): Promise<UnifiedSnapshot>;
  send(input: UnifiedSendInput): Promise<UnifiedSendResult>;
  readWorkProjection(work: WorkRef, turnId: string): Promise<UnifiedWorkContentProjection>;
  respondToSandboxBoundary(work: WorkRef, response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(work: WorkRef, response: UserQuestionResponse): Promise<void>;
  setPermissionMode(work: WorkRef, mode: PermissionMode): Promise<void>;
  stopWork(work: WorkRef): Promise<void>;
  confirmCoordination(planId: string): Promise<UnifiedCoordinationPlan>;
  cancelCoordination(planId: string): Promise<UnifiedCoordinationPlan>;
  requestRetarget(blockId: string): Promise<UnifiedDiscussionMessage>;
  recover(): Promise<void>;
  observeSession(sessionId: string): Promise<void>;
  observeSessionEvent(sessionId: string, event: SessionEvent): Promise<void>;
  purgeSession(sessionId: string): Promise<void>;
  subscribe(listener: (snapshot: UnifiedSnapshot) => void): () => void;
  subscribeEvents(
    listener: (event: { blockId: string; work: WorkRef; event: SessionEvent }) => void,
  ): () => void;
  subscribeWorkEnded(listener: (event: UnifiedWorkEndedEvent) => void): () => void;
}

export function createWorkOrchestrator(deps: {
  projections: UnifiedProjectionStore;
  hosts: WorkspaceHostDirectory;
  resolveIntent?: UnifiedIntentResolver;
  decisionPipeline?: DecisionPipeline;
  onDecisionTrace?: (trace: DecisionTrace) => void;
  answerDiscussion?: (
    text: string,
    snapshot: UnifiedSnapshot,
    turnId: string,
  ) => Promise<string>;
  defaultPermissionMode: () => Promise<PermissionMode>;
  now?: () => number;
  createId?: () => string;
  onError?: (error: unknown) => void;
  recoveryPollMs?: number;
}): WorkOrchestrator {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;
  const resolveIntent = deps.resolveIntent ?? resolveUnifiedIntent;
  const decisionPipeline = deps.decisionPipeline ?? createDecisionPipeline({
    intentClassifier: createIntentClassifier(),
    workRetriever: createWorkRetriever(deps.hosts),
    actionPolicy: createActionPolicy(resolveIntent),
    actionGate: createActionGate(),
    ...(deps.onDecisionTrace ? { onTrace: deps.onDecisionTrace } : {}),
  });
  const listeners = new Set<(snapshot: UnifiedSnapshot) => void>();
  const eventListeners = new Set<
    (event: { blockId: string; work: WorkRef; event: SessionEvent }) => void
  >();
  const workEndedListeners = new Set<(event: UnifiedWorkEndedEvent) => void>();
  const coordinationRuns = new Map<string, Promise<void>>();
  const recoveredBlockMonitors = new Set<string>();
  const activeUnifiedWorks = new Set<string>();
  const suppressedUnifiedLifecycle = new Map<
    string,
    { status: UnifiedWorkBlock['status']; remaining: number }
  >();
  const observedLifecycleStatus = new Map<string, UnifiedWorkBlock['status']>();
  const unifiedTurnIds = new Set<string>();
  const unifiedTurnIdOrder: string[] = [];
  const lifecycleObservationQueues = new Map<string, Promise<void>>();
  const observedRunningTurnIds = new Set<string>();
  const activeDiscussionReplies = new Set<string>();
  const recoveryPollMs = deps.recoveryPollMs ?? 1_000;

  async function publish(snapshot?: UnifiedSnapshot): Promise<UnifiedSnapshot> {
    const next = snapshot ?? (await deps.projections.read());
    for (const listener of listeners) listener(next);
    return next;
  }

  async function appendDiscussion(
    role: 'user' | 'assistant',
    text: string,
    options: Partial<Omit<UnifiedDiscussionMessage, 'id' | 'kind' | 'role' | 'text' | 'createdAt'>> = {},
  ): Promise<{ id: string; snapshot: UnifiedSnapshot }> {
    const id = createId();
    const snapshot = await deps.projections.append({
      id,
      kind: 'discussion',
      role,
      text,
      createdAt: now(),
      ...options,
    });
    await publish(snapshot);
    return { id, snapshot };
  }

  async function completeDiscussionReply(
    assistantId: string,
    userId: string,
    text: string,
    snapshot: UnifiedSnapshot,
  ): Promise<void> {
    if (activeDiscussionReplies.has(assistantId)) return;
    activeDiscussionReplies.add(assistantId);
    try {
      const answer = deps.answerDiscussion
        ? await deps.answerDiscussion(text, snapshot, assistantId)
        : '我先把这当作讨论。等目标和执行范围明确后，再开始具体工作。';
      await publish(await deps.projections.updateDiscussionMessage(assistantId, {
        text: answer,
        status: 'completed',
        replyToMessageId: userId,
      }));
    } catch (error) {
      deps.onError?.(error);
      await publish(await deps.projections.updateDiscussionMessage(assistantId, {
        text: '这次讨论回复被中断了。你可以继续发送消息，我会从现有上下文接着处理。',
        status: 'failed',
        replyToMessageId: userId,
      }));
    } finally {
      activeDiscussionReplies.delete(assistantId);
    }
  }

  async function updateBlock(
    blockId: string,
    patch: Partial<UnifiedWorkBlock>,
  ): Promise<void> {
    await publish(await deps.projections.updateWorkBlock(blockId, patch));
  }

  async function updatePlan(
    planId: string,
    patch: Partial<Pick<UnifiedCoordinationPlan, 'status' | 'updatedAt'>>,
  ): Promise<UnifiedSnapshot> {
    return publish(await deps.projections.updateCoordinationPlan(planId, patch));
  }

  async function updatePlanStep(
    planId: string,
    stepId: string,
    patch: Partial<UnifiedCoordinationStep>,
  ): Promise<UnifiedSnapshot> {
    return publish(
      await deps.projections.updateCoordinationStep(planId, stepId, patch, now()),
    );
  }

  async function executeWork(
    host: WorkspaceHostPort,
    candidate: WorkCandidate,
    block: UnifiedWorkBlock,
    text: string,
  ): Promise<UnifiedWorkBlock['status']> {
    let terminalStatus: UnifiedWorkBlock['status'] | undefined;
    let terminalDetail: string | undefined;
    const workKey = `${candidate.work.workspaceId}:${candidate.work.sessionId}`;
    activeUnifiedWorks.add(workKey);
    try {
      if (candidate.archived) await host.restoreWork(candidate.work);
      let observedStarted = false;
      let eventQueue = Promise.resolve();
      const started = await host.startTurn(candidate.work, text, (event) => {
        if (event.kind === 'session_event') {
          for (const listener of eventListeners) {
            listener({ blockId: block.id, work: candidate.work, event: event.event });
          }
          return;
        }
        if (
          event.kind === 'completed' &&
          terminalStatus &&
          terminalStatus !== 'completed'
        ) return;
        if (event.kind === 'started') observedStarted = true;
        if (event.kind === 'started') rememberUnifiedTurnId(event.turnId);
        if (
          event.kind === 'completed' ||
          event.kind === 'failed' ||
          event.kind === 'blocked' ||
          event.kind === 'stopped'
        ) {
          terminalStatus = event.kind;
          terminalDetail = event.detail;
        }
        const timestamp = now();
        eventQueue = eventQueue.then(() => {
          switch (event.kind) {
            case 'started':
              return updateBlock(block.id, {
                status: 'running',
                turnId: event.turnId,
                updatedAt: timestamp,
              });
            case 'running':
            case 'waiting_for_user':
            case 'completed':
            case 'failed':
            case 'blocked':
            case 'stopped':
              return updateBlock(block.id, {
                status: event.kind,
                updatedAt: timestamp,
                ...(event.detail ? { detail: event.detail } : {}),
              });
          }
        });
      });
      if (!observedStarted) {
        eventQueue = eventQueue.then(() =>
          updateBlock(block.id, {
            status: 'running',
            turnId: started.turnId,
            updatedAt: now(),
          }),
        );
      }
      await eventQueue;
      if (!terminalStatus) {
        terminalStatus = 'failed';
        await updateBlock(block.id, {
          status: terminalStatus,
          detail: '目标工作未报告完成状态。',
          updatedAt: now(),
        });
      }
      emitWorkEnded(block, terminalStatus, terminalDetail);
      return terminalStatus;
    } catch (error) {
      await updateBlock(block.id, {
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      });
      deps.onError?.(error);
      emitWorkEnded(block, 'failed', error instanceof Error ? error.message : String(error));
      return 'failed';
    } finally {
      activeUnifiedWorks.delete(workKey);
      if (terminalStatus) {
        suppressedUnifiedLifecycle.set(workKey, { status: terminalStatus, remaining: 4 });
      }
    }
  }

  function emitWorkEnded(
    block: UnifiedWorkBlock,
    status: UnifiedWorkBlock['status'],
    detail?: string,
  ): void {
    if (status !== 'completed' && status !== 'failed' && status !== 'blocked') return;
    const event: UnifiedWorkEndedEvent = {
      blockId: block.id,
      work: block.work,
      workspaceName: block.workspaceName,
      workName: block.workName,
      status,
      ...(detail || block.detail ? { detail: detail ?? block.detail } : {}),
    };
    for (const listener of workEndedListeners) listener(event);
  }

  function rememberUnifiedTurnId(turnId: string): void {
    if (unifiedTurnIds.has(turnId)) return;
    unifiedTurnIds.add(turnId);
    unifiedTurnIdOrder.push(turnId);
    while (unifiedTurnIdOrder.length > 256) {
      const expired = unifiedTurnIdOrder.shift();
      if (expired) unifiedTurnIds.delete(expired);
    }
  }

  async function projectLifecycleStatus(
    sessionId: string,
    explicitStatus?: UnifiedWorkBlock['status'],
  ): Promise<void> {
    const hosts = await deps.hosts.list();
    for (const host of hosts) {
      const summary = await host.summary().catch(() => undefined);
      if (!summary?.available || summary.incognitoActive) continue;
      const candidate = await host.findWork(sessionId).catch(() => undefined);
      if (!candidate) continue;
      const key = `${candidate.work.workspaceId}:${candidate.work.sessionId}`;
      if (activeUnifiedWorks.has(key)) return;
      const status = explicitStatus ??
        ((await host.inspectWork(candidate.work).catch(() => undefined)) ?? 'failed');
      const suppressed = suppressedUnifiedLifecycle.get(key);
      if (suppressed) {
        if (suppressed.status === status && suppressed.remaining > 0) {
          suppressed.remaining -= 1;
          if (suppressed.remaining === 0) suppressedUnifiedLifecycle.delete(key);
          return;
        }
        suppressedUnifiedLifecycle.delete(key);
      }
      if (observedLifecycleStatus.get(key) === status) return;
      observedLifecycleStatus.set(key, status);
      if (
        status !== 'completed' &&
        status !== 'blocked' &&
        status !== 'waiting_for_user'
      ) return;
      await publish(await deps.projections.append({
        id: createId(),
        kind: 'lifecycle',
        work: candidate.work,
        workspaceName: candidate.workspaceName,
        workName: candidate.workName,
        status,
        createdAt: now(),
      }));
      return;
    }
  }

  async function appendCoordination(
    prompt: string,
    drafts: UnifiedCoordinationDraftStep[],
  ): Promise<UnifiedCoordinationPlan> {
    const timestamp = now();
    const stepIds = drafts.map(() => createId());
    const plan: UnifiedCoordinationPlan = {
      id: createId(),
      prompt,
      status: 'awaiting_confirmation',
      steps: drafts.map((draft, index) => ({
        id: stepIds[index]!,
        workspaceId: draft.workspaceId,
        workspaceName: draft.workspaceName,
        title: draft.title,
        prompt: draft.prompt,
        ...(draft.targetWork ? { targetWork: draft.targetWork } : {}),
        dependsOn: draft.dependsOnStepIndexes.flatMap((dependencyIndex) =>
          stepIds[dependencyIndex] ? [stepIds[dependencyIndex]!] : [],
        ),
        status: 'queued',
      })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await publish(
      await deps.projections.append({ id: plan.id, kind: 'coordination', plan }),
    );
    return plan;
  }

  async function executeCoordinationStep(
    planId: string,
    step: UnifiedCoordinationStep,
  ): Promise<void> {
    await updatePlanStep(planId, step.id, { status: 'routing' });
    try {
      const host = await deps.hosts.get(step.workspaceId);
      const summary = host ? await host.summary() : undefined;
      if (!host || !summary?.available || summary.incognitoActive) {
        await updatePlanStep(planId, step.id, { status: 'failed' });
        return;
      }
      const candidate = step.targetWork
        ? await host.findWork(step.targetWork.sessionId)
        : await host.createWork({
            title: step.title,
            permissionMode: await deps.defaultPermissionMode(),
          });
      if (!candidate) {
        await updatePlanStep(planId, step.id, { status: 'failed' });
        return;
      }
      const timestamp = now();
      const block: UnifiedWorkBlock = {
        id: createId(),
        work: candidate.work,
        workspaceName: candidate.workspaceName,
        workName: candidate.workName,
        prompt: step.prompt,
        permissionMode: candidate.permissionMode,
        status: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(!step.targetWork ? { createdNew: true } : {}),
        ...(candidate.archived ? { resumedFromArchive: true } : {}),
      };
      await publish(await deps.projections.append({ id: block.id, kind: 'work', block }));
      await updatePlanStep(planId, step.id, {
        work: candidate.work,
        blockId: block.id,
        status: 'queued',
      });
      const status = await executeWork(host, candidate, block, step.prompt);
      await updatePlanStep(planId, step.id, { status });
    } catch (error) {
      await updatePlanStep(planId, step.id, { status: 'failed' });
      deps.onError?.(error);
    }
  }

  async function runCoordination(planId: string): Promise<void> {
    while (true) {
      const plan = findCoordinationPlan(await deps.projections.read(), planId);
      if (!plan || plan.status === 'cancelled') return;
      const byId = new Map(plan.steps.map((step) => [step.id, step]));
      const active = plan.steps.filter(
        (step) => step.status === 'running' || step.status === 'waiting_for_user',
      );
      if (active.length > 0) {
        await Promise.all(active.map((step) => monitorRecoveredCoordinationStep(planId, step)));
        continue;
      }
      const pending = plan.steps.filter((step) =>
        step.status === 'queued' || step.status === 'routing',
      );
      if (pending.length === 0) {
        const status = plan.steps.every((step) => step.status === 'completed')
          ? 'completed'
          : 'failed';
        await updatePlan(planId, { status, updatedAt: now() });
        return;
      }

      const blocked = pending.filter((step) =>
        step.dependsOn.some((dependencyId) => {
          const dependency = byId.get(dependencyId);
          return dependency && isTerminalWorkStatus(dependency.status) && dependency.status !== 'completed';
        }),
      );
      if (blocked.length > 0) {
        await Promise.all(
          blocked.map((step) => updatePlanStep(planId, step.id, { status: 'blocked' })),
        );
        continue;
      }

      const ready = pending.filter((step) =>
        step.status === 'queued' &&
        step.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === 'completed'),
      );
      if (ready.length === 0) {
        await Promise.all(
          pending.map((step) => updatePlanStep(planId, step.id, { status: 'blocked' })),
        );
        await updatePlan(planId, { status: 'failed', updatedAt: now() });
        return;
      }
      await Promise.all(ready.map((step) => executeCoordinationStep(planId, step)));
    }
  }

  async function inspectAndProjectRecoveredWork(
    work: WorkRef,
    blockId: string | undefined,
  ): Promise<UnifiedWorkBlock['status']> {
    const host = await deps.hosts.get(work.workspaceId);
    const status = host ? await host.inspectWork(work) : undefined;
    const projected = status ?? 'failed';
    if (blockId) await updateBlock(blockId, { status: projected, updatedAt: now() });
    return projected;
  }

  async function monitorRecoveredCoordinationStep(
    planId: string,
    step: UnifiedCoordinationStep,
  ): Promise<void> {
    if (!step.work) {
      await updatePlanStep(planId, step.id, { status: 'failed' });
      return;
    }
    let status = await inspectAndProjectRecoveredWork(step.work, step.blockId);
    while (status === 'running' || status === 'waiting_for_user') {
      if (status !== step.status) await updatePlanStep(planId, step.id, { status });
      await delay(recoveryPollMs);
      status = await inspectAndProjectRecoveredWork(step.work, step.blockId);
    }
    await updatePlanStep(planId, step.id, { status });
  }

  async function monitorRecoveredBlock(block: UnifiedWorkBlock): Promise<void> {
    if (recoveredBlockMonitors.has(block.id)) return;
    recoveredBlockMonitors.add(block.id);
    try {
      let status = await inspectAndProjectRecoveredWork(block.work, block.id);
      while (status === 'running' || status === 'waiting_for_user') {
        await delay(recoveryPollMs);
        status = await inspectAndProjectRecoveredWork(block.work, block.id);
      }
    } finally {
      recoveredBlockMonitors.delete(block.id);
    }
  }

  async function retargetOptions(block: UnifiedWorkBlock): Promise<UnifiedRouteOption[]> {
    const hosts = await deps.hosts.list();
    const summaries = await Promise.all(hosts.map((host) => host.summary()));
    const available = summaries.filter((summary) => summary.available && !summary.incognitoActive);
    const workOptions = (
      await Promise.all(
        hosts.map(async (host, index) => {
          if (!summaries[index]?.available || summaries[index]?.incognitoActive) return [];
          return host.listWorkCandidates(block.prompt, 6).catch(() => []);
        }),
      )
    )
      .flat()
      .filter((candidate) => !sameWork(candidate.work, block.work))
      .slice(0, 8)
      .map((candidate, index) => workRouteOption(candidate, `retarget-work-${index}`));
    const projectOptions = available.map((workspace, index) => ({
      id: `retarget-project-${index}`,
      kind: 'new_work' as const,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      reason: '在这个 Project 中创建新工作',
    }));
    return [...workOptions, ...projectOptions];
  }

  return {
    snapshot: () => deps.projections.read(),

    async send(input) {
      const text = input.text.trim();
      if (!text) throw new TypeError('Unified input text must not be empty');
      if (input.sourceClarificationMessageId) {
        const current = await deps.projections.read();
        const source = current.items.find(
          (item) => item.kind === 'discussion' && item.id === input.sourceClarificationMessageId,
        );
        if (source?.kind === 'discussion' && source.action?.kind === 'clarify') {
          await publish(await deps.projections.updateDiscussionMessage(source.id, {
            action: { ...source.action, resolved: true },
          }));
        }
      }
      const snapshot = await deps.projections.read();
      const pipelineResult = await decisionPipeline.decide({
        input: { ...input, text },
        snapshot,
      });
      const { decision } = pipelineResult;
      const disposition = decision.kind === 'allow'
        ? decision.action.proposal
        : decision.proposal;

      if (disposition.kind === 'discussion') {
        const user = await appendDiscussion('user', text, {
          status: 'completed',
          ...(disposition.route ? { route: disposition.route } : {}),
        });
        const assistant = await appendDiscussion('assistant', '', {
          status: 'running',
          replyToMessageId: user.id,
          ...(disposition.route ? { route: disposition.route } : {}),
        });
        void completeDiscussionReply(assistant.id, user.id, text, assistant.snapshot);
        return { kind: 'discussion', messageId: assistant.id };
      }

      if (disposition.kind === 'register_workspace') {
        await appendDiscussion('user', text);
        const assistant = await appendDiscussion(
          'assistant',
          '这项内容不在已注册且可用的 Workspace 中。请先打开或注册对应 Workspace。',
          { action: { kind: 'register_workspace' }, status: 'completed' },
        );
        return { kind: 'register_workspace', messageId: assistant.id };
      }

      if (disposition.kind === 'relink_workspace') {
        await appendDiscussion('user', text);
        const assistant = await appendDiscussion(
          'assistant',
          '目标 Project 已注册，但当前位置不可用。请重新定位后再继续。',
          {
            action: { kind: 'relink_workspace', workspaceId: disposition.workspaceId },
            status: 'completed',
          },
        );
        return { kind: 'register_workspace', messageId: assistant.id };
      }

      if (disposition.kind === 'clarify') {
        await appendDiscussion('user', text, { status: 'completed' });
        const assistant = await appendDiscussion('assistant', disposition.question, {
          status: 'completed',
          ...(disposition.route ? { route: disposition.route } : {}),
          action: {
            kind: 'clarify',
            originalText: text,
            options: disposition.options,
            ...(input.replacesBlockId ? { replacesBlockId: input.replacesBlockId } : {}),
          },
        });
        return {
          kind: 'clarify',
          messageId: assistant.id,
          options: disposition.options,
        };
      }

      if (disposition.kind === 'coordinate') {
        if (decision.kind !== 'allow' || decision.action.kind !== 'coordinate') {
          throw new Error('Action Gate did not authorize coordination');
        }
        const plan = await appendCoordination(text, disposition.steps);
        return { kind: 'coordination', plan };
      }

      if (decision.kind !== 'allow') {
        throw new Error('Action Gate did not authorize execution');
      }
      if (decision.action.kind === 'coordinate') {
        throw new Error('Coordinated execution requires a confirmed plan');
      }
      const { host } = decision.action;

      const candidate =
        decision.action.kind === 'create_work'
          ? await host.createWork({
              title: decision.action.proposal.title,
              permissionMode: await deps.defaultPermissionMode(),
            })
          : decision.action.candidate;

      const timestamp = now();
      const background = buildDiscussionBackground(snapshot, timestamp);
      const block: UnifiedWorkBlock = {
        id: createId(),
        work: candidate.work,
        workspaceName: candidate.workspaceName,
        workName: candidate.workName,
        prompt: text,
        permissionMode: candidate.permissionMode,
        status: 'queued',
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(decision.action.kind === 'create_work' ? { createdNew: true } : {}),
        ...(candidate.archived ? { resumedFromArchive: true } : {}),
        ...(input.replacesBlockId ? { reroutedFromBlockId: input.replacesBlockId } : {}),
        ...(disposition.route ? { route: disposition.route } : {}),
        ...(background ? { background } : {}),
      };
      await publish(
        await deps.projections.append({ id: block.id, kind: 'work', block }),
      );
      await publish(await deps.projections.setWorkFocus(candidate.work));
      void executeWork(
        host,
        candidate,
        block,
        background ? `${background.summary}\n\n当前指令：${text}` : text,
      );
      return { kind: 'work', block };
    },

    async confirmCoordination(planId) {
      const current = findCoordinationPlan(await deps.projections.read(), planId);
      if (!current) throw new Error(`Unknown coordination plan: ${planId}`);
      if (current.status !== 'awaiting_confirmation') {
        if (current.status === 'running') return current;
        throw new Error(`Coordination plan cannot be confirmed from ${current.status}`);
      }
      const snapshot = await updatePlan(planId, { status: 'running', updatedAt: now() });
      const plan = findCoordinationPlan(snapshot, planId);
      if (!plan) throw new Error(`Unknown coordination plan: ${planId}`);
      if (!coordinationRuns.has(planId)) {
        const run = runCoordination(planId).finally(() => coordinationRuns.delete(planId));
        coordinationRuns.set(planId, run);
        void run;
      }
      return plan;
    },

    async cancelCoordination(planId) {
      const current = findCoordinationPlan(await deps.projections.read(), planId);
      if (!current) throw new Error(`Unknown coordination plan: ${planId}`);
      if (current.status !== 'awaiting_confirmation') {
        throw new Error(`Coordination plan cannot be cancelled from ${current.status}`);
      }
      const snapshot = await updatePlan(planId, { status: 'cancelled', updatedAt: now() });
      const plan = findCoordinationPlan(snapshot, planId);
      if (!plan) throw new Error(`Unknown coordination plan: ${planId}`);
      return plan;
    },

    async requestRetarget(blockId) {
      const snapshot = await deps.projections.read();
      const item = snapshot.items.find(
        (candidate) => candidate.kind === 'work' && candidate.block.id === blockId,
      );
      if (item?.kind !== 'work') throw new Error(`Unknown Unified block: ${blockId}`);
      const block = item.block;
      if (!isTerminalWorkStatus(block.status)) {
        const host = await deps.hosts.get(block.work.workspaceId);
        if (host) await host.stopWork(block.work).catch(() => {});
        await updateBlock(block.id, {
          status: 'stopped',
          detail: '目标已重新选择。原工作中已经发生的修改不会自动撤销。',
          updatedAt: now(),
        });
      }
      const options = await retargetOptions(block);
      const reply = await appendDiscussion(
        'assistant',
        '要把这条指令改到哪项工作？原工作已停止；已经发生的文件修改不会自动撤销。',
        {
          status: 'completed',
          action: {
            kind: 'clarify',
            originalText: block.prompt,
            options,
            replacesBlockId: block.id,
          },
        },
      );
      const result = reply.snapshot.items.find(
        (candidate) => candidate.kind === 'discussion' && candidate.id === reply.id,
      );
      if (result?.kind !== 'discussion') throw new Error('Retarget prompt was not persisted');
      return result;
    },

    async recover() {
      const snapshot = await deps.projections.read();
      for (const item of snapshot.items) {
        if (item.kind !== 'discussion' || item.role !== 'assistant' || item.status !== 'running') {
          continue;
        }
        const user = snapshot.items.find(
          (candidate) =>
            candidate.kind === 'discussion' &&
            candidate.role === 'user' &&
            candidate.id === item.replyToMessageId,
        );
        if (user?.kind === 'discussion') {
          void completeDiscussionReply(item.id, user.id, user.text, snapshot);
        }
      }
      for (const item of snapshot.items) {
        if (item.kind === 'lifecycle') {
          observedLifecycleStatus.set(
            `${item.work.workspaceId}:${item.work.sessionId}`,
            item.status,
          );
        }
      }
      const coordinatedBlockIds = new Set(
        snapshot.items.flatMap((item) =>
          item.kind === 'coordination'
            ? item.plan.steps.flatMap((step) => step.blockId ? [step.blockId] : [])
            : [],
        ),
      );
      for (const item of snapshot.items) {
        if (
          item.kind === 'work' &&
          !isTerminalWorkStatus(item.block.status) &&
          !coordinatedBlockIds.has(item.block.id)
        ) {
          void monitorRecoveredBlock(item.block);
        }
        if (item.kind !== 'coordination' || item.plan.status !== 'running') continue;
        for (const step of item.plan.steps) {
          if (step.status === 'routing' && !step.work) {
            await updatePlanStep(item.plan.id, step.id, { status: 'queued' });
          } else if (step.work && !isTerminalWorkStatus(step.status)) {
            const status = await inspectAndProjectRecoveredWork(step.work, step.blockId);
            await updatePlanStep(item.plan.id, step.id, { status });
          }
        }
        if (!coordinationRuns.has(item.plan.id)) {
          const run = runCoordination(item.plan.id).finally(() => coordinationRuns.delete(item.plan.id));
          coordinationRuns.set(item.plan.id, run);
          void run;
        }
      }
    },

    async observeSession(sessionId) {
      await projectLifecycleStatus(sessionId);
    },

    async observeSessionEvent(sessionId, event) {
      if ('turnId' in event && typeof event.turnId === 'string' && unifiedTurnIds.has(event.turnId)) {
        return;
      }
      const status: UnifiedWorkBlock['status'] =
        event.type === 'complete' ? 'completed' :
        event.type === 'error' ? 'blocked' :
        event.type === 'sandbox_boundary_request' || event.type === 'user_question_request'
          ? 'waiting_for_user' :
        event.type === 'abort' ? 'stopped' : 'running';
      const eventTurnId = 'turnId' in event && typeof event.turnId === 'string'
        ? event.turnId
        : undefined;
      if (status === 'running' && eventTurnId) {
        if (observedRunningTurnIds.has(eventTurnId)) return;
        observedRunningTurnIds.add(eventTurnId);
      } else if (eventTurnId && isTerminalWorkStatus(status)) {
        observedRunningTurnIds.delete(eventTurnId);
      }
      const previous = lifecycleObservationQueues.get(sessionId) ?? Promise.resolve();
      const next = previous.then(() => projectLifecycleStatus(sessionId, status));
      const settled = next.catch(() => {});
      lifecycleObservationQueues.set(sessionId, settled);
      try {
        await next;
      } finally {
        if (lifecycleObservationQueues.get(sessionId) === settled) {
          lifecycleObservationQueues.delete(sessionId);
        }
      }
    },

    async setPermissionMode(work, mode) {
      const host = await deps.hosts.get(work.workspaceId);
      if (!host) throw new Error(`Workspace is unavailable: ${work.workspaceId}`);
      await host.setPermissionMode(work, mode);
      const snapshot = await deps.projections.read();
      for (const item of snapshot.items) {
        if (
          item.kind === 'work' &&
          item.block.work.workspaceId === work.workspaceId &&
          item.block.work.sessionId === work.sessionId
        ) {
          await updateBlock(item.block.id, { permissionMode: mode, updatedAt: now() });
        }
      }
    },

    async stopWork(work) {
      const host = await deps.hosts.get(work.workspaceId);
      if (!host) throw new Error(`Workspace is unavailable: ${work.workspaceId}`);
      await host.stopWork(work);
    },

    async purgeSession(sessionId) {
      await publish(await deps.projections.deleteSession(sessionId));
    },

    async readWorkProjection(work, turnId) {
      const host = await deps.hosts.get(work.workspaceId);
      if (!host) throw new Error(`Workspace is unavailable: ${work.workspaceId}`);
      return host.readWorkProjection(work, turnId);
    },

    async respondToSandboxBoundary(work, response) {
      const host = await deps.hosts.get(work.workspaceId);
      if (!host) throw new Error(`Workspace is unavailable: ${work.workspaceId}`);
      await host.respondToSandboxBoundary(work, response);
    },

    async respondToUserQuestion(work, response) {
      const host = await deps.hosts.get(work.workspaceId);
      if (!host) throw new Error(`Workspace is unavailable: ${work.workspaceId}`);
      await host.respondToUserQuestion(work, response);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    subscribeWorkEnded(listener) {
      workEndedListeners.add(listener);
      return () => workEndedListeners.delete(listener);
    },
  };
}

function workRouteOption(
  candidate: WorkCandidate,
  id: string,
  reason = '继续这项工作',
): UnifiedRouteOption {
  return {
    id,
    kind: 'work',
    workspaceId: candidate.work.workspaceId,
    workspaceName: candidate.workspaceName,
    work: candidate.work,
    workName: candidate.workName,
    reason,
  };
}

function sameWork(left: WorkRef, right: WorkRef): boolean {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}

function findCoordinationPlan(
  snapshot: UnifiedSnapshot,
  planId: string,
): UnifiedCoordinationPlan | undefined {
  const item = snapshot.items.find(
    (candidate) => candidate.kind === 'coordination' && candidate.plan.id === planId,
  );
  return item?.kind === 'coordination' ? item.plan : undefined;
}

function isTerminalWorkStatus(status: UnifiedWorkBlock['status']): boolean {
  return ['blocked', 'failed', 'completed', 'stopped'].includes(status);
}

function buildDiscussionBackground(
  snapshot: UnifiedSnapshot,
  timestamp: number,
): UnifiedWorkBlock['background'] | undefined {
  const recent = snapshot.items
    .filter(
      (item) =>
        item.kind === 'discussion' &&
        timestamp - item.createdAt >= 0 &&
        timestamp - item.createdAt <= 30 * 60_000,
    )
    .slice(-4);
  if (recent.length === 0 || snapshot.items.at(-1)?.kind !== 'discussion') return undefined;
  const user = [...recent].reverse().find(
    (item) => item.kind === 'discussion' && item.role === 'user',
  );
  const assistant = [...recent].reverse().find(
    (item) => item.kind === 'discussion' && item.role === 'assistant',
  );
  const lines = ['工作背景（来自 Unified Discussion）'];
  if (user?.kind === 'discussion') lines.push(`目标：${boundedSummaryText(user.text, 240)}`);
  if (assistant?.kind === 'discussion') lines.push(`讨论结论：${boundedSummaryText(assistant.text, 320)}`);
  return {
    summary: lines.join('\n'),
    sourceDiscussionMessageIds: recent.map((item) => item.id),
  };
}

function boundedSummaryText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  const points = [...normalized];
  return points.length <= limit ? normalized : `${points.slice(0, limit).join('')}…`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
