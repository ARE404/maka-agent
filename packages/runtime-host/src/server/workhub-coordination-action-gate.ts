/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from 'node:crypto';
import type { SessionHeader, SessionStatus } from '@maka/core/session';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubCoordinationSessionTarget,
} from '@maka/core/session';
import type {
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidate,
  WorkHubCoordinationCandidatesResult,
  WorkspaceTarget,
  WorkspaceProjection,
} from '../protocol/index.js';
import { WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS } from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';

const SIDE_CONVERSATION_LABEL = 'mode:side_conversation';
const ACTION_REPLAY_MAX_ITEMS = 256;
const REPLACEMENT_RECOVERY_MAX_ITEMS = ACTION_REPLAY_MAX_ITEMS;

export type WorkHubActionGateSession = Pick<
  SessionHeader,
  | 'id'
  | 'role'
  | 'cwd'
  | 'projectId'
  | 'createdAt'
  | 'lastMessageAt'
  | 'name'
  | 'labels'
  | 'isArchived'
  | 'status'
  | 'statusUpdatedAt'
  | 'subagentParent'
>;

export interface WorkHubActionGateEffects {
  listSessions(): Promise<readonly WorkHubActionGateSession[]>;
  answer(
    input: { readonly turnId: string; readonly text: string },
    context: ConnectionContext,
  ): Promise<void>;
  clarify(input: {
    readonly turnId: string;
    readonly userText: string;
    readonly assistantText: string;
  }): Promise<void>;
  create(input: {
    readonly sessionId: string;
    readonly workspace: WorkspaceTarget;
    readonly title: string;
  }): Promise<void>;
  submit(
    input: {
      readonly sessionId: string;
      readonly messageId: string;
      readonly text: string;
    },
    context: ConnectionContext,
  ): Promise<{ readonly turnId: string; readonly steered?: true }>;
  stop(
    input: { readonly sessionId: string; readonly turnId: string },
    context: ConnectionContext,
  ): Promise<void>;
}

export type WorkHubActionEffectFailureCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'persistence_failed'
  | 'commit_outcome_unknown'
  | 'internal_failure'
  | 'unauthorized';

export class WorkHubActionEffectFailure extends Error {
  constructor(
    readonly code: WorkHubActionEffectFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubActionEffectFailure';
  }
}

export type WorkHubActionGateFailureCode =
  | 'candidate_set_stale'
  | 'candidate_unavailable'
  | 'target_waiting_for_user'
  | 'self_route'
  | 'confirmation_required'
  | 'stop_not_owned'
  | 'action_conflict';

export class WorkHubActionGateFailure extends Error {
  constructor(
    readonly code: WorkHubActionGateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubActionGateFailure';
  }
}

interface ActionReplay {
  readonly fingerprint: string;
  readonly result: Promise<WorkHubCoordinationActResult>;
}

interface OwnedRoot {
  readonly turnId: string;
  readonly actionId: string;
}

/** Host-lifetime checkpoint for the non-atomic Stop-then-submit boundary. */
interface ReplacementRecovery {
  readonly fingerprint: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  stopped: boolean;
}

/**
 * The sole admission module between a WorkHub strategy proposal and Session effects.
 *
 * Candidate discovery and fresh-state validation deliberately live behind the
 * same interface as execution. A caller cannot turn a model-selected Session id
 * into a write because proposals carry only an opaque candidateRef.
 */
export class WorkHubCoordinationActionGate {
  readonly #effects: WorkHubActionGateEffects;
  readonly #actions = new Map<string, ActionReplay>();
  readonly #ownedRoots = new Map<string, OwnedRoot>();
  readonly #replacementRecoveries = new Map<string, ReplacementRecovery>();
  readonly #replacementLanes = new Map<string, Promise<void>>();

  constructor(effects: WorkHubActionGateEffects) {
    this.#effects = effects;
  }

