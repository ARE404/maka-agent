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
import test from 'node:test';
import {
  createWorkHubController,
  WORKHUB_ROUTING_STRATEGY_ID,
  type WorkHubSessionFacts,
  type WorkHubSessionPort,
} from '../../renderer/workhub-controller.js';

test('binds the controller to the immutable WH-R2.4 strategy ID', () => {
  assert.equal(WORKHUB_ROUTING_STRATEGY_ID, 'wh-r2.4-session-context-continuity');
});

function session(
  sessionId: string,
  overrides: Partial<WorkHubSessionFacts> = {},
): WorkHubSessionFacts {
  return {
    target: { sessionId },
    projectName: 'maka',
    sessionName: sessionId,
    kind: 'ordinary',
    archived: false,
    state: 'active',
    updatedAt: 1,
    ...overrides,
  };
}

function port(sessions: WorkHubSessionFacts[]): WorkHubSessionPort {
  return {
    list: async () => sessions,
    recentTurns: async () => [],
    routingEvidence: async () => [],
    create: async () => {
      throw new Error('create is not used by this read test');
    },
    submit: async () => {
      throw new Error('submit is not used by this read test');
    },
    stop: async () => {},
    subscribe: () => () => {},
  };
}

test('read exposes existing ordinary Sessions as factual Work summaries', async () => {
  const controller = createWorkHubController({
    sessions: port([
      session('login', {
        sessionName: '登录刷新令牌',
        state: 'running',
        latestResult: '已定位到刷新竞争条件',
        updatedAt: 30,
      }),
      session('payment', {
        projectName: 'billing',
        sessionName: '支付回调幂等性',
        archived: true,
        latestResult: '处理支付回调重复投递',
        updatedAt: 20,
      }),
      session('hub-internal', { kind: 'internal', updatedAt: 50 }),
      session('child-agent', { kind: 'subagent', updatedAt: 40 }),
    ]),
  });

  const projection = await controller.read();

  assert.deepEqual(projection.sessions, [
    {
      target: { sessionId: 'login' },
      projectName: 'maka',
      sessionName: '登录刷新令牌',
      archived: false,
      state: 'running',
      latestResult: '已定位到刷新竞争条件',
      updatedAt: 30,
    },
    {
      target: { sessionId: 'payment' },
      projectName: 'billing',
      sessionName: '支付回调幂等性',
      archived: true,
      state: 'active',
      latestResult: '处理支付回调重复投递',
      updatedAt: 20,
    },
  ]);
  assert.deepEqual(projection.turns, []);
});

test('read rebuilds a bounded conversation projection from ordinary Session turns', async () => {
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌', updatedAt: 30 }),
    session('internal', { kind: 'internal', updatedAt: 40 }),
  ]);
  const requestedTargets: string[][] = [];
  sessions.recentTurns = async (targets) => {
    requestedTargets.push(targets.map((target) => target.sessionId));
    return [{
      messageId: 'user-1',
      target: { sessionId: 'login' },
      turnId: 'turn-login',
      text: '检查刷新令牌竞争条件',
      state: 'completed',
      result: '已定位到并发刷新窗口',
      updatedAt: 20,
    }];
  };

  const projection = await createWorkHubController({ sessions }).read();

  assert.deepEqual(requestedTargets, [['login']]);
  assert.deepEqual(projection.turns, [{
    messageId: 'user-1',
    target: { sessionId: 'login' },
    turnId: 'turn-login',
    text: '检查刷新令牌竞争条件',
    state: 'completed',
    result: '已定位到并发刷新窗口',
    updatedAt: 20,
  }]);
});

test('archived Sessions stay inspectable but are excluded from routing targets', async () => {
  const evidenceTargets: string[][] = [];
  const submitted: string[] = [];
  const sessions = port([
    session('archived-payment', {
      sessionName: '支付回调幂等性',
      archived: true,
      updatedAt: 30,
    }),
    session('active-login', {
      sessionName: '登录刷新令牌',
      updatedAt: 20,
    }),
  ]);
  sessions.routingEvidence = async (targets) => {
    evidenceTargets.push(targets.map((target) => target.sessionId));
    return [];
  };
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'unexpected' };
  };
  const controller = createWorkHubController({ sessions });

  const projection = await controller.read();
  const result = await controller.submit({
    requestId: 'archived-target',
    text: '支付回调幂等性现在是什么状态？',
  });

  assert.equal(projection.sessions.some((entry) => entry.archived), true);
  assert.deepEqual(evidenceTargets, [['active-login']]);
  assert.equal(result.kind, 'discussion');
  assert.deepEqual(submitted, []);
});

test('submit sends an explicitly targeted request to that Session', async () => {
  const submitted: Array<{ sessionId: string; text: string }> = [];
  const sessions = port([session('payment', { sessionName: '支付回调幂等性' })]);
  sessions.submit = async (target, text) => {
    submitted.push({ sessionId: target.sessionId, text });
    return { turnId: 'turn-payment' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-1',
    text: '补充重复投递测试',
    explicitTarget: { sessionId: 'payment' },
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-1',
    target: { sessionId: 'payment' },
    turnId: 'turn-payment',
    evidence: 'explicit_target',
  });
  assert.deepEqual(submitted, [
    { sessionId: 'payment', text: '补充重复投递测试' },
  ]);
});

