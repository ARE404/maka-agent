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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeMessageContent } from '@maka/core/events';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  isWorkHubCoordinationSession,
  isWorkHubCoordinationSessionId,
  type SessionHeader,
  type StoredMessage,
} from '@maka/core/session';
import type { SessionAuthorityStore, SessionHeaderSnapshot } from '@maka/storage/session-store';
import type {
  OperationOutcome,
  WorkHubCoordinationAnswerInput,
  WorkHubCoordinationRecordInput,
} from '../protocol/index.js';
import type {
  ConnectionContext,
  WorkHubCoordinationOperationHandlerMap,
} from './operation-dispatcher.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionOperationFailure } from './session-catalog-coordinator.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

const CREATE_FINGERPRINT = `sha256:${createHash('sha256')
  .update('maka:workhub-coordination-session:v1', 'utf8')
  .digest('hex')}`;
const COORDINATION_CWD_DIRECTORY = 'workhub-coordination';
const COORDINATION_TOOL_PROFILE = 'workhub-coordination-v1' as const;
const SYNTHETIC_COORDINATION_MODEL_ID = 'maka-workhub-coordination';
const COORDINATION_PERMISSION_MODE = 'explore' as const;
const COORDINATION_COLLABORATION_MODE = 'agent' as const;
const COORDINATION_ORCHESTRATION_MODE = 'default' as const;

type CoordinationStores = Pick<
  SessionAuthorityStore,
  | 'appendMessages'
  | 'createStableSession'
  | 'probeStableSessionCreate'
  | 'readHeaderSnapshot'
  | 'readTranscriptHighWaterSnapshot'
  | 'readTranscriptMessagesSnapshot'
  | 'updateHeaderVersioned'
>;

type CoordinationExecutions = Pick<RootTurnCoordinator, 'startWorkHubCoordinationMessage'>;

export type CoordinationCreateTarget = Omit<CreateSessionInput, 'cwd' | 'name' | 'projectId'>;

export interface HostWorkHubCoordinationCoordinatorOptions {
  readonly stateRoot: string;
  readonly stores: CoordinationStores;
  readonly admission: SessionAdmissionGate;
  readonly continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly executions: CoordinationExecutions;
  readonly resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly requestDrain: () => void;
}

/** Resolves the one durable Coordination Session owned by this Runtime Host. */
export class HostWorkHubCoordinationCoordinator {
  readonly handlers: WorkHubCoordinationOperationHandlerMap = {
    'workhub.coordination.resolve': () => this.#resolve(),
    'workhub.coordination.answer': (input, context) => this.#answer(input, context),
    'workhub.coordination.record': (input) => this.#record(input),
  };

  readonly #coordinationCwd: string;
  readonly #stores: CoordinationStores;
  readonly #admission: SessionAdmissionGate;
  readonly #continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly #executions: CoordinationExecutions;
  readonly #resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly #requestDrain: () => void;

  constructor(options: HostWorkHubCoordinationCoordinatorOptions) {
    this.#coordinationCwd = join(options.stateRoot, COORDINATION_CWD_DIRECTORY);
    this.#stores = options.stores;
    this.#admission = options.admission;
    this.#continuity = options.continuity;
    this.#executions = options.executions;
    this.#resolveCreateTarget = options.resolveCreateTarget;
    this.#requestDrain = options.requestDrain;
  }

  #resolve(): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      // The workspace exists for provisioning and for reuse alike: a directory
      // that was pruned after creation must come back before anyone is handed
      // the identity, and mkdir is idempotent.
      try {
        await mkdir(this.#coordinationCwd, { recursive: true });
      } catch {
        return failure(
          'persistence_failed',
          'WorkHub Coordination Session workspace is unavailable',
        );
      }

      let probe;
      try {
        probe = await this.#stores.probeStableSessionCreate(
          WORKHUB_COORDINATION_SESSION_ID,
          CREATE_FINGERPRINT,
        );
      } catch {
        this.#requestDrain();
        return failure('persistence_failed', 'WorkHub Coordination Session state is unavailable');
      }

      if (probe.kind === 'existing') {
        return validCoordinationIdentityHeader(probe.record.header)
          ? await this.#alignSession(probe.record)
          : identityConflict();
      }
      if (probe.kind === 'conflict') return identityConflict();

      let target: CoordinationCreateTarget;
      try {
        target = await this.#resolveCreateTarget();
      } catch (error) {
        return createTargetFailure(error);
      }