  async candidates(): Promise<WorkHubCoordinationCandidatesResult> {
    return candidateSet(await this.#effects.listSessions());
  }

  act(
    input: WorkHubCoordinationActInput,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const fingerprint = digest(input);
    const recovery = this.#replacementRecoveries.get(input.actionId);
    if (recovery && recovery.fingerprint !== fingerprint) {
      return Promise.reject(
        new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub action identity belongs to a different proposal',
        ),
      );
    }
    const replay = this.#actions.get(input.actionId);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        return Promise.reject(
          new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub action identity belongs to a different proposal',
          ),
        );
      }
      return replay.result;
    }

    const result = this.#act(input, context, fingerprint);
    const action = { fingerprint, result };
    this.#actions.set(input.actionId, action);
    // Successful actions remain replayable. A rejected admission does not own
    // the action identity forever: callers must be able to refresh stale
    // candidates or satisfy an actionable precondition and retry safely.
    void result.catch(() => {
      if (this.#actions.get(input.actionId) === action) {
        this.#actions.delete(input.actionId);
      }
    });
    this.#boundReplays();
    return result;
  }

  async #act(
    input: WorkHubCoordinationActInput,
    context: ConnectionContext,
    fingerprint: string,
  ): Promise<WorkHubCoordinationActResult> {
    const recovery = this.#replacementRecoveries.get(input.actionId);
    if (recovery) {
      if (!recovery.stopped) {
        throw new WorkHubActionEffectFailure(
          'host_not_ready',
          'WorkHub replacement Stop is still settling',
        );
      }
      // The destructive half already committed. Reconcile only the exact
      // idempotent target submission; a fresh candidate snapshot must not turn
      // a lost reply into a second Stop or strand the replacement permanently.
      return this.#withReplacementLease(recovery.sourceSessionId, () =>
        this.#resumeReplacement(input, recovery, context),
      );
    }
    const proposal = input.proposal;
    if (proposal.disposition === 'answer_here') {
      const turnId = coordinationTurnId(input.actionId, 'answer');
      await this.#effects.answer({ turnId, text: input.userText }, context);
      return { disposition: 'answer_here', coordinationTurnId: turnId };
    }
    if (proposal.disposition === 'clarify') {
      const turnId = coordinationTurnId(input.actionId, 'clarify');
      await this.#effects.clarify({
        turnId,
        userText: input.userText,
        assistantText: proposal.assistantText,
      });
      return { disposition: 'clarify', coordinationTurnId: turnId };
    }
    if (proposal.disposition === 'create_new') {
      if (!input.create) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub creation context is unavailable',
        );
      }
      const sessionId = workHubCreatedSessionId(input.actionId);
      await this.#effects.create({
        sessionId,
        workspace: input.create.workspace,
        title: proposal.title,
      });
      const submitted = await this.#effects.submit(
        {
          sessionId,
          messageId: actionMessageId(input.actionId),
          text: input.userText,
        },
        context,
      );
      this.#rememberRoot(sessionId, input.actionId, submitted);
      return executionResult('create_new', sessionId, submitted);
    }

    const candidates = await this.candidates();
    if (candidates.candidateSetId !== input.candidateSetId) {
      throw new WorkHubActionGateFailure(
        'candidate_set_stale',
        'WorkHub Session candidates changed; refresh before delegating',
      );
    }
    const target = candidates.candidates.find(
      (candidate) => candidate.candidateRef === proposal.candidateRef,
    );
    if (!target) {
      throw new WorkHubActionGateFailure(
        'candidate_unavailable',
        'WorkHub target is not in the admitted candidate set',
      );
    }
    this.#assertTarget(target);

    if (proposal.replace) {
      if (!hasExplicitReplacementIntent(input.userText)) {
        throw new WorkHubActionGateFailure(
          'confirmation_required',
          'Stopping and rerouting work requires an explicit user correction naming the replacement',
        );
      }
      const replaced = candidates.candidates.find(
        (candidate) => candidate.candidateRef === proposal.replace?.candidateRef,
      );
      if (!replaced) {
        throw new WorkHubActionGateFailure(
          'candidate_unavailable',
          'WorkHub replacement source is not in the admitted candidate set',
        );
      }
      if (replaced.sessionId === target.sessionId) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub replacement target did not change',
        );
      }
      const replacement = proposal.replace;
      return this.#withReplacementLease(replaced.sessionId, async () => {
        const freshCandidates = await this.candidates();
        if (freshCandidates.candidateSetId !== input.candidateSetId) {
          throw new WorkHubActionGateFailure(
            'candidate_set_stale',
            'WorkHub Session candidates changed; refresh before delegating',
          );
        }
        const freshTarget = freshCandidates.candidates.find(
          (candidate) => candidate.candidateRef === proposal.candidateRef,
        );
        const freshSource = freshCandidates.candidates.find(
          (candidate) => candidate.candidateRef === replacement.candidateRef,
        );
        if (!freshTarget || !freshSource) {
          throw new WorkHubActionGateFailure(
            'candidate_unavailable',
            'WorkHub replacement source or target is not in the admitted candidate set',
          );
        }
        this.#assertTarget(freshTarget);
        const owned = this.#ownedRoots.get(freshSource.sessionId);
        if (!owned || owned.turnId !== replacement.expectedTurnId) {
          throw new WorkHubActionGateFailure(
            'stop_not_owned',
            'WorkHub cannot stop a Turn it did not admit',
          );
        }
        if (this.#replacementRecoveries.size >= REPLACEMENT_RECOVERY_MAX_ITEMS) {
          throw new WorkHubActionEffectFailure(
            'host_not_ready',
            'WorkHub replacement recovery capacity is unavailable',
          );
        }
        const recovery: ReplacementRecovery = {
          fingerprint,
          sourceSessionId: freshSource.sessionId,
          targetSessionId: freshTarget.sessionId,
          stopped: false,
        };
        this.#replacementRecoveries.set(input.actionId, recovery);
        try {
          await this.#effects.stop(
            { sessionId: freshSource.sessionId, turnId: owned.turnId },
            context,
          );
          recovery.stopped = true;
        } catch (error) {
          if (this.#replacementRecoveries.get(input.actionId) === recovery) {
            this.#replacementRecoveries.delete(input.actionId);
          }
          throw error;
        }
        if (this.#ownedRoots.get(freshSource.sessionId) === owned) {
          this.#ownedRoots.delete(freshSource.sessionId);
        }
        return this.#resumeReplacement(input, recovery, context);
      });
    }

    return this.#submitExisting(input, target, context);
  }

  async #submitExisting(
    input: WorkHubCoordinationActInput,
    target: WorkHubCoordinationCandidate,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    return this.#submitExistingSession(input, target.sessionId, context);
  }

  async #submitExistingSession(
    input: WorkHubCoordinationActInput,
    sessionId: string,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const submitted = await this.#effects.submit(
      {
        sessionId,
        messageId: actionMessageId(input.actionId),
        text: input.userText,
      },
      context,
    );
    this.#rememberRoot(sessionId, input.actionId, submitted);
    return executionResult('delegate_existing', sessionId, submitted);
  }

  async #resumeReplacement(
    input: WorkHubCoordinationActInput,
    recovery: ReplacementRecovery,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const result = await this.#submitExistingSession(input, recovery.targetSessionId, context);
    if (this.#replacementRecoveries.get(input.actionId) === recovery) {
      this.#replacementRecoveries.delete(input.actionId);
    }
    return result;
  }

  async #withReplacementLease<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const predecessor = this.#replacementLanes.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const ownership = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => ownership);
    this.#replacementLanes.set(sessionId, tail);
    await predecessor;
    try {
      return await action();
    } finally {
      release();
      if (this.#replacementLanes.get(sessionId) === tail) {
        this.#replacementLanes.delete(sessionId);
      }
    }
  }

  #assertTarget(target: WorkHubCoordinationCandidate): void {
    if (target.sessionId === WORKHUB_COORDINATION_SESSION_ID) {
      throw new WorkHubActionGateFailure('self_route', 'WorkHub cannot delegate to itself');
    }
    if (target.state === 'waiting_for_user') {
      throw new WorkHubActionGateFailure(
        'target_waiting_for_user',
        'Target Session is waiting for user input',
      );
    }
  }

  #rememberRoot(
    sessionId: string,
    actionId: string,
    submitted: { readonly turnId: string; readonly steered?: true },
  ): void {
    if (submitted.steered) return;
    this.#ownedRoots.set(sessionId, { turnId: submitted.turnId, actionId });
  }

  #boundReplays(): void {
    while (this.#actions.size > ACTION_REPLAY_MAX_ITEMS) {
      const oldest = this.#actions.keys().next().value;
      if (oldest === undefined) return;
      this.#actions.delete(oldest);
    }
  }
}

