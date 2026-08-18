import { randomUUID } from 'node:crypto';
import type {
  SessionEvent,
  SandboxBoundaryResponse,
  SessionSummary,
  StoredMessage,
  UserQuestionResponse,
} from '@maka/core';
import { UNIFIED_INTERNAL_SESSION_LABEL } from '@maka/core/unified-session';
import type { PermissionMode } from '@maka/core/permission';
import type { UnifiedWorkspaceSummary, WorkRef } from '@maka/core/unified-session';
import type { UnifiedWorkContentProjection } from '@maka/core/unified-session';
import type {
  UnifiedTargetEvent,
  WorkCandidate,
  WorkspaceHostPort,
} from './work-orchestrator.js';

export interface LocalWorkspaceHostDeps {
  workspace: Omit<UnifiedWorkspaceSummary, 'incognitoActive' | 'available'>;
  isAvailable(): Promise<boolean>;
  isIncognitoActive(): Promise<boolean>;
  listSessions(): Promise<SessionSummary[]>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  markRead(sessionId: string, readThroughTs?: number): Promise<void>;
  resolveWorkScopeName?(session: SessionSummary): Promise<string | undefined>;
  createSession(input: { name: string; permissionMode: PermissionMode }): Promise<SessionSummary>;
  unarchive(sessionId: string): Promise<void>;
  ensureCanSend(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, input: { turnId: string; text: string }): AsyncIterable<SessionEvent>;
  streamEvents(
    sessionId: string,
    events: AsyncIterable<SessionEvent>,
    options: { turnId: string; observeEvent(event: SessionEvent): void },
  ): Promise<{ ok: boolean; error?: string }>;
  respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<unknown>;
  stopSession(sessionId: string): Promise<void>;
  relink?(): Promise<void>;
  onSessionCreated(sessionId: string): void;
  onSessionChanged(sessionId: string): void;
  createTurnId?: () => string;
}