test('submit routes a unique complete Session name without asking', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌' }),
    session('payment', { projectName: 'billing', sessionName: '支付回调幂等性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-exact' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-exact',
    text: '在支付回调幂等性里补充重复投递测试',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-exact',
    target: { sessionId: 'payment' },
    turnId: 'turn-exact',
    evidence: 'exact_session_name',
  });
  assert.deepEqual(submitted, ['payment']);
});

test('a unique longer Session name outranks a generic contained Session name', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('layout', { sessionName: '优化WorkHub移动端消息布局' }),
    session('generic', { sessionName: 'WorkHub' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-layout' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'request-layout',
    text: '优化WorkHub移动端消息布局：补充横屏注意点。',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(submitted, ['layout']);
});

test('a short Latin Session name does not match inside another word', async () => {
  const submitted: string[] = [];
  const created: string[] = [];
  const sessions = port([
    session('ai', { sessionName: 'AI' }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-new', { sessionName: name });
  };
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-parser' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'request-parser',
    text: '修复 repair parser 的错误',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['修复 repair parser 的错误']);
  assert.deepEqual(submitted, ['parser-new']);
});

test('a one-character Latin discriminator prevents routing to a different Session name', async () => {
  for (const { existingName, requestedName } of [
    { existingName: 'GPT-4', requestedName: 'GPT-3' },
    { existingName: 'Project A', requestedName: 'Project B' },
  ]) {
    const submitted: string[] = [];
    const sessions = port([
      session('existing', { sessionName: existingName }),
    ]);
    sessions.create = async ({ name }) => session('new', { sessionName: name });
    sessions.submit = async (target) => {
      submitted.push(target.sessionId);
      return { turnId: 'turn-new' };
    };

    const result = await createWorkHubController({ sessions }).submit({
      requestId: `request-${requestedName}`,
      text: `请处理 ${requestedName} 的问题`,
    });

    assert.equal(result.kind, 'submitted');
    assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
    assert.deepEqual(submitted, ['new']);
  }
});

test('submit asks the user when weak relevance matches more than one Session', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '处理刷新令牌过期造成的重复登录',
      updatedAt: 20,
    }),
    session('payment', {
      projectName: 'billing',
      sessionName: '支付回调幂等性',
      latestResult: '处理支付回调重复投递',
      updatedAt: 30,
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'unexpected' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-ambiguous',
    text: '继续处理重复问题',
  });

  assert.deepEqual(result, {
    kind: 'clarification',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-ambiguous',
    text: '继续处理重复问题',
    options: [
      {
        target: { sessionId: 'payment' },
        projectName: 'billing',
        sessionName: '支付回调幂等性',
      },
      {
        target: { sessionId: 'login' },
        projectName: 'maka',
        sessionName: '登录刷新令牌',
      },
    ],
  });
  assert.deepEqual(submitted, []);
});

test('submit keeps origin prompts as stable evidence after latest results change', async () => {
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '已经整理为检查清单',
      updatedAt: 20,
    }),
    session('payment', {
      sessionName: '支付回调幂等性',
      latestResult: '已经把风险按高、中、低分组',
      updatedAt: 30,
    }),
  ]);
  sessions.routingEvidence = async () => [
    {
      target: { sessionId: 'login' },
      originPrompt: '排查刷新令牌过期导致的重复登录',
    },
    {
      target: { sessionId: 'payment' },
      originPrompt: '检查支付回调重复投递时的幂等性',
    },
  ];
  sessions.submit = async () => ({ turnId: 'turn-focus-login' });
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-focus-login',
    text: '先看登录',
    explicitTarget: { sessionId: 'login' },
  });

  const result = await controller.submit({
    requestId: 'request-origin-ambiguity',
    text: '继续处理重复问题',
  });

  assert.equal(result.kind, 'clarification');
  assert.deepEqual(result.kind === 'clarification'
    ? result.options.map((option) => option.target.sessionId)
    : [], ['payment', 'login']);
});

test('submit creates a new executable topic instead of following one weak old clue', async () => {
  const createdNames: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '已经整理为检查清单',
    }),
  ]);
  sessions.routingEvidence = async () => [{
    target: { sessionId: 'login' },
    originPrompt: '排查刷新令牌过期导致的重复登录',
  }];
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('payment-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-payment-new' });
  const controller = createWorkHubController({ sessions });
  const text = '检查支付回调重复投递时的幂等性，先只分析风险和测试点，不修改文件。';

  const result = await controller.submit({ requestId: 'request-payment-new', text });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment-new',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(createdNames, ['检查支付回调重复投递时的幂等性']);
});

test('submit does not treat a project name as strong topic evidence', async () => {
  const createdNames: string[] = [];
  const sessions = port([
    session('login', {
      projectName: 'maka-workhub-session-router',
      sessionName: '登录刷新令牌',
    }),
  ]);
  sessions.routingEvidence = async () => [{
    target: { sessionId: 'login' },
    originPrompt: '排查刷新令牌过期导致的重复登录',
  }];
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('layout-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-layout-new' });
  const controller = createWorkHubController({ sessions });
  const text = '优化 WorkHub 在移动端窄屏下的消息布局，先给设计建议，不修改文件。';

  const result = await controller.submit({ requestId: 'request-layout-new', text });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'layout-new',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(createdNames, ['优化 WorkHub 在移动端窄屏下的消息布局']);
});

test('submit follows an unambiguous reference to the most recent Work', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌' }),
    session('payment', { sessionName: '支付回调幂等性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-focus',
    text: '先处理支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const result = await controller.submit({
    requestId: 'request-pronoun',
    text: '继续它',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-pronoun',
    target: { sessionId: 'payment' },
    turnId: 'turn-2',
    evidence: 'recent_focus',
  });
  assert.deepEqual(submitted, ['payment', 'payment']);
});