export function candidateSet(
  sessions: readonly WorkHubActionGateSession[],
): WorkHubCoordinationCandidatesResult {
  const eligible = sessions
    .filter(isCandidateSession)
    .sort((left, right) => updatedAt(right) - updatedAt(left) || left.id.localeCompare(right.id))
    .slice(0, WORKHUB_COORDINATION_CANDIDATE_MAX_ITEMS);
  const candidateSetId = digest(
    eligible.map((session) => ({
      id: session.id,
      name: session.name,
      workspace: workspaceProjection(session),
      status: session.status,
      updatedAt: updatedAt(session),
    })),
  );
  return {
    candidateSetId,
    candidates: eligible.map((session) => ({
      candidateRef: candidateRef(candidateSetId, session.id),
      sessionId: session.id,
      sessionName: session.name,
      workspace: workspaceProjection(session),
      state: candidateState(session.status),
      updatedAt: updatedAt(session),
    })),
  };
}

function isCandidateSession(session: WorkHubActionGateSession): boolean {
  return (
    !session.isArchived &&
    !isWorkHubCoordinationSessionTarget(session) &&
    session.role === undefined &&
    session.subagentParent === undefined &&
    !session.labels.includes(SIDE_CONVERSATION_LABEL)
  );
}

function candidateRef(candidateSetId: string, sessionId: string): string {
  return `whc_${hash(`${candidateSetId}\0${sessionId}`).slice(0, 48)}`;
}

