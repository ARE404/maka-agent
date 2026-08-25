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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  type WorkHubActionGateEffects,
  type WorkHubActionGateSession,
} from '../server/workhub-coordination-action-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-action-gate-test',
  connectionId: 'workhub-action-gate-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('WorkHub Coordination Action Gate', () => {
  test('exposes only bounded ordinary candidates and proposals use opaque refs', async () => {
    const effects = fakeEffects([
      session('ordinary'),
      session('archived', { isArchived: true }),
      session('waiting', { status: 'waiting_for_user' }),
      session('side', { labels: ['mode:side_conversation'] }),
      session('child', {
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'ordinary',
          spawnedBy: { parentTurnId: 'turn', parentRunId: 'run', toolCallId: 'tool' },
          lifecycle: 'foreground',
        },
      }),
      session('maka_workhub_coordination', { role: 'workhub_coordination' }),
    ]);
    const result = await new WorkHubCoordinationActionGate(effects).candidates();

    assert.deepEqual(
      result.candidates.map(({ sessionId }) => sessionId),
      ['ordinary', 'waiting'],
    );
    assert.match(result.candidateSetId, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(result.candidates[0]?.candidateRef, 'ordinary');

    const bounded = await new WorkHubCoordinationActionGate(
      fakeEffects(Array.from({ length: 40 }, (_, index) => session(`ordinary-${index}`))),
    ).candidates();
    assert.equal(bounded.candidates.length, 32);
  });

  test('rejects stale and invented candidates before any Session effect', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();
    effects.sessions[0] = session('payments', { statusUpdatedAt: 9 });

    await assert.rejects(
      gate.act(
        {
          actionId: 'stale-action',
          userText: 'Continue payments',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'candidate_set_stale',
    );
    assert.deepEqual(effects.submissions, []);

    const refreshed = await gate.candidates();
    const retried = await gate.act(
      {
        actionId: 'stale-action',
        userText: 'Continue payments',
        candidateSetId: refreshed.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: refreshed.candidates[0]!.candidateRef,
        },
      },
      CONTEXT,
    );
    assert.equal(retried.disposition, 'delegate_existing');
    effects.submissions.length = 0;

    const current = await gate.candidates();
    await assert.rejects(
      gate.act(
        {
          actionId: 'invented-action',
          userText: 'Continue payments',
          candidateSetId: current.candidateSetId,
          proposal: { disposition: 'delegate_existing', candidateRef: 'invented_candidate' },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'candidate_unavailable',
    );
    assert.deepEqual(effects.submissions, []);
  });

  test('rejects waiting targets independently of strategy behavior', async () => {
    const effects = fakeEffects([session('waiting', { status: 'waiting_for_user' })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const snapshot = await gate.candidates();

    await assert.rejects(
      gate.act(
        {
          actionId: 'waiting-action',
          userText: 'Do another thing',
          candidateSetId: snapshot.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: snapshot.candidates[0]!.candidateRef,
          },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'target_waiting_for_user',
    );
    assert.deepEqual(effects.submissions, []);
  });

  test('answers and clarifies only through the Coordination transcript effects', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);

    const answered = await gate.act(
      {
        actionId: 'answer-action',
        userText: 'What is useMemo?',
        proposal: { disposition: 'answer_here' },
      },
      CONTEXT,
    );
    const clarified = await gate.act(
      {
        actionId: 'clarify-action',
        userText: 'Continue that task',
        proposal: { disposition: 'clarify', assistantText: 'Which task do you mean?' },
      },
      CONTEXT,
    );

    assert.equal(answered.disposition, 'answer_here');
    assert.equal(clarified.disposition, 'clarify');
    assert.equal(effects.answers.length, 1);
    assert.equal(effects.clarifications.length, 1);
    assert.deepEqual(effects.submissions, []);
    assert.deepEqual(effects.creations, []);
  });

  test('only create_new creates and retries the exact action idempotently', async () => {
    const effects = fakeEffects([session('ordinary')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const input = {
      actionId: 'create-action',
      userText: 'Create an accessibility audit',
      proposal: { disposition: 'create_new' as const, title: 'Accessibility audit' },
      create: {
        workspace: { kind: 'host_path' as const, path: '/workspace' },
      },
    };

    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);

    assert.deepEqual(replay, first);
    assert.equal(effects.creations.length, 1);
    assert.equal(effects.submissions.length, 1);
    assert.match(effects.creations[0]?.sessionId ?? '', /^whs_[a-f0-9]{48}$/u);
    assert.equal(first.disposition, 'create_new');
    if (first.disposition === 'create_new') {
      assert.equal(first.targetSessionId, effects.creations[0]?.sessionId);
    }
    assert.deepEqual(Object.keys(effects.creations[0]!).sort(), [
      'sessionId',
      'title',
      'workspace',
    ]);
    await assert.rejects(
      gate.act({ ...input, proposal: { disposition: 'create_new', title: 'Different' } }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.creations.length, 1);
  });

  test('stops only an exact root previously admitted by this gate', async () => {
    const effects = fakeEffects([session('source'), session('target', { statusUpdatedAt: 2 })]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const firstSet = await gate.candidates();
    const source = firstSet.candidates.find(({ sessionId }) => sessionId === 'source')!;
    const target = firstSet.candidates.find(({ sessionId }) => sessionId === 'target')!;
    const first = await gate.act(
      {
        actionId: 'source-action',
        userText: 'Start source work',
        candidateSetId: firstSet.candidateSetId,
        proposal: { disposition: 'delegate_existing', candidateRef: source.candidateRef },
      },
      CONTEXT,
    );
    assert.equal(first.disposition, 'delegate_existing');
    if (first.disposition !== 'delegate_existing') return;

    await assert.rejects(
      gate.act(
        {
          actionId: 'bad-correction',
          userText: 'No, use target',
          candidateSetId: firstSet.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: target.candidateRef,
            replace: { candidateRef: source.candidateRef, expectedTurnId: 'not-owned' },
          },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'stop_not_owned',
    );
    assert.deepEqual(effects.stops, []);

    await assert.rejects(
      gate.act(
        {
          actionId: 'unconfirmed-correction',
          userText: 'Continue the target work',
          candidateSetId: firstSet.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: target.candidateRef,
            replace: { candidateRef: source.candidateRef, expectedTurnId: first.targetTurnId },
          },
        },
        CONTEXT,
      ),
      (error) =>
        error instanceof WorkHubActionGateFailure && error.code === 'confirmation_required',
    );
    assert.deepEqual(effects.stops, []);
    assert.equal(effects.submissions.length, 1);

    await gate.act(
      {
        actionId: 'good-correction',
        userText: 'No, use target',
        candidateSetId: firstSet.candidateSetId,
        proposal: {
          disposition: 'delegate_existing',
          candidateRef: target.candidateRef,
          replace: { candidateRef: source.candidateRef, expectedTurnId: first.targetTurnId },
        },
      },
      CONTEXT,
    );
    assert.deepEqual(effects.stops, [{ sessionId: 'source', turnId: first.targetTurnId }]);
    assert.equal(effects.submissions.at(-1)?.sessionId, 'target');
  });
});

function session(
  id: string,
  patch: Partial<WorkHubActionGateSession> = {},
): WorkHubActionGateSession {
  return {
    id,
    cwd: `/workspace/${id}`,
    projectId: null,
    createdAt: 1,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
    ...patch,
  };
}

function fakeEffects(initialSessions: WorkHubActionGateSession[]) {
  const state = {
    sessions: [...initialSessions],
    answers: [] as Array<{ turnId: string; text: string }>,
    clarifications: [] as Array<{
      turnId: string;
      userText: string;
      assistantText: string;
    }>,
    creations: [] as Array<{
      sessionId: string;
      workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
      title: string;
    }>,
    submissions: [] as Array<{ sessionId: string; messageId: string; text: string }>,
    stops: [] as Array<{ sessionId: string; turnId: string }>,
    async listSessions() {
      return this.sessions;
    },
    async answer(input: { turnId: string; text: string }) {
      this.answers.push(input);
    },
    async clarify(input: { turnId: string; userText: string; assistantText: string }) {
      this.clarifications.push(input);
    },
    async create(input: {
      sessionId: string;
      workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
      title: string;
    }) {
      this.creations.push(input);
    },
    async submit(input: { sessionId: string; messageId: string; text: string }) {
      this.submissions.push(input);
      return { turnId: `turn-${input.sessionId}` };
    },
    async stop(input: { sessionId: string; turnId: string }) {
      this.stops.push(input);
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    answers: Array<{ turnId: string; text: string }>;
    clarifications: Array<{ turnId: string; userText: string; assistantText: string }>;
    creations: Array<{
      sessionId: string;
      workspace: { kind: 'project'; projectId: string } | { kind: 'host_path'; path: string };
      title: string;
    }>;
    submissions: Array<{ sessionId: string; messageId: string; text: string }>;
    stops: Array<{ sessionId: string; turnId: string }>;
  };
  return state;
}
