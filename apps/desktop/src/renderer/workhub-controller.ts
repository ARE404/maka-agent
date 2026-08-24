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

/**
 * WorkHub is a projection and routing surface over ordinary Sessions.
 * Session and Runtime remain authoritative for transcript, execution, state,
 * permissions, interactions, and recovery.
 */

import {
  createWorkHubRoutePolicy,
  type WorkHubRouteEvidence,
  workHubNewSessionName,
} from './workhub-route-policy.js';

export interface WorkHubSessionTarget {
  sessionId: string;
}

export type WorkHubSessionState =
  | 'active'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'aborted';

export interface WorkHubSessionFacts {
  target: WorkHubSessionTarget;
  projectName: string;
  sessionName: string;
  kind: 'ordinary' | 'internal' | 'subagent';
  archived: boolean;
  state: WorkHubSessionState;
  latestResult?: string;
  updatedAt: number;
}

export type WorkHubSessionSummary = Omit<WorkHubSessionFacts, 'kind'>;

export type WorkHubProjectedTurnState = 'running' | 'completed' | 'aborted' | 'failed';

export interface WorkHubProjectedTurn {
  messageId: string;
  target: WorkHubSessionTarget;
  turnId: string;
  text: string;
  state: WorkHubProjectedTurnState;
  result?: string;
  updatedAt: number;
}

const WORKHUB_TIMELINE_TEXT_LIMIT = 600;

export function boundedWorkHubTimelineText(value: string): string {
  const text = value.trim();
  const chars = Array.from(text);
  return chars.length <= WORKHUB_TIMELINE_TEXT_LIMIT
    ? text
    : `${chars.slice(0, WORKHUB_TIMELINE_TEXT_LIMIT - 1).join('')}…`;
}

export interface WorkHubProjection {
  sessions: WorkHubSessionSummary[];
  turns: WorkHubProjectedTurn[];
}

export interface WorkHubSubmitInput {
  requestId: string;
  text: string;
  explicitTarget?: WorkHubSessionTarget;
  correction?: WorkHubCorrectionContext;
}

export interface WorkHubCorrectionContext {
  from: WorkHubSessionTarget;
  turnId?: string;
  steered?: true;
}

export interface WorkHubReadInput {
  focus?: WorkHubSessionTarget;
}

export const WORKHUB_ROUTING_STRATEGY_ID = 'wh-r2.4-session-context-continuity' as const;
export type WorkHubRoutingStrategyId = typeof WORKHUB_ROUTING_STRATEGY_ID;

export type WorkHubSubmission = (
  | {
      kind: 'submitted';
      requestId: string;
      target: WorkHubSessionTarget;
      turnId: string;
      steered?: true;
      evidence: WorkHubRouteEvidence | 'new_session';
      correctedFrom?: WorkHubSessionTarget;
    }
  | {
      kind: 'clarification';
      requestId: string;
      text: string;
      options: Array<Pick<WorkHubSessionSummary, 'target' | 'projectName' | 'sessionName'>>;
      correction?: WorkHubCorrectionContext;
    }
  | {
      kind: 'discussion';
      requestId: string;
      text: string;
    }
  | {
      kind: 'waiting';
      requestId: string;
      text: string;
      target: WorkHubSessionTarget;
    }
) & { strategyId: WorkHubRoutingStrategyId };

/**
 * Internal seam. The renderer bridge is the production adapter; interface
 * tests use an in-memory adapter.
 */
export interface WorkHubSessionPort {
  list(): Promise<WorkHubSessionFacts[]>;
  /**
   * Rebuilds a bounded recent conversation from the authoritative Session
   * transcripts. Missing transcripts are omitted rather than copied elsewhere.
   */
  recentTurns(targets: readonly WorkHubSessionTarget[]): Promise<WorkHubProjectedTurn[]>;
  /**
   * Returns rebuildable routing evidence read from the authoritative Session
   * log. Implementations must not persist a second writable copy of it.
   */
  routingEvidence(
    targets: readonly WorkHubSessionTarget[],
  ): Promise<Array<{ target: WorkHubSessionTarget; originPrompt?: string }>>;
  create(input: { name: string }): Promise<WorkHubSessionFacts>;
  reserveTurnId(): string;
  submit(
    target: WorkHubSessionTarget,
    text: string,
    turnId: string,
  ): Promise<{ turnId: string; steered?: true }>;
  stop(target: WorkHubSessionTarget, expectedTurnId: string): Promise<void>;
  subscribe(handler: () => void): () => void;
}