export function createLocalWorkspaceHost(deps: LocalWorkspaceHostDeps): WorkspaceHostPort {
  const createTurnId = deps.createTurnId ?? randomUUID;
  const candidateCache = new Map<string, { revision: number; candidate: WorkCandidate }>();

  function assertOwned(work: WorkRef): void {
    if (work.workspaceId !== deps.workspace.id) {
      throw new Error(`Work belongs to another Workspace: ${work.workspaceId}`);
    }
  }

  async function candidateFor(session: SessionSummary): Promise<WorkCandidate> {
    const revision = session.lastMessageAt ?? 0;
    const cached = candidateCache.get(session.id);
    if (cached?.revision === revision) return cached.candidate;
    let objective = session.name;
    let recentOutcome = '';
    try {
      const messages = await deps.readMessages(session.id);
      const userMessages = messages.filter(
        (message): message is Extract<StoredMessage, { type: 'user' }> => message.type === 'user',
      );
      const assistantMessages = messages.filter(
        (message): message is Extract<StoredMessage, { type: 'assistant' }> => message.type === 'assistant',
      );
      const firstObjective = userMessages[0]?.text ?? '';
      const currentObjective = userMessages.at(-1)?.text ?? '';
      objective = boundedCardText(
        firstObjective === currentObjective
          ? firstObjective
          : `${firstObjective}\n当前：${currentObjective}`,
        720,
      ) || session.name;
      recentOutcome = boundedCardText(assistantMessages.at(-1)?.text ?? '', 480);
    } catch {
      // Metadata remains routable when a historical transcript cannot be read.
    }
    const scopeName = (await deps.resolveWorkScopeName?.(session)) ?? deps.workspace.name;
    const terms = salientTerms([session.name, session.labels.join(' '), objective].join(' '));
    const candidate: WorkCandidate = {
      work: { workspaceId: deps.workspace.id, sessionId: session.id },
      workspaceName: scopeName,
      workName: session.name,
      searchableText: [session.name, session.labels.join(' '), objective, terms.join(' '), recentOutcome]
        .join(' '),
      semanticCard: { objective, recentOutcome, terms },
      permissionMode: session.permissionMode,
      archived: session.isArchived,
      updatedAt: revision,
    };
    candidateCache.set(session.id, { revision, candidate });
    return candidate;
  }

  return {
    async summary() {
      return {
        ...deps.workspace,
        available: await deps.isAvailable(),
        incognitoActive: await deps.isIncognitoActive(),
      };
    },

    async listWorkCandidates(query, limit) {
      const sessions = (await deps.listSessions())
        .filter(
          (session) =>
            !session.subagentParent &&
            session.backend !== 'fake' &&
            !session.labels.includes(UNIFIED_INTERNAL_SESSION_LABEL),
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const candidates = await Promise.all(sessions.map(candidateFor));
      return candidates
        .map((candidate) => ({ candidate, score: recallScore(query, candidate) }))
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.candidate.updatedAt - left.candidate.updatedAt ||
            left.candidate.work.sessionId.localeCompare(right.candidate.work.sessionId),
        )
        .slice(0, Math.max(1, limit))
        .map((entry) => entry.candidate);
    },

    async findWork(sessionId) {
      const session = (await deps.listSessions()).find(
        (candidate) =>
          candidate.id === sessionId &&
          !candidate.subagentParent &&
          !candidate.labels.includes(UNIFIED_INTERNAL_SESSION_LABEL),
      );
      return session ? candidateFor(session) : undefined;
    },

    async createWork(input) {
      const session = await deps.createSession({
        name: input.title,
        permissionMode: input.permissionMode,
      });
      deps.onSessionCreated(session.id);
      return candidateFor(session);
    },

    async restoreWork(work) {
      assertOwned(work);
      await deps.unarchive(work.sessionId);
      deps.onSessionChanged(work.sessionId);
    },

    async startTurn(work, text, onEvent) {
      assertOwned(work);
      await deps.ensureCanSend(work.sessionId);
      const turnId = createTurnId();
      onEvent({ kind: 'started', turnId });
      const events = deps.sendMessage(work.sessionId, { turnId, text });
      const result = await deps.streamEvents(work.sessionId, events, {
        turnId,
        observeEvent(event) {
          onEvent({ kind: 'session_event', event });
          const mapped = targetEventFromSessionEvent(event);
          if (mapped) onEvent(mapped);
        },
      });
      if (!result.ok && result.error) onEvent({ kind: 'failed', detail: result.error });
      return { turnId };
    },

    async readWorkProjection(work, turnId): Promise<UnifiedWorkContentProjection> {
      assertOwned(work);
      const allMessages = await deps.readMessages(work.sessionId);
      await deps.markRead(work.sessionId, latestMessageTimestamp(allMessages));
      const messages = allMessages.filter(
        (message) => message.turnId === turnId,
      );
      const results = new Map(
        messages.flatMap((message) =>
          message.type === 'tool_result'
            ? [[message.toolUseId, message] as const]
            : [],
        ),
      );
      return {
        text: messages
          .flatMap((message) => message.type === 'assistant' ? [message.text] : [])
          .join('\n\n'),
        tools: messages.flatMap((message) => {
          if (message.type !== 'tool_call') return [];
          const result = results.get(message.id);
          return [{
            id: message.id,
            name: message.displayName ?? message.toolName,
            settled: Boolean(result),
            failed: result?.isError ?? false,
          }];
        }),
      };
    },

    async inspectWork(work) {
      assertOwned(work);
      const session = (await deps.listSessions()).find((candidate) => candidate.id === work.sessionId);
      if (!session) return undefined;
      switch (session.status) {
        case 'running': return 'running';
        case 'waiting_for_user': return 'waiting_for_user';
        case 'blocked': return 'blocked';
        case 'aborted': return 'stopped';
        case 'done':
        case 'review':
        case 'active':
        case 'archived':
          return 'completed';
      }
    },

    async respondToSandboxBoundary(work, response) {
      assertOwned(work);
      await deps.respondToSandboxBoundary(work.sessionId, response);
    },

    async respondToUserQuestion(work, response) {
      assertOwned(work);
      await deps.respondToUserQuestion(work.sessionId, response);
    },

    async setPermissionMode(work, mode) {
      assertOwned(work);
      await deps.setPermissionMode(work.sessionId, mode);
      deps.onSessionChanged(work.sessionId);
    },

    async stopWork(work) {
      assertOwned(work);
      await deps.stopSession(work.sessionId);
      deps.onSessionChanged(work.sessionId);
    },

    ...(deps.relink ? { relink: () => deps.relink!() } : {}),
  };
}

function latestMessageTimestamp(messages: readonly StoredMessage[]): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!Number.isFinite(message.ts)) continue;
    latest = latest === undefined ? message.ts : Math.max(latest, message.ts);
  }
  return latest;
}

function targetEventFromSessionEvent(event: SessionEvent): UnifiedTargetEvent | undefined {
  switch (event.type) {
    case 'sandbox_boundary_request':
    case 'user_question_request':
      return { kind: 'waiting_for_user' };
    case 'complete':
      return { kind: 'completed' };
    case 'abort':
      return { kind: 'stopped' };
    case 'error':
      return { kind: 'failed', detail: event.message };
    default:
      return undefined;
  }
}

function boundedCardText(text: string, maximum: number): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function salientTerms(text: string): string[] {
  const latin = text.toLocaleLowerCase().match(/[a-z0-9_./-]{3,}/giu) ?? [];
  const chinese = text.match(/[\p{Script=Han}]{2,8}/gu) ?? [];
  return [...new Set([...latin, ...chinese])].slice(0, 32);
}

function recallScore(query: string, candidate: WorkCandidate): number {
  const normalized = query.toLocaleLowerCase();
  const tokens = salientTerms(query);
  let score = 0;
  for (const token of tokens) {
    const value = token.toLocaleLowerCase();
    if (candidate.workName.toLocaleLowerCase().includes(value)) score += 6;
    if (candidate.semanticCard?.objective.toLocaleLowerCase().includes(value)) score += 4;
    if (candidate.semanticCard?.terms.some((term) => term.toLocaleLowerCase().includes(value))) {
      score += 2;
    }
    if (candidate.semanticCard?.recentOutcome.toLocaleLowerCase().includes(value)) score += 1;
  }
  if (candidate.workName && normalized.includes(candidate.workName.toLocaleLowerCase())) score += 12;
  return score;
}