      try {
        const result = await this.#stores.createStableSession({
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          requestFingerprint: CREATE_FINGERPRINT,
          input: {
            ...target,
            permissionMode: COORDINATION_PERMISSION_MODE,
            collaborationMode: COORDINATION_COLLABORATION_MODE,
            orchestrationMode: COORDINATION_ORCHESTRATION_MODE,
            cwd: this.#coordinationCwd,
            projectId: null,
            name: 'WorkHub',
            role: WORKHUB_COORDINATION_SESSION_ROLE,
            toolProfile: COORDINATION_TOOL_PROFILE,
          },
        });
        if (result.kind === 'conflict') return identityConflict();
        if (
          !validCoordinationHeader(result.record.header) ||
          result.record.header.cwd !== this.#coordinationCwd
        ) {
          return identityConflict();
        }
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return success();
      } catch {
        this.#requestDrain();
        return failure(
          'commit_outcome_unknown',
          'WorkHub Coordination Session creation outcome is unknown',
        );
      }
    });
  }

  async #answer(
    input: WorkHubCoordinationAnswerInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.coordination.answer'>> {
    if (!input.text.trim()) {
      return turnFailure(
        'workhub.coordination.answer',
        'operation_conflict',
        'WorkHub answer text is empty',
      );
    }
    const outcome = await this.#executions.startWorkHubCoordinationMessage(
      {
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.turnId,
        execution: {
          kind: 'workhub_coordination',
          inputDigest: digest({ text: input.text }),
        },
        archivedMessage: 'WorkHub Coordination Session is unavailable',
        content: normalizeMessageContent({ text: input.text }),
      },
      context,
    );
    return outcome.ok ? { ok: true, result: { turnId: input.turnId } } : outcome;
  }

  #record(
    input: WorkHubCoordinationRecordInput,
  ): Promise<OperationOutcome<'workhub.coordination.record'>> {
    if (!input.userText.trim() || !input.assistantText.trim()) {
      return Promise.resolve(
        turnFailure(
          'workhub.coordination.record',
          'operation_conflict',
          'WorkHub Coordination summary text is empty',
        ),
      );
    }
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      let header: SessionHeader;
      try {
        header = await this.#stores.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      } catch {
        return turnFailure(
          'workhub.coordination.record',
          'persistence_failed',
          'WorkHub Coordination Session state is unavailable',
        );
      }
      if (!validCoordinationHeader(header)) {
        return turnFailure(
          'workhub.coordination.record',
          'operation_conflict',
          'WorkHub Coordination Session identity is unavailable',
        );
      }

      const messages = coordinationSummaryMessages(input);
      try {
        const throughSequence = await this.#stores.readTranscriptHighWaterSnapshot(
          WORKHUB_COORDINATION_SESSION_ID,
        );
        const existing =
          throughSequence === null
            ? []
            : await this.#stores.readTranscriptMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID, {
                messageIds: messages.map(({ id }) => id),
                throughSequence,
                maxBytes: 32 * 1024,
                maxMessages: messages.length,
              });
        if (existing.length > 0) {
          return coordinationSummaryMatches(existing, input)
            ? { ok: true, result: { turnId: input.turnId } }
            : turnFailure(
                'workhub.coordination.record',
                'operation_conflict',
                'WorkHub Coordination Turn identity belongs to different content',
              );
        }
        await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, messages);
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return { ok: true, result: { turnId: input.turnId } };
      } catch {
        this.#requestDrain();
        return turnFailure(
          'workhub.coordination.record',
          'commit_outcome_unknown',
          'WorkHub Coordination summary outcome is unknown',
        );
      }
    });
  }

  /**
   * The workspace path is derived from the Host state root, so it moves with the
   * installation. Identity stays in the id/role pair and the durable path is
   * repaired in place — rejecting the drift would strand the one Session no
   * ordinary lifecycle operation is allowed to relocate or retire.
   */
  async #alignSession(
    record: SessionHeaderSnapshot,
  ): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    if (
      record.header.toolProfile !== undefined &&
      record.header.toolProfile !== COORDINATION_TOOL_PROFILE
    ) {
      return identityConflict();
    }
    if (record.header.cwd === this.#coordinationCwd && validCoordinationHeader(record.header)) {
      return success();
    }
    let repaired: SessionHeaderSnapshot;
    try {
      repaired = await this.#stores.updateHeaderVersioned(
        WORKHUB_COORDINATION_SESSION_ID,
        {
          ...(record.header.cwd === this.#coordinationCwd ? {} : { cwd: this.#coordinationCwd }),
          ...(record.header.toolProfile === COORDINATION_TOOL_PROFILE
            ? {}
            : { toolProfile: COORDINATION_TOOL_PROFILE }),
          ...(record.header.permissionMode === COORDINATION_PERMISSION_MODE
            ? {}
            : { permissionMode: COORDINATION_PERMISSION_MODE }),
          ...((record.header.collaborationMode ?? 'agent') === COORDINATION_COLLABORATION_MODE
            ? {}
            : { collaborationMode: COORDINATION_COLLABORATION_MODE }),
          ...((record.header.orchestrationMode ?? 'default') === COORDINATION_ORCHESTRATION_MODE
            ? {}
            : { orchestrationMode: COORDINATION_ORCHESTRATION_MODE }),
        },
        record.revision,
      );
    } catch {
      return failure(
        'persistence_failed',
        'WorkHub Coordination Session workspace could not be relocated',
      );
    }
    return validCoordinationHeader(repaired.header) && repaired.header.cwd === this.#coordinationCwd
      ? success()
      : identityConflict();
  }
}