test('read seeds current and previous focus from pre-existing ordinary Sessions', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌', updatedAt: 20 }),
    session('payment', { sessionName: '支付回调幂等性', updatedAt: 30 }),
    session('archived', { archived: true, updatedAt: 40 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });

  await controller.read();
  const current = await controller.submit({
    requestId: 'request-current-seed',
    text: '继续这个工作',
  });
  const previous = await controller.submit({
    requestId: 'request-previous-seed',
    text: '回到上一个工作',
  });

  assert.deepEqual(current.kind === 'submitted' ? current.target : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(previous.kind === 'submitted' ? previous.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['payment', 'login']);
});

test('read prefers the Session active when WorkHub opens over raw recency', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌', updatedAt: 20 }),
    session('payment', { sessionName: '支付回调幂等性', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-login' };
  };
  const controller = createWorkHubController({ sessions });

  await controller.read({ focus: { sessionId: 'login' } });
  const result = await controller.submit({
    requestId: 'request-active-seed',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('a stale opening read cannot overwrite a newer WorkHub focus', async () => {
  const pendingReads: Array<{
    resolve(value: WorkHubSessionFacts[]): void;
    promise: Promise<WorkHubSessionFacts[]>;
  }> = [];
  const sessions = port([]);
  sessions.list = () => {
    let resolve!: (value: WorkHubSessionFacts[]) => void;
    const promise = new Promise<WorkHubSessionFacts[]>((next) => {
      resolve = next;
    });
    pendingReads.push({ resolve, promise });
    return promise;
  };
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-newer-focus' };
  };
  const controller = createWorkHubController({ sessions });
  const older = controller.read({ focus: { sessionId: 'payment' } });
  const newer = controller.read({ focus: { sessionId: 'login' } });
  const facts = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];

  pendingReads[1]!.resolve(facts);
  await newer;
  pendingReads[0]!.resolve([facts[1]!]);
  await older;
  sessions.list = async () => facts;
  const result = await controller.submit({
    requestId: 'request-after-stale-read',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('an unavailable opening focus falls back to recent routable Sessions', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('archived', { archived: true, updatedAt: 40 }),
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-fallback' };
  };
  const controller = createWorkHubController({ sessions });

  await controller.read({ focus: { sessionId: 'archived' } });
  const result = await controller.submit({
    requestId: 'request-fallback-focus',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(submitted, ['payment']);
});

test('focus falls back when the current Session is archived after WorkHub opens', async () => {
  let catalog = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];
  const sessions = port(catalog);
  sessions.list = async () => catalog;
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-focus-fallback' };
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  catalog = catalog.map((entry) => entry.target.sessionId === 'payment'
    ? { ...entry, archived: true }
    : entry);

  const result = await controller.submit({
    requestId: 'request-after-current-archive',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('resetVisitContext discards focus from a previous WorkHub mount', async () => {
  let catalog = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];
  const sessions = port(catalog);
  sessions.list = async () => catalog;
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.read({ focus: { sessionId: 'login' } });
  controller.resetVisitContext();
  catalog = catalog.map((entry) => entry.target.sessionId === 'payment'
    ? { ...entry, updatedAt: 40 }
    : entry);
  await controller.read();

  const result = await controller.submit({
    requestId: 'request-after-remount',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
});

test('an in-flight submit cannot restore visit focus after WorkHub unmounts', async () => {
  const sessions = port([
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ]);
  let signalSubmitStarted!: () => void;
  const submitStarted = new Promise<void>((resolve) => {
    signalSubmitStarted = resolve;
  });
  let finishSubmit!: (value: { turnId: string }) => void;
  const pendingTurn = new Promise<{ turnId: string }>((resolve) => {
    finishSubmit = resolve;
  });
  sessions.submit = async () => {
    signalSubmitStarted();
    return pendingTurn;
  };
  const controller = createWorkHubController({ sessions });
  await controller.read({ focus: { sessionId: 'login' } });
  const inFlight = controller.submit({
    requestId: 'request-before-unmount',
    text: '继续这个工作',
  });
  await submitStarted;
  controller.resetVisitContext();
  finishSubmit({ turnId: 'turn-login' });
  await inFlight;

  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-after-remount' };
  };
  await controller.read();
  const result = await controller.submit({
    requestId: 'request-after-in-flight',
    text: '继续这个工作',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(submitted, ['payment']);
});

test('an old submit resolves against the visit focus captured before an await', async () => {
  const catalog = [
    session('login', { updatedAt: 20 }),
    session('payment', { updatedAt: 30 }),
  ];
  const sessions = port(catalog);
  const controller = createWorkHubController({ sessions });
  await controller.read({ focus: { sessionId: 'login' } });

  let signalListStarted!: () => void;
  const listStarted = new Promise<void>((resolve) => {
    signalListStarted = resolve;
  });
  let finishOldList!: (value: WorkHubSessionFacts[]) => void;
  const oldList = new Promise<WorkHubSessionFacts[]>((resolve) => {
    finishOldList = resolve;
  });
  let blockNextList = true;
  sessions.list = async () => {
    if (!blockNextList) return catalog;
    blockNextList = false;
    signalListStarted();
    return oldList;
  };
  const submitted: string[] = [];
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-' + target.sessionId };
  };

  const oldSubmission = controller.submit({
    requestId: 'request-old-visit',
    text: '继续这个工作',
  });
  await listStarted;
  controller.resetVisitContext();
  await controller.read({ focus: { sessionId: 'payment' } });
  finishOldList(catalog);

  const result = await oldSubmission;
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(submitted, ['login']);
});

test('submit routes strong core evidence instead of reusing recent focus', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '处理刷新令牌重复登录',
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '处理支付回调重复投递',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-login-focus',
    text: '先看登录',
    explicitTarget: { sessionId: 'login' },
  });

  const result = await controller.submit({
    requestId: 'request-topic-shift',
    text: '继续处理支付回调重复投递',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-topic-shift',
    target: { sessionId: 'payment' },
    turnId: 'turn-2',
    evidence: 'core_entity',
  });
  assert.deepEqual(submitted, ['login', 'payment']);
});

test('submit routes unique strong core evidence without asking', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '处理刷新令牌过期导致的重复登录',
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '处理支付回调重复投递',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-core' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-core',
    text: '刷新令牌过期时，重复登录的观测日志应该记录哪些字段？',
  });

  assert.equal(result.kind, 'submitted');
  if (result.kind !== 'submitted') return;
  assert.deepEqual(result.target, { sessionId: 'login' });
  assert.equal(result.evidence, 'core_entity');
  assert.equal(result.strategyId, 'wh-r2.4-session-context-continuity');
  assert.deepEqual(submitted, ['login']);
});

test('submit ignores shared boilerplate when an executable request names a new topic', async () => {
  const createdNames: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录刷新令牌',
      latestResult: '排查登录刷新令牌，先只分析风险和测试点，不修改文件',
    }),
  ]);
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('payment-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-payment-new' });
  const controller = createWorkHubController({ sessions });
  const text = '请创建新任务，检查支付回调重复投递；先只分析风险和测试点，不修改文件。';

  const result = await controller.submit({ requestId: 'request-new-topic', text });

  assert.equal(result.kind, 'submitted');
  if (result.kind !== 'submitted') return;
  assert.deepEqual(result.target, { sessionId: 'payment-new' });
  assert.equal(result.evidence, 'new_session');
  assert.equal(result.strategyId, 'wh-r2.4-session-context-continuity');
  assert.deepEqual(createdNames, ['检查支付回调重复投递']);
});

