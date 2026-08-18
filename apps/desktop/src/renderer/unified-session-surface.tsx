import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  workRefKey,
  type WorkRef,
  type SandboxBoundaryRequestEvent,
  type SessionEvent,
  type UnifiedCoordinationPlan,
  type UnifiedDiscussionMessage,
  type UnifiedLifecycleEventItem,
  type UnifiedRouteOption,
  type UnifiedSnapshot,
  type UnifiedWorkBlock,
  type UnifiedWorkStatus,
  type UserQuestionRequestEvent,
} from '@maka/core';
import { ChatMessage, ChatMessageBubble, ChatMessageList } from '@astryxdesign/core';
import {
  Button,
  ChatSurfaceLayout,
  Composer,
  getPermissionModeMeta,
  Markdown,
  PermissionModeSelect,
  SandboxBoundaryPrompt,
  UserQuestionPrompt,
  useUiLocale,
  useToast,
} from '@maka/ui';
import { getShellCopy } from './locales/shell-copy';

interface LiveBlockProjection {
  text: string;
  tools: Array<{ id: string; name: string; settled: boolean; failed: boolean }>;
  sandboxRequest?: SandboxBoundaryRequestEvent;
  questionRequest?: UserQuestionRequestEvent;
}

interface PendingRoute {
  id: string;
  text: string;
  startedAt: number;
  phase: 'routing' | 'bound';
  block?: UnifiedWorkBlock;
  hue?: number;
}

interface UnifiedSurfaceCopy {
  title: string;
  subtitle: string;
  orchestrator: string;
  emptyTitle: string;
  emptyBody: string;
  loadFailed: string;
  routeFailed: string;
  openSettings: string;
  openWork: string;
  registerWorkspace: string;
  relinkWorkspace: string;
  permission: string;
  stop: string;
  tools: string;
  processing: string;
  done: string;
  failed: string;
  you: string;
  maka: string;
  running(count: number): string;
  scopeTitle: string;
  scopeBody: string;
  confirmScope: string;
  cancelScope: string;
  dependsOn: string;
  newWork: string;
  resumedArchive: string;
  basedOnDiscussion: string;
  routingTarget: string;
  generatingResponse: string;
  chooseTarget: string;
  targetSelected: string;
  createInProject(project: string): string;
  changeTarget: string;
  coordinationSummary(count: number): string;
  planStatus: Record<UnifiedCoordinationPlan['status'], string>;
  status: Record<UnifiedWorkStatus, string>;
}

const EMPTY_SNAPSHOT: UnifiedSnapshot = { revision: 0, items: [] };
const WORK_HUES = [250, 180, 135, 70, 25, 305] as const;