/** Keeps a model-authority gap distinguishable from a failed authority read. */
function createTargetFailure(error: unknown): OperationOutcome<'workhub.coordination.resolve'> {
  if (error instanceof SessionOperationFailure && error.code === 'persistence_failed') {
    return failure('persistence_failed', error.message);
  }
  return failure(
    'operation_conflict',
    'WorkHub Coordination Session requires an available default model',
  );
}

function validCoordinationIdentityHeader(header: SessionHeader): boolean {
  return (
    isWorkHubCoordinationSessionId(header.id) &&
    isWorkHubCoordinationSession(header) &&
    header.projectId === null &&
    !header.isArchived &&
    header.parentSessionId === undefined &&
    header.subagentParent === undefined &&
    header.conversationCopy === undefined &&
    header.revisionRootSessionId === undefined
  );
}

function validCoordinationHeader(header: SessionHeader): boolean {
  return (
    validCoordinationIdentityHeader(header) &&
    header.toolProfile === COORDINATION_TOOL_PROFILE &&
    header.permissionMode === COORDINATION_PERMISSION_MODE &&
    (header.collaborationMode ?? 'agent') === COORDINATION_COLLABORATION_MODE &&
    (header.orchestrationMode ?? 'default') === COORDINATION_ORCHESTRATION_MODE
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function coordinationSummaryMessages(input: WorkHubCoordinationRecordInput): StoredMessage[] {
  const ts = Date.now();
  const messageId = (kind: string) =>
    `workhub_${createHash('sha256')
      .update(`${input.turnId}\0${kind}`, 'utf8')
      .digest('hex')
      .slice(0, 48)}`;
  return [
    {
      type: 'user',
      id: messageId('user'),
      turnId: input.turnId,
      ts,
      text: input.userText,
    },
    {
      type: 'assistant',
      id: messageId('assistant'),
      turnId: input.turnId,
      ts: ts + 1,
      text: input.assistantText,
      modelId: SYNTHETIC_COORDINATION_MODEL_ID,
    },
    {
      type: 'turn_state',
      id: messageId('state'),
      turnId: input.turnId,
      ts: ts + 2,
      status: 'completed',
      partialOutputRetained: false,
    },
  ];
}

function coordinationSummaryMatches(
  existing: readonly StoredMessage[],
  input: WorkHubCoordinationRecordInput,
): boolean {
  if (existing.length !== 3) return false;
  const user = existing.find((message) => message.type === 'user');
  const assistant = existing.find((message) => message.type === 'assistant');
  const state = existing.find((message) => message.type === 'turn_state');
  return (
    user?.turnId === input.turnId &&
    user.text === input.userText &&
    assistant?.turnId === input.turnId &&
    assistant.text === input.assistantText &&
    assistant.modelId === SYNTHETIC_COORDINATION_MODEL_ID &&
    state?.turnId === input.turnId &&
    state.status === 'completed'
  );
}

function success(): OperationOutcome<'workhub.coordination.resolve'> {
  return {
    ok: true,
    result: { sessionId: WORKHUB_COORDINATION_SESSION_ID },
  };
}

function identityConflict(): OperationOutcome<'workhub.coordination.resolve'> {
  return failure('operation_conflict', 'WorkHub Coordination Session identity is unavailable');
}

function failure(
  code: Extract<
    OperationOutcome<'workhub.coordination.resolve'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'workhub.coordination.resolve'> {
  return { ok: false, error: { code, message } };
}

function turnFailure<K extends 'workhub.coordination.answer' | 'workhub.coordination.record'>(
  _operation: K,
  code: Extract<OperationOutcome<K>, { readonly ok: false }>['error']['code'],
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code, message } } as OperationOutcome<K>;
}