test('submit keeps a foreign two-character clue behind clarification', async () => {
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 10 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 20 }),
  ]);
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-weak',
    text: '继续登录',
  });

  assert.equal(result.kind, 'clarification');
  assert.equal(result.strategyId, 'wh-r2.4-session-context-continuity');
});

test('submit treats explicit user uncertainty as clarification instead of a new Session', async () => {
  const created: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('unexpected');
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-uncertain',
    text: '继续处理稳定性问题，但我不确定具体是哪一个。',
  });

  assert.equal(result.kind, 'clarification');
  assert.deepEqual(result.kind === 'clarification'
    ? result.options.map((option) => option.target.sessionId)
    : [], ['payment', 'login']);
  assert.deepEqual(created, []);
});

test('English target uncertainty uses clarification as the routing safety valve', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('parser', { sessionName: 'Parser Cleanup', updatedAt: 20 }),
    session('profile', { sessionName: 'Profile Settings', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'unexpected' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-uncertainty',
    text: "I'm not sure which one this belongs to; continue the cleanup.",
  });

  assert.equal(result.kind, 'clarification');
  assert.deepEqual(result.kind === 'clarification'
    ? result.options.map((option) => option.target.sessionId)
    : [], ['parser', 'profile']);
  assert.deepEqual(submitted, []);
});

test('English routing matches whole words instead of substrings in another identity', async () => {
  const submitted: string[] = [];
  const created: string[] = [];
  const sessions = port([
    session('profile', { sessionName: 'Profile Settings' }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-new', { sessionName: name });
  };
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-parser' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-word-boundary',
    text: 'check the file parser',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['check the file parser']);
  assert.deepEqual(submitted, ['parser-new']);
});

test('English core evidence requires a distinctive word or multiple whole-word matches', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('parser', {
      sessionName: 'Parser Cleanup',
      latestResult: 'Tokenizer regression isolated in parser recovery',
    }),
    session('profile', {
      sessionName: 'Profile Settings',
      latestResult: 'Account preferences are ready',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: 'turn-parser' };
  };

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-core-evidence',
    text: 'fix the parser tokenizer crash',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'core_entity');
  assert.deepEqual(submitted, ['parser']);
});

test('route correction stops the wrong Session and teaches a similar request', async () => {
  const submitted: string[] = [];
  const stopped: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性' }),
    session('payment', { sessionName: '支付稳定性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  sessions.stop = async (target) => {
    stopped.push(target.sessionId);
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-focus-payment',
    text: '先看支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const wrong = await controller.submit({
    requestId: 'request-alias',
    text: '继续白鹭点，列出验收项。',
  });
  assert.deepEqual(wrong.kind === 'submitted' ? wrong.target : undefined, {
    sessionId: 'payment',
  });

  const corrected = await controller.submit({
    requestId: 'request-alias',
    text: '继续白鹭点，列出验收项。',
    explicitTarget: { sessionId: 'login' },
    correction: { from: { sessionId: 'payment' }, turnId: 'turn-2' },
  });
  assert.equal(corrected.kind, 'submitted');
  assert.equal(corrected.kind === 'submitted' ? corrected.evidence : undefined, 'route_correction');
  assert.deepEqual(corrected.kind === 'submitted' ? corrected.correctedFrom : undefined, {
    sessionId: 'payment',
  });

  const learned = await controller.submit({
    requestId: 'request-alias-similar',
    text: '继续白鹭点，补充失败判定。',
  });
  assert.deepEqual(learned.kind === 'submitted' ? learned.target : undefined, {
    sessionId: 'login',
  });
  assert.equal(learned.kind === 'submitted' ? learned.evidence : undefined, 'route_correction');
  assert.deepEqual(stopped, ['payment']);
  assert.deepEqual(submitted, ['payment', 'payment', 'login', 'login']);
});

