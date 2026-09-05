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
 * The renderer-side WorkHub interface.
 *
 * WorkHub is a projection and routing surface over ordinary Sessions. Session
 * and Runtime remain authoritative for transcript, execution, state,
 * permissions, interactions, and recovery. Desktop adapters implement the two
 * ports below; the controller coordinates them without becoming their contract.
 */

import type {
  OperationError,
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidatesResult,
} from '@maka/runtime-host/protocol';

export type WorkHubRouteEvidence =
  | 'explicit_target'
  | 'exact_session_name'
  | 'route_correction'
  | 'core_entity'
  | 'recent_focus';

export type WorkHubStopClarificationReason =
  | 'stop_target_required'
  | 'stop_target_ambiguous'
  | 'stop_target_unavailable';

/** A Host refusal that callers may handle without depending on an adapter. */
export class WorkHubCoordinationFailure extends Error {
  constructor(
    readonly code: OperationError<'workhub.coordination.act'>['code'],
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubCoordinationFailure';
  }
}

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
  /** Authoritative live Turn IDs when the Session catalog provides them. */
  runningTurnIds?: readonly string[];
  latestResult?: string;
  updatedAt: number;
}

export type WorkHubSessionSummary = Omit<WorkHubSessionFacts, 'kind' | 'runningTurnIds'>;

export type WorkHubProjectedTurnState = 'running' | 'completed' | 'aborted' | 'failed';

export type WorkHubDelegationExecutionState =
  | 'accepted'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'recovering';

export interface WorkHubDelegationReference {
  readonly delegationId: string;
  readonly targetSessionId: string;
  /** Stable delegated work identity; targetTurnId is only its admission location. */
  readonly targetMessageId: string;
  readonly targetTurnId: string;
}

export interface WorkHubDelegationFeedback {
  readonly delegationId: string;
  readonly state: WorkHubDelegationExecutionState;
}

export interface WorkHubProjectedTurn {
  messageId: string;
  target: WorkHubSessionTarget;
  turnId: string;
  text: string;
  state: WorkHubProjectedTurnState;
  result?: string;
  updatedAt: number;
}

export interface WorkHubCoordinationTurn {
  messageId: string;
  turnId: string;
  text: string;
  state: WorkHubProjectedTurnState;
  result?: string;
  assignment?: {
    readonly actionId: string;
    readonly delegationId: string;
    readonly targetSessionId: string;
    readonly targetSessionName: string;
    readonly targetMessageId: string;
    readonly targetTurnId: string;
    readonly feedbackState: WorkHubDelegationExecutionState;
    readonly linkState: WorkHubDelegationLinkState;
    readonly createdNew?: true;
  };
  stop?: {
    readonly targetSessionId: string;
    readonly targetSessionName: string;
    readonly outcome?: Extract<WorkHubCoordinationActResult, { disposition: 'stop_work' }>['outcome'];
  };
  updatedAt: number;
}

export type WorkHubDelegationLinkState = 'active' | 'superseded' | 'aborted' | 'stopped';

/** Unbounded, rebuildable linkage state kept separate from the bounded timeline. */
export interface WorkHubActiveDelegation {
  readonly actionId: string;
  readonly targetSessionId: string;
  readonly sequence: number;
}

const WORKHUB_TIMELINE_TEXT_LIMIT = 600;

/** Applies the bounded-text invariant shared by both projection adapters. */
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
  retryAction?: true;
  explicitTarget?: WorkHubSessionTarget;
  correction?: WorkHubCorrectionContext;
}

export interface WorkHubCorrectionContext {
  from: WorkHubSessionTarget;
  sourceActionId: string;
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
      reason?: 'ambiguous_command' | WorkHubStopClarificationReason;
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
  | {
      kind: 'stop';
      requestId: string;
      target: WorkHubSessionTarget;
      outcome: Extract<WorkHubCoordinationActResult, { disposition: 'stop_work' }>['outcome'];
      targetTurnId?: string;
    }
) & { strategyId: WorkHubRoutingStrategyId };

/**
 * Read-only access to ordinary Session facts. The Desktop bridge is the
 * production adapter; controller tests use an in-memory adapter.
 */
export interface WorkHubSessionPort {
  list(): Promise<WorkHubSessionFacts[]>;
  /** Rebuilds a bounded recent conversation from authoritative transcripts. */
  recentTurns(targets: readonly WorkHubSessionTarget[]): Promise<WorkHubProjectedTurn[]>;
  /** Rebuilds target-owned execution facts for durable delegation links. */
  delegationFeedback(
    references: readonly WorkHubDelegationReference[],
  ): Promise<readonly WorkHubDelegationFeedback[]>;
  /** Returns rebuildable routing evidence from the authoritative Session log. */
  routingEvidence(
    targets: readonly WorkHubSessionTarget[],
  ): Promise<Array<{ target: WorkHubSessionTarget; originPrompt?: string }>>;
  subscribe(handler: () => void): () => void;
}

/**
 * Access to Coordination Session facts and the Runtime Host Action Gate. Only
 * `act` can request an effect, and the Host remains the admission authority.
 */
export interface WorkHubCoordinationPort {
  open(
    handler: (
      turns: readonly WorkHubCoordinationTurn[],
      activeDelegations: readonly WorkHubActiveDelegation[],
    ) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  record(input: {
    turnId: string;
    userText: string;
    assistantText: string;
  }): Promise<{ turnId: string }>;
  candidates(): Promise<WorkHubCoordinationCandidatesResult>;
  act(input: Omit<WorkHubCoordinationActInput, 'create'>): Promise<WorkHubCoordinationActResult>;
}

export interface WorkHubController {
  read(input?: WorkHubReadInput): Promise<WorkHubProjection>;
  submit(input: WorkHubSubmitInput): Promise<WorkHubSubmission>;
  openConversation(
    handler: (turns: readonly WorkHubCoordinationTurn[]) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  recordConversationTurn(input: {
    turnId: string;
    userText: string;
    assistantText: string;
    disposition?: 'clarify' | 'summary';
  }): Promise<{ turnId: string }>;
  subscribe(handler: () => void): () => void;
  resetVisitContext(): void;
}