export interface WorkHubController {
  read(input?: WorkHubReadInput): Promise<WorkHubProjection>;
  submit(input: WorkHubSubmitInput): Promise<WorkHubSubmission>;
  subscribe(handler: () => void): () => void;
  resetVisitContext(): void;
}

const MAX_OWNERSHIP_RECORDS = 32;
const MAX_STOPPED_TURN_IDS_PER_TOMBSTONE = 32;

interface WorkHubRootOwnership {
  order: number;
  turnId: string;
}

interface WorkHubSessionOwnership {
  confirmed?: WorkHubRootOwnership;
  pending: WorkHubRootOwnership[];
}

interface WorkHubOwnershipTombstone {
  order: number;
  stoppedTurnIds: Set<string>;
}

export function createWorkHubController(deps: {
  sessions: WorkHubSessionPort;
}): WorkHubController {
  let routePolicy = createWorkHubRoutePolicy();
  let focusReadVersion = 0;
  let pendingFocusReadVersion: number | undefined;
  const liveOwnershipBySessionId = new Map<string, WorkHubSessionOwnership>();
  const ownershipTombstoneBySessionId = new Map<string, WorkHubOwnershipTombstone>();
  const reconcileFocus = (
    policy: ReturnType<typeof createWorkHubRoutePolicy>,
    sessions: readonly WorkHubSessionFacts[],
  ) => {
    policy.initializeFocus(sessions
      .filter((session) => session.kind === 'ordinary' && !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => session.target));
  };
  const correctionFor = (from: WorkHubSessionTarget): WorkHubCorrectionContext => {
    const ownership = liveOwnershipBySessionId.get(from.sessionId);
    const turnId = ownership?.confirmed?.turnId ?? ownership?.pending[0]?.turnId;
    if (!turnId) return { from };
    return {
      from,
      turnId,
    };
  };
  const storeLiveOwnership = (
    target: WorkHubSessionTarget,
    ownership: WorkHubSessionOwnership,
  ) => {
    liveOwnershipBySessionId.delete(target.sessionId);
    liveOwnershipBySessionId.set(target.sessionId, ownership);
    while (liveOwnershipBySessionId.size > MAX_OWNERSHIP_RECORDS) {
      const oldest = liveOwnershipBySessionId.keys().next().value;
      if (!oldest) break;
      liveOwnershipBySessionId.delete(oldest);
    }
  };
  const storeOwnershipTombstone = (
    sessionId: string,
    order: number,
    stoppedTurnIds: Iterable<string> = [],
  ) => {
    const existing = ownershipTombstoneBySessionId.get(sessionId);
    if (existing && existing.order > order) return;
    const stopped = new Set(existing?.order === order ? existing.stoppedTurnIds : []);
    for (const turnId of stoppedTurnIds) stopped.add(turnId);
    while (stopped.size > MAX_STOPPED_TURN_IDS_PER_TOMBSTONE) {
      const oldest = stopped.values().next().value;
      if (!oldest) break;
      stopped.delete(oldest);
    }
    ownershipTombstoneBySessionId.delete(sessionId);
    ownershipTombstoneBySessionId.set(sessionId, {
      order,
      stoppedTurnIds: stopped,
    });
    while (ownershipTombstoneBySessionId.size > MAX_OWNERSHIP_RECORDS) {
      const oldest = ownershipTombstoneBySessionId.keys().next().value;
      if (!oldest) break;
      ownershipTombstoneBySessionId.delete(oldest);
    }
  };
  const reserveOwnedRoot = (
    target: WorkHubSessionTarget,
    turnId: string,
    order: number,
  ) => {
    const existing = liveOwnershipBySessionId.get(target.sessionId);
    storeLiveOwnership(target, {
      ...(existing?.confirmed ? { confirmed: existing.confirmed } : {}),
      pending: [...(existing?.pending ?? []), { order, turnId }]
        .sort((left, right) => left.order - right.order),
    });
  };
  const settleOwnedRoot = async (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    turn: { turnId: string; steered?: true },
    order: number,
  ) => {
    let tombstone = ownershipTombstoneBySessionId.get(target.sessionId);
    if (
      !turn.steered &&
      tombstone &&
      tombstone.order >= order &&
      !tombstone.stoppedTurnIds.has(turn.turnId)
    ) {
      await deps.sessions.stop(target, turn.turnId);
      storeOwnershipTombstone(target.sessionId, tombstone.order, [turn.turnId]);
    }
    const existing = liveOwnershipBySessionId.get(target.sessionId);
    tombstone = ownershipTombstoneBySessionId.get(target.sessionId);
    if (!existing) return;
    const pending = existing.pending.filter((candidate) =>
      (candidate.order !== order || candidate.turnId !== reservedTurnId) &&
      (!tombstone || candidate.order > tombstone.order));
    let confirmed = existing.confirmed &&
      (!tombstone || existing.confirmed.order > tombstone.order)
      ? existing.confirmed
      : undefined;
    if (
      !turn.steered &&
      (!tombstone || tombstone.order < order) &&
      (!confirmed || confirmed.order <= order)
    ) {
      confirmed = { order, turnId: turn.turnId };
      ownershipTombstoneBySessionId.delete(target.sessionId);
    }
    if (confirmed || pending.length > 0) {
      storeLiveOwnership(target, {
        ...(confirmed ? { confirmed } : {}),
        pending,
      });
    } else {
      liveOwnershipBySessionId.delete(target.sessionId);
    }
  };
  const releasePendingRoot = (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    order: number,
  ) => {
    const existing = liveOwnershipBySessionId.get(target.sessionId);
    if (!existing) return;
    const tombstone = ownershipTombstoneBySessionId.get(target.sessionId);
    const pending = existing.pending.filter((candidate) =>
      (candidate.order !== order || candidate.turnId !== reservedTurnId) &&
      (!tombstone || candidate.order > tombstone.order));
    const confirmed = existing.confirmed &&
      (!tombstone || existing.confirmed.order > tombstone.order)
      ? existing.confirmed
      : undefined;
    if (confirmed || pending.length > 0) {
      storeLiveOwnership(target, {
        ...(confirmed ? { confirmed } : {}),
        pending,
      });
    } else {
      liveOwnershipBySessionId.delete(target.sessionId);
    }
  };
  const stopOwnedRoots = async (
    correction: WorkHubCorrectionContext,
    order: number,
  ) => {
    if (correction.steered) return;
    const ownership = liveOwnershipBySessionId.get(correction.from.sessionId);
    const turnIds = new Set<string>();
    if (correction.turnId) turnIds.add(correction.turnId);
    if (ownership?.confirmed && ownership.confirmed.order < order) {
      turnIds.add(ownership.confirmed.turnId);
    }
    for (const pending of ownership?.pending ?? []) {
      if (pending.order < order) turnIds.add(pending.turnId);
    }
    if (turnIds.size === 0) return;
    // Publish the correction before awaiting Host acknowledgements. A pending
    // admission may settle with a Host-rebound Turn ID while these stops are
    // in flight; settleOwnedRoot will then stop that returned root as well.
    storeOwnershipTombstone(correction.from.sessionId, order, turnIds);
    for (const turnId of turnIds) {
      await deps.sessions.stop(correction.from, turnId);
    }
    const current = liveOwnershipBySessionId.get(correction.from.sessionId);
    if (!current) return;
    const confirmed = current.confirmed && current.confirmed.order >= order
      ? current.confirmed
      : undefined;
    const pending = current.pending.filter((candidate) => candidate.order >= order);
    if (confirmed || pending.length > 0) {
      storeLiveOwnership(correction.from, {
        ...(confirmed ? { confirmed } : {}),
        pending,
      });
    } else {
      liveOwnershipBySessionId.delete(correction.from.sessionId);
    }
  };
  return {
    subscribe(handler) {
      return deps.sessions.subscribe(handler);
    },
    async read(input) {
      const readPolicy = routePolicy;
      let readFocusVersion = focusReadVersion;
      if (input?.focus) {
        readFocusVersion = ++focusReadVersion;
        pendingFocusReadVersion = readFocusVersion;
        readPolicy.rememberTarget(input.focus);
      }
      try {
        const facts = await deps.sessions.list();
        const ordinary = facts
          .filter((session) => session.kind === 'ordinary')
          .sort((left, right) => right.updatedAt - left.updatedAt);
        if (
          readFocusVersion === focusReadVersion &&
          (input?.focus || pendingFocusReadVersion === undefined)
        ) {
          reconcileFocus(readPolicy, facts);
        }
        return {
          sessions: ordinary
            .map(({ kind: _kind, ...session }) => session),
          turns: await deps.sessions.recentTurns(ordinary.map((session) => session.target)),
        };
      } finally {
        if (input?.focus && pendingFocusReadVersion === readFocusVersion) {
          pendingFocusReadVersion = undefined;
        }
      }
    },
    async submit(input) {
      const submissionPolicy = routePolicy;
      // Reserve the order synchronously, before any await. Corrections are
      // learned only after successful delivery, but their precedence follows
      // user submission order rather than network completion order.
      const submissionOrder = submissionPolicy.reserveSubmissionOrder();
      const sessions = await deps.sessions.list();
      reconcileFocus(submissionPolicy, sessions);
      const ordinary = sessions.filter((session) => session.kind === 'ordinary');
      // Archived Sessions remain visible as historical work, but Runtime Host
      // rejects new root Turns for them. Never offer one as a routing target.
      const routable = ordinary.filter((session) => !session.archived);
      const routingEvidence = input.explicitTarget
        ? []
        : await deps.sessions.routingEvidence(routable.map((session) => session.target));
      const decision = submissionPolicy.resolve({
        text: input.text,
        sessions: routable,
        originPromptBySessionId: new Map(
          routingEvidence.map((entry) => [entry.target.sessionId, entry.originPrompt]),
        ),
        ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
      });
      if (decision.kind === 'clarification') {
        const correction = decision.correctedFrom
          ? correctionFor(decision.correctedFrom)
          : undefined;
        return {
          kind: 'clarification',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          options: decision.options.map((session) => ({
            target: session.target,
            projectName: session.projectName,
            sessionName: session.sessionName,
          })),
          ...(correction ? { correction } : {}),
        };
      }
      if (decision.kind === 'discussion') {
        return {
          kind: 'discussion',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
        };
      }
      let target: WorkHubSessionTarget;
      let evidence: Extract<WorkHubSubmission, { kind: 'submitted' }>['evidence'];
      const correction = input.correction ?? (decision.kind === 'target' && decision.correctedFrom
        ? correctionFor(decision.correctedFrom)
        : undefined);
      if (decision.kind === 'new_session') {
        const created = await deps.sessions.create({ name: workHubNewSessionName(input.text) });
        if (created.kind !== 'ordinary') {
          throw new Error('WorkHub can only create ordinary Sessions');
        }
        target = created.target;
        evidence = 'new_session';
      } else {
        target = decision.target;
        evidence = correction ? 'route_correction' : decision.evidence;
      }
      const targetSession = routable.find(
        (session) => session.target.sessionId === target.sessionId,
      );
      if (!targetSession && evidence !== 'new_session') {
        throw new Error('WorkHub target Session is unavailable');
      }
      if (targetSession?.state === 'waiting_for_user') {
        return {
          kind: 'waiting',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          target,
        };
      }
      if (correction) {
        await stopOwnedRoots(correction, submissionOrder);
      }
      const reservedTurnId = deps.sessions.reserveTurnId();
      reserveOwnedRoot(target, reservedTurnId, submissionOrder);
      let turn: { turnId: string; steered?: true };
      try {
        turn = await deps.sessions.submit(target, input.text, reservedTurnId);
      } catch (error) {
        releasePendingRoot(target, reservedTurnId, submissionOrder);
        throw error;
      }
      await settleOwnedRoot(target, reservedTurnId, turn, submissionOrder);
      submissionPolicy.rememberTarget(target);
      if (correction) {
        submissionPolicy.rememberCorrection(input.text, target, submissionOrder);
      }
      return {
        kind: 'submitted',
        strategyId: WORKHUB_ROUTING_STRATEGY_ID,
        requestId: input.requestId,
        target,
        turnId: turn.turnId,
        ...(turn.steered ? { steered: true as const } : {}),
        evidence,
        ...(correction ? { correctedFrom: correction.from } : {}),
      };
    },
    resetVisitContext() {
      focusReadVersion += 1;
      pendingFocusReadVersion = undefined;
      routePolicy = routePolicy.newVisit();
    },
  };
}