test('route correction never stops a root Turn that WorkHub only steered into', async () => {
  const stopped: string[] = [];
  let submissionCount = 0;
  const sessions = port([
    session('login', { sessionName: '登录稳定性' }),
    session('payment', { sessionName: '支付稳定性', state: 'running' }),
  ]);
  sessions.submit = async () => {
    submissionCount += 1;
    return submissionCount === 1
      ? { turnId: 'turn-existing', steered: true }
      : { turnId: 'turn-login' };
  };
  sessions.stop = async (target) => {
    stopped.push(target.sessionId);
  };
  const controller = createWorkHubController({ sessions });

  const wrong = await controller.submit({
    requestId: 'request-steered',
    text: '继续补充支付验收项',
    explicitTarget: { sessionId: 'payment' },
  });
  assert.equal(wrong.kind === 'submitted' ? wrong.steered : undefined, true);

  const correction = {
    from: { sessionId: 'payment' },
    turnId: 'turn-existing',
    steered: true as const,
  };
  const corrected = await controller.submit({
    requestId: 'request-steered',
    text: '不是支付，应该补充登录验收项',
    explicitTarget: { sessionId: 'login' },
    correction,
  });

  assert.equal(corrected.kind, 'submitted');
  assert.deepEqual(stopped, []);
});