function coordinationTurnId(actionId: string, kind: 'answer' | 'clarify'): string {
  return `wha_${hash(`${actionId}\0${kind}`).slice(0, 48)}`;
}

function actionMessageId(actionId: string): string {
  return `whm_${hash(actionId).slice(0, 48)}`;
}

/**
 * Replacement is the only Slice 4 coordination action that interrupts an
 * admitted effect. Confirmation therefore comes from the exact user message,
 * never from strategy output: the message must both reject/stop the old route
 * and explicitly direct work toward a replacement.
 */
function hasExplicitReplacementIntent(userText: string): boolean {
  const chineseCorrection =
    /(?:不是|不对|搞错了?|弄错了?|错了|不要再继续)[^\n]{0,96}(?:而是|改成|改为|换成|换到|切到|转到|改派|改交|交给|用)/iu;
  const chineseStopAndReroute =
    /(?:停止|停掉|中止|取消)[^\n]{0,96}(?:改成|改为|换成|换到|切到|转到|改派|改交|交给|用)/iu;
  const englishCorrection =
    /\b(?:no|not|wrong|mistake)\b[^\n]{0,96}\b(?:instead|use|switch\s+to|change\s+to|move\s+to|route\s+to|send\s+to)\b/iu;
  const englishStopAndReroute =
    /\b(?:stop|cancel|abort)\b[^\n]{0,96}\b(?:use|switch\s+to|change\s+to|move\s+to|delegate\s+to|route\s+to|send\s+to)\b/iu;
  return (
    chineseCorrection.test(userText) ||
    chineseStopAndReroute.test(userText) ||
    englishCorrection.test(userText) ||
    englishStopAndReroute.test(userText)
  );
}

function workHubCreatedSessionId(actionId: string): string {
  return `whs_${hash(`create\0${actionId}`).slice(0, 48)}`;
}

function workspaceProjection(session: WorkHubActionGateSession): WorkspaceProjection {
  return {
    target:
      typeof session.projectId === 'string'
        ? { kind: 'project', projectId: session.projectId }
        : { kind: 'host_path', path: session.cwd },
    hostCwd: session.cwd,
  };
}

function candidateState(status: SessionStatus): WorkHubCoordinationCandidate['state'] {
  return status;
}

function updatedAt(session: WorkHubActionGateSession): number {
  return session.lastMessageAt ?? session.statusUpdatedAt ?? session.createdAt;
}

function executionResult(
  disposition: 'delegate_existing' | 'create_new',
  sessionId: string,
  submitted: { readonly turnId: string; readonly steered?: true },
): WorkHubCoordinationActResult {
  return {
    disposition,
    targetSessionId: sessionId,
    targetTurnId: submitted.turnId,
    ...(submitted.steered ? { steered: true as const } : {}),
  } as WorkHubCoordinationActResult;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${hash(JSON.stringify(value))}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