export function UnifiedSessionSurface(props: {
  defaultPermissionMode: 'ask' | 'bypass';
  onOpenWork(sessionId: string): void;
  onOpenSettings(): void;
}) {
  const locale = useUiLocale();
  const copy = locale === 'zh' ? ZH_COPY : EN_COPY;
  const toast = useToast();
  const permissionCopy = getShellCopy(locale).sessionSettingsActions;
  const [snapshot, setSnapshot] = useState<UnifiedSnapshot>(EMPTY_SNAPSHOT);
  const [liveByBlock, setLiveByBlock] = useState<Record<string, LiveBlockProjection>>({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [defaultPermissionPending, setDefaultPermissionPending] = useState(false);
  const [pendingRoutes, setPendingRoutes] = useState<PendingRoute[]>([]);
  const [resolvingClarificationId, setResolvingClarificationId] = useState<string>();
  const hydratedTurns = useRef(new Set<string>());
  const pendingSequence = useRef(0);
  const pendingBindingTimers = useRef(new Map<string, number>());

  useEffect(() => {
    let cancelled = false;
    void window.maka.unified
      .getSnapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    const unsubscribeSnapshot = window.maka.unified.subscribeSnapshot((next) => {
      if (!cancelled) setSnapshot(next);
    });
    const unsubscribeEvents = window.maka.unified.subscribeEvents(({ blockId, event }) => {
      if (cancelled) return;
      setLiveByBlock((current) => ({
        ...current,
        [blockId]: applyBlockEvent(current[blockId], event),
      }));
    });
    return () => {
      cancelled = true;
      unsubscribeSnapshot();
      unsubscribeEvents();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    for (const item of snapshot.items) {
      if (item.kind !== 'work' || !item.block.turnId) continue;
      const terminal = ['completed', 'failed', 'blocked', 'stopped'].includes(item.block.status);
      const key = `${item.block.id}:${item.block.turnId}:${terminal ? 'terminal' : 'active'}`;
      if (hydratedTurns.current.has(key)) continue;
      hydratedTurns.current.add(key);
      void window.maka.unified
        .readWorkProjection(item.block.work, item.block.turnId)
        .then((projection) => {
          if (cancelled) return;
          setLiveByBlock((current) => {
            const existing = current[item.block.id];
            return {
              ...current,
              [item.block.id]: {
                ...(existing ?? { text: '', tools: [] }),
                text: terminal ? (projection.text || existing?.text || '') : (existing?.text || projection.text),
                tools: terminal ? (projection.tools.length ? projection.tools : existing?.tools ?? []) :
                  (existing?.tools.length ? existing.tools : projection.tools),
              },
            };
          });
        })
        .catch(() => {
          hydratedTurns.current.delete(key);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [snapshot.items]);

  const workBlocks = useMemo(
    () => snapshot.items.filter((item) => item.kind === 'work').map((item) => item.block),
    [snapshot.items],
  );
  const workHueByKey = useMemo(() => assignWorkHues(workBlocks.map((block) => block.work)), [workBlocks]);
  const running = workBlocks.filter((block) =>
    ['queued', 'routing', 'running', 'waiting_for_user'].includes(block.status),
  ).length;

  const visibleItems = useMemo(
    () => snapshot.items.filter((item) => {
      if (item.kind === 'work') {
        return !pendingRoutes.some((pending) =>
          pending.block?.id === item.block.id || (
            item.block.prompt === pending.text &&
            item.block.createdAt >= pending.startedAt - 100
          ),
        );
      }
      if (item.kind !== 'discussion' || item.role !== 'user') return true;
      return !pendingRoutes.some(
        (pending) => item.text === pending.text && item.createdAt >= pending.startedAt - 100,
      );
    }),
    [pendingRoutes, snapshot.items],
  );

  useEffect(() => {
    for (const pending of pendingRoutes) {
      if (pending.phase !== 'routing' || pendingBindingTimers.current.has(pending.id)) continue;
      const block = workBlocks.find((candidate) =>
        candidate.prompt === pending.text && candidate.createdAt >= pending.startedAt - 100,
      );
      if (!block) continue;
      const bindTimer = window.setTimeout(() => {
        const hue = workHueByKey.get(workRefKey(block.work)) ?? WORK_HUES[0];
        setPendingRoutes((current) => current.map((item) =>
          item.id === pending.id && item.phase === 'routing'
            ? { ...item, phase: 'bound', block, hue }
            : item,
        ));
        const revealTimer = window.setTimeout(() => {
          setPendingRoutes((current) => current.filter((item) => item.id !== pending.id));
          pendingBindingTimers.current.delete(pending.id);
        }, 220);
        pendingBindingTimers.current.set(pending.id, revealTimer);
      }, Math.max(0, 180 - (Date.now() - pending.startedAt)));
      pendingBindingTimers.current.set(pending.id, bindTimer);
    }
  }, [pendingRoutes, workBlocks, workHueByKey]);

  useEffect(() => () => {
    for (const timer of pendingBindingTimers.current.values()) window.clearTimeout(timer);
    pendingBindingTimers.current.clear();
  }, []);

  function send(text: string): boolean {
    const pending: PendingRoute = {
      id: `route-${Date.now()}-${pendingSequence.current += 1}`,
      text,
      startedAt: Date.now(),
      phase: 'routing',
    };
    setPendingRoutes((current) => [...current, pending]);
    void resolvePendingRoute(pending);
    return true;
  }

  async function resolvePendingRoute(pending: PendingRoute): Promise<void> {
    await nextPaint();
    try {
      const result = await window.maka.unified.send({ text: pending.text });
      if (result.kind === 'work') {
        await delay(Math.max(0, 180 - (Date.now() - pending.startedAt)));
        const hue = assignWorkHues([...workBlocks.map((block) => block.work), result.block.work])
          .get(workRefKey(result.block.work)) ?? WORK_HUES[0];
        setPendingRoutes((current) => current.map((item) =>
          item.id === pending.id
            ? { ...item, phase: 'bound', block: result.block, hue }
            : item,
        ));
        await delay(220);
      }
    } catch {
      toast.error(copy.routeFailed);
    } finally {
      setPendingRoutes((current) => current.filter((item) => item.id !== pending.id));
    }
  }

  async function setDefaultPermissionMode(mode: 'ask' | 'bypass'): Promise<void> {
    if (defaultPermissionPending || mode === props.defaultPermissionMode) return;
    if (
      mode === 'bypass' &&
      !(await toast.confirm({
        title: permissionCopy.bypassConfirmTitle,
        description: permissionCopy.bypassConfirmDescription,
        confirmLabel: permissionCopy.bypassConfirmLabel,
        cancelLabel: permissionCopy.bypassCancelLabel,
        destructive: true,
      }))
    ) return;
    setDefaultPermissionPending(true);
    try {
      await window.maka.settings.update({ chatDefaults: { permissionMode: mode } });
    } catch {
      toast.error(permissionCopy.permissionFailedTitle, permissionCopy.permissionFallback);
    } finally {
      setDefaultPermissionPending(false);
    }
  }

  async function resolveClarification(
    message: UnifiedDiscussionMessage,
    option: UnifiedRouteOption,
  ): Promise<void> {
    if (message.action?.kind !== 'clarify' || resolvingClarificationId) return;
    setResolvingClarificationId(message.id);
    try {
      await window.maka.unified.send({
        text: message.action.originalText,
        ...(option.kind === 'work' && option.work ? { explicitWork: option.work } : {}),
        ...(option.kind === 'new_work' ? { explicitWorkspaceId: option.workspaceId } : {}),
        sourceClarificationMessageId: message.id,
        ...(message.action.replacesBlockId
          ? { replacesBlockId: message.action.replacesBlockId }
          : {}),
      });
    } catch {
      toast.error(copy.routeFailed);
    } finally {
      setResolvingClarificationId(undefined);
    }
  }

  return (
    <ChatSurfaceLayout
      className="maka-unified-surface"
      composer={(
        <Composer
          draftKey="unified-session"
          onSend={send}
          onStop={() => {}}
          modelLabel={copy.orchestrator}
          permissionMode={props.defaultPermissionMode}
          permissionModePending={defaultPermissionPending}
          onPermissionModeChange={(mode) => {
            if (mode !== 'ask' && mode !== 'bypass') return;
            void setDefaultPermissionMode(mode);
          }}
        />
      )}
    >
      <main
        className="maka-main agents-chat-panel agents-chat-view-root maka-unified-timeline"
        aria-label={copy.title}
      >
        <header className="maka-unified-heading">
          <div>
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
          {running > 0 ? <span role="status">{copy.running(running)}</span> : null}
        </header>

        <div className="maka-chat-shell">
          <ChatMessageList
            className="maka-chat-message-list maka-chatContent maka-unified-message-list"
            density="compact"
            gap={4}
            isStreaming={running > 0}
          >
            {loadFailed ? (
              <div className="maka-unified-empty" role="alert">
                <p>{copy.loadFailed}</p>
                <Button label={copy.openSettings} variant="secondary" onClick={props.onOpenSettings} />
              </div>
            ) : snapshot.items.length === 0 && pendingRoutes.length === 0 ? (
              <div className="maka-unified-empty">
                <h2>{copy.emptyTitle}</h2>
                <p>{copy.emptyBody}</p>
              </div>
            ) : (
              <div className="maka-unified-items">
                {visibleItems.map((item) =>
                  item.kind === 'discussion' ? (
                    <UnifiedDiscussionView
                      key={item.id}
                      message={item}
                      copy={copy}
                      resolving={resolvingClarificationId === item.id}
                      onResolve={(option) => void resolveClarification(item, option)}
                    />
                  ) : item.kind === 'lifecycle' ? (
                    <UnifiedLifecycleView
                      key={item.id}
                      item={item}
                      copy={copy}
                      onOpen={() => props.onOpenWork(item.work.sessionId)}
                    />
                  ) : item.kind === 'coordination' ? (
                    <UnifiedCoordinationView key={item.id} plan={item.plan} copy={copy} />
                  ) : (
                    <UnifiedWorkBlockView
                      key={item.id}
                      block={item.block}
                      live={liveByBlock[item.block.id]}
                      copy={copy}
                      hue={workHueByKey.get(workRefKey(item.block.work)) ?? WORK_HUES[0]}
                      onOpen={() => props.onOpenWork(item.block.work.sessionId)}
                    />
                  ),
                )}
                {pendingRoutes.map((pending) => (
                  <UnifiedPendingRouteView key={pending.id} pending={pending} copy={copy} />
                ))}
              </div>
            )}
          </ChatMessageList>
        </div>
      </main>
    </ChatSurfaceLayout>
  );
}

function UnifiedDiscussionView(props: {
  message: UnifiedDiscussionMessage;
  copy: UnifiedSurfaceCopy;
  resolving: boolean;
  onResolve(option: UnifiedRouteOption): void;
}) {
  const { message, copy } = props;
  const action = message.action;
  const assistant = message.role === 'assistant';
  return (
    <ChatMessage
      sender={message.role}
      density="compact"
      className="maka-unified-discussion"
      data-role={message.role}
      aria-label={assistant ? copy.maka : copy.you}
    >
      <ChatMessageBubble
        variant={assistant ? 'ghost' : 'filled'}
        className={assistant
          ? 'maka-chat-message-bubble maka-chat-message-bubble-assistant maka-unified-discussion-bubble'
          : 'maka-chat-message-bubble maka-chat-message-bubble-user maka-unified-discussion-bubble'}
      >
        {message.status === 'running' && !message.text ? (
          <p className="maka-unified-discussion-progress" role="status">
            {copy.generatingResponse}
          </p>
        ) : <p>{message.text}</p>}
        {action?.kind === 'register_workspace' ? (
          <Button
            label={copy.registerWorkspace}
            variant="secondary"
            size="sm"
            onClick={() => void window.maka.unified.registerWorkspace()}
          />
        ) : null}
        {action?.kind === 'relink_workspace' ? (
          <Button
            label={copy.relinkWorkspace}
            variant="secondary"
            size="sm"
            onClick={() => void window.maka.unified.relinkWorkspace(action.workspaceId)}
          />
        ) : null}
        {action?.kind === 'clarify' ? (
          <div className="maka-unified-clarification" aria-label={copy.chooseTarget}>
            {action.resolved ? (
              <span className="maka-unified-clarification-resolved">{copy.targetSelected}</span>
            ) : action.options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={props.resolving}
                onClick={() => props.onResolve(option)}
              >
                <span>
                  {option.kind === 'work' && option.workName
                    ? `${option.workspaceName} / ${option.workName}`
                    : copy.createInProject(option.workspaceName)}
                </span>
                {option.reason ? <small>{option.reason}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function UnifiedPendingRouteView(props: {
  pending: PendingRoute;
  copy: UnifiedSurfaceCopy;
}) {
  const { pending, copy } = props;
  return (
    <section
      className="maka-unified-pending-route"
      data-phase={pending.phase}
      style={pending.hue == null
        ? undefined
        : ({ '--maka-unified-work-hue': `${pending.hue}deg` } as CSSProperties)}
      aria-live="polite"
    >
      {pending.block ? (
        <span className="maka-unified-work-meta" data-sender="user">
          {pending.block.workspaceName} / {pending.block.workName}
        </span>
      ) : null}
      <ChatMessage sender="user" density="compact" className="maka-unified-work-message">
        <ChatMessageBubble className={`maka-chat-message-bubble maka-chat-message-bubble-user maka-unified-pending-bubble${pending.block ? ' maka-unified-work-bubble maka-unified-work-prompt-bubble' : ''}`}>
          <p className="maka-unified-prompt">{pending.text}</p>
        </ChatMessageBubble>
      </ChatMessage>
      {pending.phase === 'routing' ? (
        <span className="maka-unified-routing-label">{copy.routingTarget}</span>
      ) : null}
    </section>
  );
}

function UnifiedLifecycleView(props: {
  item: UnifiedLifecycleEventItem;
  copy: UnifiedSurfaceCopy;
  onOpen(): void;
}) {
  return (
    <button type="button" className="maka-unified-lifecycle" onClick={props.onOpen}>
      <span>{props.item.workspaceName} / {props.item.workName}</span>
      <strong>{props.copy.status[props.item.status]}</strong>
    </button>
  );
}

function UnifiedCoordinationView(props: {
  plan: UnifiedCoordinationPlan;
  copy: UnifiedSurfaceCopy;
}) {
  const { plan, copy } = props;
  if (plan.status !== 'awaiting_confirmation') {
    return (
      <div className="maka-unified-coordination-event" role="status" data-status={plan.status}>
        <span>{copy.coordinationSummary(plan.steps.length)}</span>
        <strong>{copy.planStatus[plan.status]}</strong>
      </div>
    );
  }
  const stepNameById = new Map(plan.steps.map((step) => [step.id, step.workspaceName]));
  return (
    <section className="maka-unified-coordination" data-status={plan.status}>
      <header>
        <div>
          <h2>{copy.scopeTitle}</h2>
          <p>{copy.scopeBody}</p>
        </div>
        <span role="status">{copy.planStatus[plan.status]}</span>
      </header>
      <ol>
        {plan.steps.map((step) => (
          <li key={step.id} data-status={step.status}>
            <div>
              <strong>{step.workspaceName}</strong>
              <span>{step.title}</span>
              {step.dependsOn.length ? (
                <small>
                  {copy.dependsOn} {step.dependsOn.map((id) => stepNameById.get(id) ?? id).join('、')}
                </small>
              ) : null}
            </div>
            <span>{copy.status[step.status]}</span>
          </li>
        ))}
      </ol>
      {plan.status === 'awaiting_confirmation' ? (
        <footer>
          <Button
            label={copy.confirmScope}
            variant="primary"
            size="sm"
            onClick={() => void window.maka.unified.confirmCoordination(plan.id)}
          />
          <Button
            label={copy.cancelScope}
            variant="ghost"
            size="sm"
            onClick={() => void window.maka.unified.cancelCoordination(plan.id)}
          />
        </footer>
      ) : null}
    </section>
  );
}

function UnifiedWorkBlockView(props: {
  block: UnifiedWorkBlock;
  live?: LiveBlockProjection;
  copy: UnifiedSurfaceCopy;
  hue: number;
  onOpen(): void;
}) {
  const { block, live, copy } = props;
  const busy = ['queued', 'routing', 'running'].includes(block.status);
  const toast = useToast();
  const locale = useUiLocale();
  const permissionCopy = getShellCopy(locale).sessionSettingsActions;
  const displayPermissionMode = block.permissionMode === 'execute' ? 'ask' : block.permissionMode;
  const permissionLabel = getPermissionModeMeta(locale)[displayPermissionMode].label;
  const [permissionPending, setPermissionPending] = useState(false);
  const [permissionSelectRevision, setPermissionSelectRevision] = useState(0);
  const [retargetPending, setRetargetPending] = useState(false);

  async function setPermissionMode(mode: 'ask' | 'bypass'): Promise<void> {
    if (permissionPending || mode === block.permissionMode) return;
    if (mode === 'bypass') {
      const confirmed = await toast.confirm({
        title: permissionCopy.bypassConfirmTitle,
        description: permissionCopy.bypassConfirmDescription,
        confirmLabel: permissionCopy.bypassConfirmLabel,
        cancelLabel: permissionCopy.bypassCancelLabel,
        destructive: true,
      });
      if (!confirmed) {
        setPermissionSelectRevision((revision) => revision + 1);
        return;
      }
    }
    setPermissionPending(true);
    try {
      await window.maka.unified.setPermissionMode(block.work, mode);
    } catch {
      toast.error(permissionCopy.permissionFailedTitle, permissionCopy.permissionFallback);
    } finally {
      setPermissionPending(false);
    }
  }

  async function requestRetarget(): Promise<void> {
    if (retargetPending) return;
    setRetargetPending(true);
    try {
      await window.maka.unified.requestRetarget(block.id);
    } catch {
      toast.error(copy.routeFailed);
    } finally {
      setRetargetPending(false);
    }
  }
  return (
    <section
      className="maka-unified-work"
      data-status={block.status}
      data-work-tone={props.hue}
      style={{ '--maka-unified-work-hue': `${props.hue}deg` } as CSSProperties}
    >
      <UnifiedWorkMeta block={block} sender="user" onOpen={props.onOpen} />
      <ChatMessage sender="user" density="compact" className="maka-unified-work-message">
        <ChatMessageBubble className="maka-chat-message-bubble maka-chat-message-bubble-user maka-unified-work-bubble maka-unified-work-prompt-bubble">
          <p className="maka-unified-prompt">{block.prompt}</p>
        </ChatMessageBubble>
      </ChatMessage>
      {block.background ? (
        <p className="maka-unified-background-note">{copy.basedOnDiscussion}</p>
      ) : null}
      {(live?.text || live?.tools.length || block.detail || live?.sandboxRequest || live?.questionRequest) ? (
        <>
          <UnifiedWorkMeta block={block} sender="assistant" onOpen={props.onOpen} />
          <ChatMessage sender="assistant" density="compact" className="maka-unified-work-message">
            <ChatMessageBubble
              variant="ghost"
              className="maka-chat-message-bubble maka-chat-message-bubble-assistant maka-unified-work-bubble maka-unified-work-answer-bubble"
            >
              {live?.text ? <Markdown text={live.text} density="compact" /> : null}
              {live?.tools.length ? (
                <ul className="maka-unified-tools" aria-label={copy.tools}>
                  {live.tools.map((tool) => (
                    <li key={tool.id} data-failed={tool.failed || undefined}>
                      {tool.name} · {tool.settled ? (tool.failed ? copy.failed : copy.done) : copy.processing}
                    </li>
                  ))}
                </ul>
              ) : null}
              {block.detail ? <p className="maka-unified-detail">{block.detail}</p> : null}
              {live?.sandboxRequest ? (
                <SandboxBoundaryPrompt
                  request={live.sandboxRequest}
                  onRespond={(response) =>
                    window.maka.unified.respondToSandboxBoundary(block.work, response)
                  }
                />
              ) : null}
              {live?.questionRequest ? (
                <UserQuestionPrompt
                  request={live.questionRequest}
                  onRespond={(response) =>
                    window.maka.unified.respondToUserQuestion(block.work, response)
                  }
                  onStop={() => window.maka.unified.stopWork(block.work)}
                />
              ) : null}
            </ChatMessageBubble>
          </ChatMessage>
        </>
      ) : null}
      <footer className="maka-unified-work-footer">
        <span className="maka-unified-status" role="status" data-active={busy || undefined}>
          {copy.status[block.status]}
        </span>
        <span aria-hidden="true">·</span>
        <PermissionModeSelect
          key={permissionSelectRevision}
          activeMode={block.permissionMode}
          onSelect={setPermissionMode}
          disabled={permissionPending}
          align="start"
          ariaLabel={copy.permission}
          appearance="icon"
        />
        <span>{permissionLabel}</span>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={props.onOpen} aria-label={copy.openWork}>
          {copy.openWork}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" disabled={retargetPending} onClick={() => void requestRetarget()}>
          {copy.changeTarget}
        </button>
        {busy || block.status === 'waiting_for_user' ? (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => void window.maka.unified.stopWork(block.work)}>
              {copy.stop}
            </button>
          </>
        ) : null}
      </footer>
    </section>
  );
}

function UnifiedWorkMeta(props: {
  block: UnifiedWorkBlock;
  sender: 'user' | 'assistant';
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className="maka-unified-work-meta"
      data-sender={props.sender}
      onClick={props.onOpen}
    >
      {props.block.workspaceName} / {props.block.workName}
    </button>
  );
}

function assignWorkHues(works: WorkRef[]): Map<string, number> {
  const hues = new Map<string, number>();
  const used = new Set<number>();
  for (const work of works) {
    const key = workRefKey(work);
    if (hues.has(key)) continue;
    let index = stableStringHash(key) % WORK_HUES.length;
    while (used.has(index) && used.size < WORK_HUES.length) {
      index = (index + 1) % WORK_HUES.length;
    }
    hues.set(key, WORK_HUES[index]);
    used.add(index);
  }
  return hues;
}

function stableStringHash(value: string): number {
  let hash = 2166136261;
  for (const point of value) {
    hash ^= point.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function applyBlockEvent(
  current: LiveBlockProjection | undefined,
  event: SessionEvent,
): LiveBlockProjection {
  const next: LiveBlockProjection = current ?? { text: '', tools: [] };
  switch (event.type) {
    case 'text_delta':
      return { ...next, text: `${next.text}${event.text}` };
    case 'text_complete':
      return { ...next, text: event.text || next.text };
    case 'tool_start':
      return {
        ...next,
        tools: [
          ...next.tools.filter((tool) => tool.id !== event.toolUseId),
          {
            id: event.toolUseId,
            name: event.displayName ?? event.toolName,
            settled: false,
            failed: false,
          },
        ],
      };
    case 'tool_result':
      return {
        ...next,
        tools: next.tools.map((tool) =>
          tool.id === event.toolUseId
            ? { ...tool, settled: true, failed: event.isError }
            : tool,
        ),
      };
    case 'sandbox_boundary_request':
      return { ...next, sandboxRequest: event };
    case 'sandbox_boundary_decision_ack':
      return { ...next, sandboxRequest: undefined };
    case 'user_question_request':
      return { ...next, questionRequest: event };
    case 'user_question_answer_ack':
      return { ...next, questionRequest: undefined };
    case 'abort':
    case 'complete':
    case 'error':
      return {
        ...next,
        sandboxRequest: undefined,
        questionRequest: undefined,
      };
    default:
      return next;
  }
}

const ZH_COPY: UnifiedSurfaceCopy = {
  title: 'Unified Session',
  subtitle: '在这里讨论、开始或继续任何工作。Maka 会处理路由。',
  orchestrator: '所有工作',
  emptyTitle: '从一件事开始',
  emptyBody: '可以先讨论；目标明确后，Maka 会创建或继续对应工作。',
  loadFailed: 'Unified Session 暂时无法载入。',
  routeFailed: '未能处理这条消息。',
  openSettings: '打开设置',
  openWork: '进入工作',
  registerWorkspace: '打开或注册项目',
  relinkWorkspace: '重新定位项目',
  permission: '目标工作的权限模式',
  stop: '停止',
  tools: '工具活动',
  processing: '处理中',
  done: '完成',
  failed: '失败',
  you: '你',
  maka: 'Maka',
  running: (count: number) => `${count} 项处理中`,
  scopeTitle: '执行范围',
  scopeBody: '确认后才会创建这些工作。依赖项完成后，后续工作才会开始。',
  confirmScope: '确认并开始',
  cancelScope: '取消',
  dependsOn: '依赖',
  newWork: '新工作',
  resumedArchive: '继续已归档工作',
  basedOnDiscussion: '已带入前文讨论背景',
  routingTarget: '正在识别目标…',
  generatingResponse: '目标已识别 · 正在回答…',
  chooseTarget: '选择目标工作',
  targetSelected: '已选择目标',
  createInProject: (project: string) => `在 ${project} 创建新工作`,
  changeTarget: '更改目标',
  coordinationSummary: (count: number) => `已创建 ${count} 项关联工作`,
  planStatus: {
    awaiting_confirmation: '等待确认', running: '执行中', completed: '已完成',
    failed: '未全部完成', cancelled: '已取消',
  },
  status: {
    queued: '排队中', routing: '准备中', running: '处理中…', waiting_for_user: '等待你',
    blocked: '已阻塞', failed: '失败', completed: '完成', stopped: '已停止',
  },
};

const EN_COPY: UnifiedSurfaceCopy = {
  title: 'Unified Session',
  subtitle: 'Discuss, start, or continue any work here. Maka handles routing.',
  orchestrator: 'All work',
  emptyTitle: 'Start with one thing',
  emptyBody: 'Discussion stays here. Once the goal is clear, Maka creates or resumes the right work.',
  loadFailed: 'Unified Session is temporarily unavailable.',
  routeFailed: 'Could not process this message.',
  openSettings: 'Open settings',
  openWork: 'Open work',
  registerWorkspace: 'Open or register project',
  relinkWorkspace: 'Relink project',
  permission: 'Target work permission mode',
  stop: 'Stop',
  tools: 'Tool activity',
  processing: 'Running',
  done: 'Done',
  failed: 'Failed',
  you: 'You',
  maka: 'Maka',
  running: (count: number) => `${count} running`,
  scopeTitle: 'Execution scope',
  scopeBody: 'No work is created until you confirm. Dependent work starts after its prerequisite completes.',
  confirmScope: 'Confirm and start',
  cancelScope: 'Cancel',
  dependsOn: 'Depends on',
  newWork: 'New work',
  resumedArchive: 'Resumed archived work',
  basedOnDiscussion: 'Includes context from the prior discussion',
  routingTarget: 'Identifying target…',
  generatingResponse: 'Target identified · Generating…',
  chooseTarget: 'Choose target work',
  targetSelected: 'Target selected',
  createInProject: (project: string) => `Create new work in ${project}`,
  changeTarget: 'Change target',
  coordinationSummary: (count: number) => `Created ${count} linked work items`,
  planStatus: {
    awaiting_confirmation: 'Waiting for confirmation', running: 'Running', completed: 'Complete',
    failed: 'Not fully completed', cancelled: 'Cancelled',
  },
  status: {
    queued: 'Queued', routing: 'Preparing', running: 'Running…', waiting_for_user: 'Needs you',
    blocked: 'Blocked', failed: 'Failed', completed: 'Complete', stopped: 'Stopped',
  },
};