test('first natural-language correction reroutes and stops the wrong WorkHub-owned Turn', async () => {
  const submitted: string[] = [];
  const stopped: Array<[string, string]> = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '刷新令牌过期导致重复登录',
      updatedAt: 20,
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '支付回调重复投递',
      updatedAt: 30,
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  sessions.stop = async (target, turnId) => {
    stopped.push([target.sessionId, turnId]);
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  await controller.submit({
    requestId: 'request-wrong-payment',
    text: '继续这个工作，补充验收项',
  });

  const corrected = await controller.submit({
    requestId: 'request-natural-correction',
    text: '不是这个，换成登录那个，补充刷新令牌失败判定',
  });

  assert.equal(corrected.kind, 'submitted');
  assert.deepEqual(corrected.kind === 'submitted' ? corrected.target : undefined, {
    sessionId: 'login',
  });
  assert.equal(
    corrected.kind === 'submitted' ? corrected.evidence : undefined,
    'route_correction',
  );
  assert.deepEqual(corrected.kind === 'submitted' ? corrected.correctedFrom : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(stopped, [['payment', 'turn-1']]);
  assert.deepEqual(submitted, ['payment', 'login']);
});

test('content-level replacement instructions stay inside the focused Session', async () => {
  const submitted: string[] = [];
  const stopped: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
    session('database', {
      sessionName: '数据库迁移',
      latestResult: 'Postgres schema migration',
      updatedAt: 10,
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  sessions.stop = async (target) => {
    stopped.push(target.sessionId);
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  await controller.submit({
    requestId: 'request-before-content-change',
    text: '继续这个工作',
  });

  const result = await controller.submit({
    requestId: 'request-content-change',
    text: '继续这个工作，Redis 配置不对，改成 Postgres',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'recent_focus');
  assert.deepEqual(stopped, []);
});

test('steering the same WorkHub-owned root preserves ownership for a later correction', async () => {
  const submitted: string[] = [];
  const stopped: Array<[string, string]> = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
  ]);
  let paymentSubmissions = 0;
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    if (target.sessionId === 'payment') {
      paymentSubmissions += 1;
      return paymentSubmissions === 1
        ? { turnId: 'turn-payment-root' }
        : { turnId: 'turn-payment-steering-command', steered: true };
    }
    return { turnId: 'turn-login-' + submitted.length };
  };
  sessions.stop = async (target, turnId) => {
    stopped.push([target.sessionId, turnId]);
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  await controller.submit({
    requestId: 'request-owned-root',
    text: '继续这个工作',
  });
  await controller.submit({
    requestId: 'request-other-owned-root',
    text: '先检查登录稳定性',
    explicitTarget: { sessionId: 'login' },
  });
  await controller.submit({
    requestId: 'request-steer-owned-root',
    text: '继续这个工作，补充测试点',
    explicitTarget: { sessionId: 'payment' },
  });

  const corrected = await controller.submit({
    requestId: 'request-correct-owned-root',
    text: '不是这个工作，换成登录稳定性',
  });

  assert.deepEqual(corrected.kind === 'submitted' ? corrected.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(stopped, [['payment', 'turn-payment-root']]);
});

test('a late root completion cannot overwrite newer ownership after remount', async () => {
  const stopped: Array<[string, string]> = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
  ]);
  let signalOlderStarted!: () => void;
  const olderStarted = new Promise<void>((resolve) => {
    signalOlderStarted = resolve;
  });
  let finishOlder!: (value: { turnId: string }) => void;
  const olderTurn = new Promise<{ turnId: string }>((resolve) => {
    finishOlder = resolve;
  });
  let paymentSubmissions = 0;
  sessions.submit = async (target) => {
    if (target.sessionId === 'payment') {
      paymentSubmissions += 1;
      if (paymentSubmissions === 1) {
        signalOlderStarted();
        return olderTurn;
      }
      return { turnId: 'turn-payment-new' };
    }
    return { turnId: 'turn-login' };
  };
  sessions.stop = async (target, turnId) => {
    stopped.push([target.sessionId, turnId]);
  };
  const controller = createWorkHubController({ sessions });

  const olderSubmission = controller.submit({
    requestId: 'request-payment-old',
    text: '先继续支付稳定性',
    explicitTarget: { sessionId: 'payment' },
  });
  await olderStarted;
  controller.resetVisitContext();
  await controller.submit({
    requestId: 'request-payment-new',
    text: '重新继续支付稳定性',
    explicitTarget: { sessionId: 'payment' },
  });
  finishOlder({ turnId: 'turn-payment-old' });
  await olderSubmission;

  const corrected = await controller.submit({
    requestId: 'request-correct-after-late-root',
    text: '不是这个工作，换成登录稳定性',
  });

  assert.deepEqual(corrected.kind === 'submitted' ? corrected.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(stopped, [['payment', 'turn-payment-new']]);
});

test('a stopped ownership tombstone blocks an older root completion', async () => {
  const stopped: Array<[string, string]> = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
  ]);
  let signalStaleStarted!: () => void;
  const staleStarted = new Promise<void>((resolve) => {
    signalStaleStarted = resolve;
  });
  let finishStale!: (value: { turnId: string }) => void;
  const staleTurn = new Promise<{ turnId: string }>((resolve) => {
    finishStale = resolve;
  });
  let paymentSubmissions = 0;
  sessions.submit = async (target) => {
    if (target.sessionId !== 'payment') return { turnId: 'turn-login' };
    paymentSubmissions += 1;
    if (paymentSubmissions === 1) return { turnId: 'turn-payment-root' };
    signalStaleStarted();
    return staleTurn;
  };
  sessions.stop = async (target, turnId) => {
    stopped.push([target.sessionId, turnId]);
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-payment-owned',
    text: '继续支付稳定性',
    explicitTarget: { sessionId: 'payment' },
  });
  const staleSubmission = controller.submit({
    requestId: 'request-payment-stale',
    text: '再继续支付稳定性',
    explicitTarget: { sessionId: 'payment' },
  });
  await staleStarted;

  await controller.submit({
    requestId: 'request-stop-before-stale-finishes',
    text: '不是这个工作，换成登录稳定性',
  });
  finishStale({ turnId: 'turn-payment-stale' });
  await staleSubmission;
  controller.resetVisitContext();
  await controller.read({ focus: { sessionId: 'payment' } });
  await controller.submit({
    requestId: 'request-correct-after-stale-finishes',
    text: '不是这个工作，换成登录稳定性',
  });

  assert.deepEqual(stopped, [['payment', 'turn-payment-root']]);
});

test('WorkHub-owned root remains stoppable after navigating away and back', async () => {
  const stopped: Array<[string, string]> = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => ({ turnId: 'turn-' + target.sessionId });
  sessions.stop = async (target, turnId) => {
    stopped.push([target.sessionId, turnId]);
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  await controller.submit({
    requestId: 'request-owned-before-navigation',
    text: '继续这个工作',
  });
  controller.resetVisitContext();
  await controller.read({ focus: { sessionId: 'payment' } });

  const corrected = await controller.submit({
    requestId: 'request-correction-after-return',
    text: '不是这个工作，换成登录稳定性',
  });

  assert.deepEqual(corrected.kind === 'submitted' ? corrected.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(stopped, [['payment', 'turn-payment']]);
});

test('natural-language correction never stops a pre-existing focused Session', async () => {
  const stopped: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性', updatedAt: 20 }),
    session('payment', { sessionName: '支付稳定性', state: 'running', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => ({ turnId: `turn-${target.sessionId}` });
  sessions.stop = async (target) => {
    stopped.push(target.sessionId);
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();

  const corrected = await controller.submit({
    requestId: 'request-safe-natural-correction',
    text: '不是这个，用登录那个',
  });

  assert.deepEqual(corrected.kind === 'submitted' ? corrected.target : undefined, {
    sessionId: 'login',
  });
  assert.deepEqual(corrected.kind === 'submitted' ? corrected.correctedFrom : undefined, {
    sessionId: 'payment',
  });
  assert.deepEqual(stopped, []);
});

test('English natural-language correction names the replacement Session', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: 'Login Reliability', updatedAt: 20 }),
    session('payment', { sessionName: 'Payment Webhooks', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();

  const corrected = await controller.submit({
    requestId: 'request-english-natural-correction',
    text: 'Not that work; switch to Login Reliability and add the retry checks',
  });

  assert.deepEqual(corrected.kind === 'submitted' ? corrected.target : undefined, {
    sessionId: 'login',
  });
  assert.equal(
    corrected.kind === 'submitted' ? corrected.evidence : undefined,
    'route_correction',
  );
});

test('ambiguous natural-language correction preserves correction context through clarification', async () => {
  const submitted: string[] = [];
  const stopped: Array<[string, string]> = [];
  const sessions = port([
    session('login-api', { sessionName: '登录 API 稳定性', updatedAt: 20 }),
    session('login-ui', { sessionName: '登录 UI 稳定性', updatedAt: 10 }),
    session('payment', { sessionName: '支付回调幂等性', updatedAt: 30 }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  sessions.stop = async (target, turnId) => {
    stopped.push([target.sessionId, turnId]);
  };
  const controller = createWorkHubController({ sessions });
  await controller.read();
  await controller.submit({
    requestId: 'request-payment-before-clarification',
    text: '继续这个工作',
  });

  const clarification = await controller.submit({
    requestId: 'request-natural-clarification',
    text: '不是这个，换成登录那个',
  });
  assert.equal(clarification.kind, 'clarification');
  if (clarification.kind !== 'clarification') return;
  assert.deepEqual(
    clarification.options.map((option) => option.target.sessionId),
    ['login-api', 'login-ui'],
  );
  assert.deepEqual(clarification.correction, {
    from: { sessionId: 'payment' },
    turnId: 'turn-1',
  });

  const corrected = await controller.submit({
    requestId: clarification.requestId,
    text: clarification.text,
    explicitTarget: { sessionId: 'login-api' },
    correction: clarification.correction,
  });
  assert.equal(corrected.kind, 'submitted');
  assert.deepEqual(stopped, [['payment', 'turn-1']]);
  assert.deepEqual(submitted, ['payment', 'login-api']);
});

test('latest route correction wins for the same expression family', async () => {
  const sessions = port([
    session('login', { sessionName: '登录稳定性' }),
    session('payment', { sessionName: '支付稳定性' }),
  ]);
  sessions.submit = async (_target) => ({ turnId: 'turn' });
  const controller = createWorkHubController({ sessions });

  await controller.submit({
    requestId: 'correction-login',
    text: '继续白鹭点，列出验收项。',
    explicitTarget: { sessionId: 'login' },
    correction: { from: { sessionId: 'payment' }, turnId: 'turn' },
  });
  await controller.submit({
    requestId: 'correction-payment',
    text: '继续白鹭点，列出异常项。',
    explicitTarget: { sessionId: 'payment' },
    correction: { from: { sessionId: 'login' }, turnId: 'turn' },
  });

  const result = await controller.submit({
    requestId: 'correction-latest',
    text: '继续白鹭点，补充回滚条件。',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'route_correction');
});

test('user correction order wins when overlapping submissions finish out of order', async () => {
  const sessions = port([
    session('login', { sessionName: '登录稳定性' }),
    session('payment', { sessionName: '支付稳定性' }),
  ]);
  let signalOlderStarted!: () => void;
  const olderStarted = new Promise<void>((resolve) => {
    signalOlderStarted = resolve;
  });
  let finishOlder!: (value: { turnId: string }) => void;
  const olderTurn = new Promise<{ turnId: string }>((resolve) => {
    finishOlder = resolve;
  });
  sessions.submit = async (target) => {
    if (target.sessionId === 'login') {
      signalOlderStarted();
      return olderTurn;
    }
    return { turnId: 'turn-payment' };
  };
  const controller = createWorkHubController({ sessions });

  const olderCorrection = controller.submit({
    requestId: 'correction-older-login',
    text: '继续白鹭点，列出验收项。',
    explicitTarget: { sessionId: 'login' },
    correction: { from: { sessionId: 'payment' } },
  });
  await olderStarted;
  controller.resetVisitContext();
  await controller.submit({
    requestId: 'correction-newer-payment',
    text: '继续白鹭点，列出异常项。',
    explicitTarget: { sessionId: 'payment' },
    correction: { from: { sessionId: 'login' } },
  });
  finishOlder({ turnId: 'turn-login' });
  await olderCorrection;

  const result = await controller.submit({
    requestId: 'correction-after-overlap',
    text: '继续白鹭点，补充回滚条件。',
  });

  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, {
    sessionId: 'payment',
  });
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'route_correction');
});

test('waiting Session rejects a second root request without calling submit', async () => {
  let submitted = false;
  const sessions = port([
    session('login', {
      sessionName: '排查令牌过期重复登录问题',
      state: 'waiting_for_user',
    }),
  ]);
  sessions.submit = async () => {
    submitted = true;
    return { turnId: 'unexpected' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-waiting',
    text: '排查令牌过期重复登录问题：补充一条等待状态下的新请求。',
  });

  assert.deepEqual(result, {
    kind: 'waiting',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-waiting',
    text: '排查令牌过期重复登录问题：补充一条等待状态下的新请求。',
    target: { sessionId: 'login' },
  });
  assert.equal(submitted, false);
});

test('submit returns to the previous focused Session', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录刷新令牌' }),
    session('payment', { sessionName: '支付回调幂等性' }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-login',
    text: '先看登录',
    explicitTarget: { sessionId: 'login' },
  });
  await controller.submit({
    requestId: 'request-payment',
    text: '再看支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const result = await controller.submit({
    requestId: 'request-previous',
    text: '回到上一个工作',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, { sessionId: 'login' });
  assert.deepEqual(submitted, ['login', 'payment', 'login']);
});

test('submit lets strong foreign core evidence override a vague focus word', async () => {
  const submitted: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: '登录稳定性',
      latestResult: '处理刷新令牌过期导致的重复登录',
    }),
    session('payment', {
      sessionName: '支付稳定性',
      latestResult: '处理支付回调重复投递',
    }),
  ]);
  sessions.submit = async (target) => {
    submitted.push(target.sessionId);
    return { turnId: `turn-${submitted.length}` };
  };
  const controller = createWorkHubController({ sessions });
  await controller.submit({
    requestId: 'request-payment-focus',
    text: '先看支付',
    explicitTarget: { sessionId: 'payment' },
  });

  const result = await controller.submit({
    requestId: 'request-foreign-core',
    text: '继续处理刷新令牌过期',
  });

  assert.equal(result.kind, 'submitted');
  assert.deepEqual(result.kind === 'submitted' ? result.target : undefined, { sessionId: 'login' });
  assert.deepEqual(submitted, ['payment', 'login']);
});

test('submit keeps unmatched non-executable conversation in WorkHub', async () => {
  let created = false;
  const sessions = port([]);
  sessions.create = async () => {
    created = true;
    return session('unexpected');
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-discussion',
    text: '你觉得统一入口最重要的价值是什么？',
  });

  assert.deepEqual(result, {
    kind: 'discussion',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-discussion',
    text: '你觉得统一入口最重要的价值是什么？',
  });
  assert.equal(created, false);
});

test('submit treats a design question containing an action word as discussion', async () => {
  let created = false;
  const sessions = port([]);
  sessions.create = async () => {
    created = true;
    return session('unexpected');
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-design-question',
    text: '我们应该怎么实现统一入口？',
  });

  assert.equal(result.kind, 'discussion');
  assert.equal(created, false);
});

test('an executable English request may contain what without becoming discussion', async () => {
  const created: string[] = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-fix', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-parser-fix' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-what-object',
    text: 'fix what is broken in the parser',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['fix what is broken in the parser']);
});

test('submit creates an ordinary Session for a clear unmatched executable goal', async () => {
  const createdNames: string[] = [];
  const submitted: Array<{ sessionId: string; text: string }> = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    createdNames.push(name);
    return session('invoice-export', { sessionName: name });
  };
  sessions.submit = async (target, text) => {
    submitted.push({ sessionId: target.sessionId, text });
    return { turnId: 'turn-invoice-export' };
  };
  const controller = createWorkHubController({ sessions });

  const result = await controller.submit({
    requestId: 'request-new-work',
    text: '实现导出发票 PDF 功能',
  });

  assert.deepEqual(result, {
    kind: 'submitted',
    strategyId: WORKHUB_ROUTING_STRATEGY_ID,
    requestId: 'request-new-work',
    target: { sessionId: 'invoice-export' },
    turnId: 'turn-invoice-export',
    evidence: 'new_session',
  });
  assert.deepEqual(createdNames, ['实现导出发票 PDF 功能']);
  assert.deepEqual(submitted, [
    { sessionId: 'invoice-export', text: '实现导出发票 PDF 功能' },
  ]);
});

test('explicit new-Session intent outranks generic evidence from existing work', async () => {
  const created: string[] = [];
  const sessions = port([
    session('login', { sessionName: '登录稳定性测试计划' }),
    session('payment', { sessionName: '支付回调测试计划' }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('new-session', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-new-session' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'request-explicit-new',
    text: '创建一个全新的普通 Session，标题为 R2.3 新建工作验收，只记录测试计划。',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['R2.3 新建工作验收']);
});

test('English explicit creation extracts the requested Session name', async () => {
  const created: string[] = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('parser-cleanup', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-parser-cleanup' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-explicit-new',
    text: 'Create a new session called Parser Cleanup.',
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['Parser Cleanup']);
});

test('English routing boilerplate does not make an old analysis look related', async () => {
  const created: string[] = [];
  const sessions = port([
    session('login', {
      sessionName: 'Login Refresh Token',
      latestResult: 'Just analyze the risks and test cases; do not modify any files.',
    }),
  ]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('payment-new', { sessionName: name });
  };
  sessions.submit = async () => ({ turnId: 'turn-payment-new' });

  const result = await createWorkHubController({ sessions }).submit({
    requestId: 'english-boilerplate',
    text: "Check payment callback duplicate delivery; just analyze the risks and test cases; don't modify any files.",
  });

  assert.equal(result.kind, 'submitted');
  assert.equal(result.kind === 'submitted' ? result.evidence : undefined, 'new_session');
  assert.deepEqual(created, ['Check payment callback duplicate delivery']);
});

test('negated and deliberative creation language never creates a Session', async () => {
  const created: string[] = [];
  const sessions = port([]);
  sessions.create = async ({ name }) => {
    created.push(name);
    return session('unexpected', { sessionName: name });
  };
  const controller = createWorkHubController({ sessions });

  const negated = await controller.submit({
    requestId: 'negated-create',
    text: '不要创建一个新任务，我们先讨论这个方向。',
  });
  const deliberative = await controller.submit({
    requestId: 'question-create',
    text: '是否应该新建一个任务？',
  });

  assert.equal(negated.kind, 'discussion');
  assert.equal(deliberative.kind, 'discussion');
  assert.deepEqual(created, []);
});

test('subscribe exposes Session invalidations without inventing WorkHub state', () => {
  let listener: (() => void) | undefined;
  let unsubscribed = false;
  const sessions = port([]);
  sessions.subscribe = (handler) => {
    listener = handler;
    return () => {
      unsubscribed = true;
    };
  };
  const controller = createWorkHubController({ sessions });
  let invalidations = 0;

  const unsubscribe = controller.subscribe(() => {
    invalidations += 1;
  });
  listener?.();
  unsubscribe();

  assert.equal(invalidations, 1);
  assert.equal(unsubscribed, true);
});
