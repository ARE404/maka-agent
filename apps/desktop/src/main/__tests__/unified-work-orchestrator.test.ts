import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { PermissionMode } from '@maka/core/permission';
import type { SandboxBoundaryResponse, UserQuestionResponse } from '@maka/core';
import type { UnifiedWorkspaceSummary, WorkRef } from '@maka/core/unified-session';
import { createUnifiedProjectionStore } from '../unified-session/projection-store.js';
import {
  createWorkOrchestrator,
  type UnifiedIntentResolver,
  type UnifiedTargetEvent,
  type WorkCandidate,
  type WorkspaceHostDirectory,
  type WorkspaceHostPort,
} from '../unified-session/work-orchestrator.js';
import { createBoundedModelIntentResolver } from '../unified-session/model-intent-resolver.js';
import { createUnifiedWorkspaceRegistry } from '../unified-session/workspace-registry.js';
import type { DecisionTrace } from '../unified-session/decision/decision-types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'maka-unified-test-'));
  temporaryRoots.push(path);
  return path;
}

describe('Unified Workspace registry', () => {
  test('persists stable identities and reports path availability', async () => {
    const root = await temporaryRoot();
    const workspacePath = join(root, 'workspace-a');
    await mkdir(workspacePath);
    let timestamp = 10;
    const registry = createUnifiedWorkspaceRegistry(root, {
      now: () => timestamp++,
      createId: () => 'workspace-id',
    });

    const first = await registry.ensure(workspacePath, 'Alpha');
    const second = await registry.ensure(workspacePath);

    assert.equal(first.id, 'workspace-id');
    assert.equal(second.id, first.id);
    assert.equal(second.available, true);
    assert.equal(second.incognitoActive, true, 'registry must fail closed until host privacy is read');
    const persisted = JSON.parse(
      await readFile(join(root, 'unified-session', 'workspaces.json'), 'utf8'),
    ) as { workspaces: unknown[] };
    assert.equal(persisted.workspaces.length, 1);
  });

  test('keeps a Project Workspace identity when its registered path changes', async () => {
    const root = await temporaryRoot();
    const firstPath = join(root, 'before');
    const relocatedPath = join(root, 'after');
    await Promise.all([mkdir(firstPath), mkdir(relocatedPath)]);
    let created = 0;
    const registry = createUnifiedWorkspaceRegistry(root, {
      createId: () => `workspace-${++created}`,
    });

    const first = await registry.ensure(firstPath, 'Alpha', 'project:alpha');
    const relocated = await registry.ensure(relocatedPath, 'Alpha moved', 'project:alpha');

    assert.equal(relocated.id, first.id);
    assert.equal(relocated.path, relocatedPath);
    assert.equal(relocated.name, 'Alpha moved');
    assert.equal((await registry.list()).length, 1);
  });
});

describe('Work Orchestrator', () => {
  test('separates routing completion from a still-generating Discussion reply', async () => {
    let release!: (answer: string) => void;
    const answer = new Promise<string>((resolve) => { release = resolve; });
    const fixture = await createFixture([host('ws-a', 'maka-agent')], {
      answerDiscussion: () => answer,
    });

    const result = await fixture.orchestrator.send({ text: '我们先讨论目标识别边界' });

    assert.equal(result.kind, 'discussion');
    let snapshot = await fixture.orchestrator.snapshot();
    const pending = snapshot.items.at(-1);
    assert.equal(pending?.kind === 'discussion' ? pending.status : undefined, 'running');
    release('建议优先避免错误绑定。');
    await waitForAsync(async () => {
      const item = (await fixture.orchestrator.snapshot()).items.at(-1);
      return item?.kind === 'discussion' && item.status === 'completed';
    });
    snapshot = await fixture.orchestrator.snapshot();
    const completed = snapshot.items.at(-1);
    assert.equal(completed?.kind === 'discussion' ? completed.text : undefined, '建议优先避免错误绑定。');
  });

  test('recovers an interrupted persisted Discussion reply without duplicating its bubble', async () => {
    const fixture = await createFixture([host('ws-a', 'maka-agent')]);
    await fixture.projections.append({
      id: 'discussion-user', kind: 'discussion', role: 'user', text: '继续讨论',
      status: 'completed', createdAt: 1,
    });
    await fixture.projections.append({
      id: 'discussion-assistant', kind: 'discussion', role: 'assistant', text: '',
      status: 'running', replyToMessageId: 'discussion-user', createdAt: 2,
    });
    const recovered = createWorkOrchestrator({
      projections: fixture.projections,
      hosts: fixture.directory,
      defaultPermissionMode: async () => 'ask',
      answerDiscussion: async () => '恢复后的回答',
      createId: () => 'unused',
    });

    await recovered.recover();
    await waitForAsync(async () => {
      const item = (await recovered.snapshot()).items.at(-1);
      return item?.kind === 'discussion' && item.status === 'completed';
    });
    const snapshot = await recovered.snapshot();
    assert.equal(snapshot.items.length, 2);
    const recoveredReply = snapshot.items.at(-1);
    assert.equal(recoveredReply?.kind === 'discussion' ? recoveredReply.text : '', '恢复后的回答');
  });

  test('keeps ambiguous discussion in Unified without creating a Work', async () => {
    const fixture = await createFixture([host('ws-a', 'maka-agent')]);

    const result = await fixture.orchestrator.send({ text: '登录超时可能有问题' });

    assert.equal(result.kind, 'discussion');
    assert.equal(fixture.hosts[0]!.created.length, 0);
    const snapshot = await fixture.orchestrator.snapshot();
    assert.deepEqual(snapshot.items.map((item) => item.kind), ['discussion', 'discussion']);
  });

  test('emits a structured Decision Trace for every routed input', async () => {
    const traces: DecisionTrace[] = [];
    const fixture = await createFixture([host('ws-a', 'maka-agent')], {
      onDecisionTrace: (trace) => traces.push(trace),
    });

    await fixture.orchestrator.send({ text: '登录超时可能有问题' });
    await waitForAsync(async () => {
      const item = (await fixture.orchestrator.snapshot()).items.at(-1);
      return item?.kind === 'discussion' && item.status === 'completed';
    });

    assert.deepEqual(traces, [{
      policyVersion: 'workhub-decision-v1',
      intent: 'discussion_candidate',
      recalledCandidateIds: [],
      proposedAction: 'discussion',
      gateDecision: 'block',
      evidence: [
        'no deterministic execution signal',
        '未发现明确执行意图',
        'proposal does not authorize execution',
      ],
    }]);
  });

  test('does not create or start a Work when Action Gate rejects an invented target', async () => {
    const target = host('ws-a', 'maka-agent');
    const traces: DecisionTrace[] = [];
    const resolver: UnifiedIntentResolver = async () => ({
      kind: 'resume_work',
      work: { workspaceId: 'ws-a', sessionId: 'invented-session' },
    });
    const fixture = await createFixture([target], {
      resolveIntent: resolver,
      onDecisionTrace: (trace) => traces.push(trace),
    });

    const result = await fixture.orchestrator.send({ text: '继续修改登录问题' });

    assert.equal(result.kind, 'register_workspace');
    assert.deepEqual(target.created, []);
    assert.deepEqual(target.started, []);
    assert.equal(traces[0]?.gateDecision, 'block');
    assert.match(traces[0]?.evidence.at(-1) ?? '', /target Work/u);
  });

  test('carries a bounded Discussion background into the target Work with provenance', async () => {
    const target = host('ws-a', 'maka-agent');
    const fixture = await createFixture([target]);
    await fixture.orchestrator.send({ text: '登录超时可能有问题' });

    const result = await fixture.orchestrator.send({ text: '在 maka-agent 按这个方案修掉' });

    assert.equal(result.kind, 'work');
    if (result.kind !== 'work') assert.fail('missing Work');
    assert.equal(result.block.prompt, '在 maka-agent 按这个方案修掉');
    assert.ok(result.block.background);
    assert.equal(result.block.background.sourceDiscussionMessageIds.length, 2);
    await waitFor(() => target.started.length === 1);
    assert.match(target.started[0]?.text ?? '', /工作背景（来自 Unified Discussion）/u);
    assert.match(target.started[0]?.text ?? '', /当前指令：在 maka-agent 按这个方案修掉/u);
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('creates a normal target Work and updates its independent block', async () => {
    const target = host('ws-a', 'maka-agent');
    const fixture = await createFixture([target]);
    const ended: Array<{ status: string; sessionId: string }> = [];
    fixture.orchestrator.subscribeWorkEnded((event) => {
      ended.push({ status: event.status, sessionId: event.work.sessionId });
    });

    const result = await fixture.orchestrator.send({ text: '检查登录超时并修掉' });

    assert.equal(result.kind, 'work');
    assert.equal(target.created.length, 1);
    const snapshot = await waitForTerminal(fixture.orchestrator.snapshot);
    const block = snapshot.items.find((item) => item.kind === 'work');
    assert.equal(block?.kind, 'work');
    if (block?.kind !== 'work') assert.fail('missing Work block');
    assert.equal(block.block.workspaceName, 'maka-agent');
    assert.equal(block.block.status, 'completed');
    assert.equal(block.block.turnId, 'turn-1');
    assert.deepEqual(ended, [{ status: 'completed', sessionId: block.block.work.sessionId }]);
  });

  test('clarifies executable intent when multiple Workspaces are equally plausible', async () => {
    const fixture = await createFixture([
      host('ws-a', 'maka-agent'),
      host('ws-b', 'website'),
    ]);

    const result = await fixture.orchestrator.send({ text: '把登录超时修掉' });

    assert.equal(result.kind, 'clarify');
    assert.equal(fixture.hosts.every((item) => item.created.length === 0), true);
  });

  test('excludes incognito Workspaces from candidate recall and creation', async () => {
    const privateHost = host('ws-private', 'private', { incognitoActive: true });
    const publicHost = host('ws-public', 'public');
    const fixture = await createFixture([privateHost, publicHost]);

    const result = await fixture.orchestrator.send({ text: '在 public 实现登录修复' });

    assert.equal(result.kind, 'work');
    assert.equal(privateHost.listCalls, 0);
    assert.equal(publicHost.created.length, 1);
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('hard-bound replies restore archived Work and never reroute by text', async () => {
    const target = host('ws-a', 'maka-agent');
    const archived: WorkCandidate = {
      work: { workspaceId: 'ws-a', sessionId: 'archived-session' },
      workspaceName: 'maka-agent',
      workName: '登录修复',
      searchableText: '登录修复 refresh token',
      permissionMode: 'ask',
      archived: true,
      updatedAt: 100,
    };
    target.candidates.push(archived);
    const fixture = await createFixture([target]);

    const result = await fixture.orchestrator.send({
      text: '继续把测试补完',
      explicitWork: archived.work,
    });

    assert.equal(result.kind, 'work');
    assert.deepEqual(target.restored, [archived.work]);
    assert.deepEqual(target.started.map((entry) => entry.work), [archived.work]);
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('resolves a Chinese paraphrase to an existing bounded Work candidate', async () => {
    const target = host('ws-a', 'maka-agent');
    const existing: WorkCandidate = {
      work: { workspaceId: 'ws-a', sessionId: 'login-timeout' },
      workspaceName: 'maka-agent',
      workName: '登录超时修复',
      searchableText: '登录超时修复 刷新令牌 测试',
      permissionMode: 'ask',
      archived: false,
      updatedAt: 100,
    };
    target.candidates.push(existing);
    const fixture = await createFixture([target]);

    const result = await fixture.orchestrator.send({ text: '继续补完登录超时测试' });

    assert.equal(result.kind, 'work');
    assert.deepEqual(target.created, []);
    assert.deepEqual(target.started.map((entry) => entry.work), [existing.work]);
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('clarifies a near-tie instead of silently creating a duplicate Work', async () => {
    const target = host('ws-a', 'maka-agent');
    target.candidates.push(
      {
        work: { workspaceId: 'ws-a', sessionId: 'login-a' }, workspaceName: 'maka-agent',
        workName: '登录问题 A', searchableText: '登录问题', permissionMode: 'ask',
        archived: false, updatedAt: 2,
      },
      {
        work: { workspaceId: 'ws-a', sessionId: 'login-b' }, workspaceName: 'maka-agent',
        workName: '登录问题 B', searchableText: '登录问题', permissionMode: 'ask',
        archived: false, updatedAt: 1,
      },
    );
    const fixture = await createFixture([target]);

    const result = await fixture.orchestrator.send({ text: '继续修改登录问题' });

    assert.equal(result.kind, 'clarify');
    assert.equal(target.created.length, 0);
  });

  test('resolves a clarification card to an explicitly selected Project', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);
    const clarification = await fixture.orchestrator.send({ text: '修改登录超时' });
    assert.equal(clarification.kind, 'clarify');
    if (clarification.kind !== 'clarify') assert.fail('expected clarification');

    const result = await fixture.orchestrator.send({
      text: '修改登录超时',
      explicitWorkspaceId: 'ws-b',
      sourceClarificationMessageId: clarification.messageId,
    });

    assert.equal(result.kind, 'work');
    assert.equal(first.created.length, 0);
    assert.equal(second.created.length, 1);
    const source = (await fixture.orchestrator.snapshot()).items.find(
      (item) => item.id === clarification.messageId,
    );
    assert.equal(
      source?.kind === 'discussion' && source.action?.kind === 'clarify'
        ? source.action.resolved
        : false,
      true,
    );
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('stops a running Work and offers bounded alternatives when changing target', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);
    await fixture.projections.append({
      id: 'running-block', kind: 'work', block: {
        id: 'running-block', work: { workspaceId: 'ws-a', sessionId: 'running-session' },
        workspaceName: 'Alpha', workName: '旧目标', prompt: '修改目标', permissionMode: 'ask',
        status: 'running', createdAt: 1, updatedAt: 1,
      },
    });

    const prompt = await fixture.orchestrator.requestRetarget('running-block');

    assert.deepEqual(first.stopped, [{ workspaceId: 'ws-a', sessionId: 'running-session' }]);
    assert.equal(prompt.action?.kind, 'clarify');
    assert.equal(prompt.action?.kind === 'clarify' ? prompt.action.options.length > 0 : false, true);
    const block = (await fixture.orchestrator.snapshot()).items.find((item) => item.id === 'running-block');
    assert.equal(block?.kind === 'work' ? block.block.status : undefined, 'stopped');
  });

  test('accepts only opaque candidate ids returned by the bounded model router', async () => {
    const alpha = host('ws-a', 'Alpha');
    const beta = host('ws-b', 'Beta');
    alpha.candidates.push({
      work: { workspaceId: 'ws-a', sessionId: 'alpha-work' }, workspaceName: 'Alpha',
      workName: '登录修复', searchableText: '登录修复', permissionMode: 'ask', archived: false,
      updatedAt: 1,
    });
    const resolver = createBoundedModelIntentResolver(async () => ({
      intent: 'resume_work', targetId: 'work-0', confidence: 0.94, evidence: ['语义目标一致'],
    }));
    const fixture = await createFixture([alpha, beta], { resolveIntent: resolver });

    const result = await fixture.orchestrator.send({ text: '修改登录问题' });

    assert.equal(result.kind, 'work');
    assert.deepEqual(alpha.started.map((entry) => entry.work), [alpha.candidates[0]?.work]);
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('rejects an invented model target and keeps an ambiguous turn in clarification', async () => {
    const alpha = host('ws-a', 'Alpha');
    const beta = host('ws-b', 'Beta');
    for (const [target, workspaceId, workspaceName, sessionId] of [
      [alpha, 'ws-a', 'Alpha', 'alpha-work'],
      [beta, 'ws-b', 'Beta', 'beta-work'],
    ] as const) {
      target.candidates.push({
        work: { workspaceId, sessionId },
        workspaceName,
        workName: '登录问题', searchableText: '登录问题', permissionMode: 'ask', archived: false,
        updatedAt: 1,
      });
    }
    const resolver = createBoundedModelIntentResolver(async () => ({
      intent: 'resume_work', targetId: 'work-invented', confidence: 0.97, evidence: ['invalid'],
    }));
    const fixture = await createFixture([alpha, beta], { resolveIntent: resolver });

    const result = await fixture.orchestrator.send({ text: '处理登录问题' });

    assert.equal(result.kind, 'clarify');
    assert.equal(alpha.started.length + beta.started.length, 0);
  });

  test('degrades a low-confidence model binding to clarification', async () => {
    const alpha = host('ws-a', 'Alpha');
    alpha.candidates.push({
      work: { workspaceId: 'ws-a', sessionId: 'alpha-work' }, workspaceName: 'Alpha',
      workName: '登录修复', searchableText: '登录修复', permissionMode: 'ask', archived: false,
      updatedAt: 1,
    });
    const resolver = createBoundedModelIntentResolver(async () => ({
      intent: 'resume_work', targetId: 'work-0', confidence: 0.71, evidence: ['weak match'],
    }));
    const fixture = await createFixture([alpha], { resolveIntent: resolver });

    const result = await fixture.orchestrator.send({ text: '帮我看看那个问题' });

    assert.equal(result.kind, 'clarify');
    assert.equal(alpha.started.length, 0);
  });

  test('does not consult the model when the user explicitly binds a Work', async () => {
    const alpha = host('ws-a', 'Alpha');
    alpha.candidates.push({
      work: { workspaceId: 'ws-a', sessionId: 'alpha-work' }, workspaceName: 'Alpha',
      workName: '登录修复', searchableText: '登录修复', permissionMode: 'ask', archived: false,
      updatedAt: 1,
    });
    let classifyCalls = 0;
    const resolver = createBoundedModelIntentResolver(async () => {
      classifyCalls += 1;
      return { intent: 'discussion', targetId: null, confidence: 1, evidence: [] };
    });
    const fixture = await createFixture([alpha], { resolveIntent: resolver });

    const result = await fixture.orchestrator.send({
      text: '继续', explicitWork: { workspaceId: 'ws-a', sessionId: 'alpha-work' },
    });

    assert.equal(result.kind, 'work');
    assert.equal(classifyCalls, 0);
    await waitForTerminal(fixture.orchestrator.snapshot);
  });

  test('passes bounded semantic cards to the model without exposing Session ids', async () => {
    const alpha = host('ws-a', 'Alpha');
    alpha.candidates.push({
      work: { workspaceId: 'ws-a', sessionId: 'secret-session-id' }, workspaceName: 'Alpha',
      workName: '登录修复', searchableText: '登录修复', permissionMode: 'ask', archived: false,
      updatedAt: 1,
      semanticCard: { objective: '修复登录超时', recentOutcome: '已定位 token 续期', terms: ['登录'] },
    });
    let captured: Parameters<Parameters<typeof createBoundedModelIntentResolver>[0]>[0] | undefined;
    const resolver = createBoundedModelIntentResolver(async (request) => {
      captured = request;
      return { intent: 'discussion', targetId: null, confidence: 0.9, evidence: [] };
    });
    const fixture = await createFixture([alpha], { resolveIntent: resolver });

    await fixture.orchestrator.send({ text: '我想看看那个事情' });

    assert.equal(captured?.candidates[0]?.id, 'work-0');
    assert.equal(captured?.candidates[0]?.objective, '修复登录超时');
    assert.equal(JSON.stringify(captured).includes('secret-session-id'), false);
    await waitForAsync(async () => {
      const item = (await fixture.orchestrator.snapshot()).items.at(-1);
      return item?.kind === 'discussion' && item.status === 'completed';
    });
  });

  test('purges every projection and focus reference when the target Session is deleted', async () => {
    const fixture = await createFixture([host('ws-a', 'maka-agent')]);
    const result = await fixture.orchestrator.send({ text: '实现登录超时修复' });
    assert.equal(result.kind, 'work');
    if (result.kind !== 'work') assert.fail('missing Work');
    await waitForTerminal(fixture.orchestrator.snapshot);

    await fixture.orchestrator.purgeSession(result.block.work.sessionId);

    const snapshot = await fixture.orchestrator.snapshot();
    assert.equal(snapshot.items.some((item) => item.kind === 'work'), false);
    assert.equal(snapshot.workFocus, undefined);
  });

  test('forwards permission, interaction, and stop commands to the owning Workspace only', async () => {
    const first = host('ws-a', 'maka-agent');
    const second = host('ws-b', 'website');
    const fixture = await createFixture([first, second]);
    const work = { workspaceId: 'ws-b', sessionId: 'session-b' };

    await fixture.orchestrator.setPermissionMode(work, 'bypass');
    await fixture.orchestrator.respondToSandboxBoundary(work, {
      requestId: 'permission-1',
      decision: 'allow',
    });
    await fixture.orchestrator.respondToUserQuestion(work, {
      requestId: 'question-1',
      answers: ['继续'],
    });
    await fixture.orchestrator.stopWork(work);

    assert.deepEqual(first.permissions, []);
    assert.deepEqual(second.permissions, [{ work, mode: 'bypass' }]);
    assert.equal(first.sandboxResponses.length, 0);
    assert.deepEqual(second.sandboxResponses, [{ work, response: {
      requestId: 'permission-1',
      decision: 'allow',
    } }]);
    assert.equal(first.questionResponses.length, 0);
    assert.deepEqual(second.questionResponses, [{ work, response: {
      requestId: 'question-1',
      answers: ['继续'],
    } }]);
    assert.deepEqual(second.stopped, [work]);
  });

  test('previews multi-Workspace scope without creating Work until confirmation', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);

    const result = await fixture.orchestrator.send({
      text: '在 Alpha 实现接口，然后在 Beta 更新调用方',
    });

    assert.equal(result.kind, 'coordination');
    assert.deepEqual(first.created, []);
    assert.deepEqual(second.created, []);
    if (result.kind !== 'coordination') assert.fail('missing coordination plan');
    assert.equal(result.plan.status, 'awaiting_confirmation');
    assert.deepEqual(result.plan.steps[1]?.dependsOn, [result.plan.steps[0]?.id]);

    await fixture.orchestrator.confirmCoordination(result.plan.id);
    const plan = await waitForCoordinationTerminal(
      fixture.orchestrator.snapshot,
      result.plan.id,
    );
    assert.equal(plan.status, 'completed');
    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 1);
  });

  test('runs independent coordination steps concurrently', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    first.startTurn = async (work, text, onEvent) => {
      first.started.push({ work, text });
      emit(onEvent, { kind: 'started', turnId: 'turn-a' });
      await firstGate;
      emit(onEvent, { kind: 'completed' });
      return { turnId: 'turn-a' };
    };

    const result = await fixture.orchestrator.send({
      text: '在 Alpha 实现接口，在 Beta 更新文档',
    });
    assert.equal(result.kind, 'coordination');
    if (result.kind !== 'coordination') assert.fail('missing coordination plan');
    assert.deepEqual(result.plan.steps.map((step) => step.dependsOn), [[], []]);
    await fixture.orchestrator.confirmCoordination(result.plan.id);

    await waitFor(() => second.started.length === 1);
    assert.equal(first.started.length, 1, 'first step should still be in flight');
    releaseFirst();
    const plan = await waitForCoordinationTerminal(
      fixture.orchestrator.snapshot,
      result.plan.id,
    );
    assert.equal(plan.status, 'completed');
  });

  test('reuses bounded existing Work targets in a cross-Workspace scope', async () => {
    const first = host('ws-a', 'api-workspace');
    const second = host('ws-b', 'web-workspace');
    const apiWork: WorkCandidate = {
      work: { workspaceId: 'ws-a', sessionId: 'api-session' },
      workspaceName: 'api-workspace', workName: '后端用户接口',
      searchableText: '后端用户接口 返回字段 契约测试', permissionMode: 'ask',
      archived: false, updatedAt: 10,
    };
    const webWork: WorkCandidate = {
      work: { workspaceId: 'ws-b', sessionId: 'web-session' },
      workspaceName: 'web-workspace', workName: '前端登录调用',
      searchableText: '前端登录调用 用户接口', permissionMode: 'ask',
      archived: false, updatedAt: 10,
    };
    first.candidates.push(apiWork);
    second.candidates.push(webWork);
    const fixture = await createFixture([first, second]);

    const result = await fixture.orchestrator.send({
      text: '后端用户接口修改返回字段，然后前端登录调用更新',
    });

    assert.equal(result.kind, 'coordination');
    if (result.kind !== 'coordination') assert.fail('missing coordination plan');
    assert.deepEqual(result.plan.steps.map((step) => step.targetWork), [apiWork.work, webWork.work]);
    await fixture.orchestrator.confirmCoordination(result.plan.id);
    const plan = await waitForCoordinationTerminal(fixture.orchestrator.snapshot, result.plan.id);
    assert.equal(plan.status, 'completed');
    assert.deepEqual(first.created, []);
    assert.deepEqual(second.created, []);
    assert.deepEqual(first.started.map((entry) => entry.work), [apiWork.work]);
    assert.deepEqual(second.started.map((entry) => entry.work), [webWork.work]);
  });

  test('blocks dependent coordination work when its prerequisite fails', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    first.startTurn = async (work, text, onEvent) => {
      first.started.push({ work, text });
      emit(onEvent, { kind: 'started', turnId: 'turn-a' });
      emit(onEvent, { kind: 'failed', detail: 'compile failed' });
      return { turnId: 'turn-a' };
    };
    const fixture = await createFixture([first, second]);

    const result = await fixture.orchestrator.send({
      text: '在 Alpha 修改接口，然后在 Beta 更新调用方',
    });
    assert.equal(result.kind, 'coordination');
    if (result.kind !== 'coordination') assert.fail('missing coordination plan');
    await fixture.orchestrator.confirmCoordination(result.plan.id);
    const plan = await waitForCoordinationTerminal(
      fixture.orchestrator.snapshot,
      result.plan.id,
    );

    assert.equal(plan.status, 'failed');
    assert.deepEqual(plan.steps.map((step) => step.status), ['failed', 'blocked']);
    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0, 'blocked dependent Work must never be created');
  });

  test('cancels a scope preview without creating any target Work', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);
    const result = await fixture.orchestrator.send({
      text: '在 Alpha 实现接口，在 Beta 更新文档',
    });
    assert.equal(result.kind, 'coordination');
    if (result.kind !== 'coordination') assert.fail('missing coordination plan');

    const cancelled = await fixture.orchestrator.cancelCoordination(result.plan.id);

    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(first.created, []);
    assert.deepEqual(second.created, []);
  });

  test('offers registration for an explicitly named unknown Project', async () => {
    const fixture = await createFixture([host('ws-a', 'Alpha')]);

    const result = await fixture.orchestrator.send({
      text: '在 NewPortal 项目实现登录页',
    });

    assert.equal(result.kind, 'register_workspace');
    assert.equal(fixture.hosts[0]!.created.length, 0);
    const snapshot = await fixture.orchestrator.snapshot();
    const response = snapshot.items.at(-1);
    assert.equal(response?.kind, 'discussion');
    if (response?.kind !== 'discussion') assert.fail('missing registration response');
    assert.deepEqual(response.action, { kind: 'register_workspace' });
  });

  test('offers relink instead of duplicate registration for a known unavailable Project', async () => {
    const fixture = await createFixture([
      host('ws-a', 'Alpha', { available: false }),
      host('ws-b', 'Beta'),
    ]);

    const result = await fixture.orchestrator.send({ text: '在 Alpha 项目实现登录页' });

    assert.equal(result.kind, 'register_workspace');
    assert.equal(fixture.hosts.every((candidate) => candidate.created.length === 0), true);
    const response = (await fixture.orchestrator.snapshot()).items.at(-1);
    assert.equal(response?.kind, 'discussion');
    if (response?.kind !== 'discussion') assert.fail('missing relink response');
    assert.deepEqual(response.action, { kind: 'relink_workspace', workspaceId: 'ws-a' });
  });

  test('recovers a persisted graph and unlocks queued successors after restart', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);
    const work = await first.createWork({ title: '接口', permissionMode: 'ask' });
    await fixture.projections.append({
      id: 'block-a',
      kind: 'work',
      block: {
        id: 'block-a', work: work.work, workspaceName: 'Alpha', workName: '接口',
        prompt: '实现接口', permissionMode: 'ask', status: 'running', createdAt: 1,
        updatedAt: 1, turnId: 'turn-before-restart',
      },
    });
    await fixture.projections.append({
      id: 'plan-restart',
      kind: 'coordination',
      plan: {
        id: 'plan-restart', prompt: '先接口再调用方', status: 'running',
        createdAt: 1, updatedAt: 1,
        steps: [
          {
            id: 'step-a', workspaceId: 'ws-a', workspaceName: 'Alpha', title: '接口',
            prompt: '实现接口', dependsOn: [], status: 'running', work: work.work,
            blockId: 'block-a',
          },
          {
            id: 'step-b', workspaceId: 'ws-b', workspaceName: 'Beta', title: '调用方',
            prompt: '更新调用方', dependsOn: ['step-a'], status: 'queued',
          },
        ],
      },
    });
    first.inspectionStatus = 'completed';

    await fixture.orchestrator.recover();
    const plan = await waitForCoordinationTerminal(
      fixture.orchestrator.snapshot,
      'plan-restart',
    );

    assert.equal(plan.status, 'completed');
    assert.deepEqual(plan.steps.map((step) => step.status), ['completed', 'completed']);
    assert.equal(second.created.length, 1);
    const snapshot = await fixture.orchestrator.snapshot();
    const recoveredBlock = snapshot.items.find((item) => item.id === 'block-a');
    assert.equal(recoveredBlock?.kind === 'work' ? recoveredBlock.block.status : undefined, 'completed');
  });

  test('deleting one coordinated Session removes the related graph projection', async () => {
    const first = host('ws-a', 'Alpha');
    const second = host('ws-b', 'Beta');
    const fixture = await createFixture([first, second]);
    const result = await fixture.orchestrator.send({
      text: '在 Alpha 实现接口，然后在 Beta 更新调用方',
    });
    assert.equal(result.kind, 'coordination');
    if (result.kind !== 'coordination') assert.fail('missing coordination plan');
    await fixture.orchestrator.confirmCoordination(result.plan.id);
    const plan = await waitForCoordinationTerminal(fixture.orchestrator.snapshot, result.plan.id);
    const deletedSessionId = plan.steps[0]?.work?.sessionId;
    assert.ok(deletedSessionId);

    await fixture.orchestrator.purgeSession(deletedSessionId);

    const snapshot = await fixture.orchestrator.snapshot();
    assert.equal(
      snapshot.items.some(
        (item) => item.kind === 'coordination' && item.plan.id === result.plan.id,
      ),
      false,
    );
    assert.equal(
      snapshot.items.some(
        (item) => item.kind === 'work' && item.block.work.sessionId === deletedSessionId,
      ),
      false,
    );
  });

  test('projects only low-noise lifecycle events from ordinary target Sessions', async () => {
    const target = host('ws-a', 'Alpha');
    target.candidates.push({
      work: { workspaceId: 'ws-a', sessionId: 'ordinary-session' },
      workspaceName: 'Alpha', workName: 'Focused work', searchableText: 'Focused work',
      permissionMode: 'ask', archived: false, updatedAt: 1,
    });
    const fixture = await createFixture([target]);

    target.inspectionStatus = 'running';
    await fixture.orchestrator.observeSession('ordinary-session');
    target.inspectionStatus = 'waiting_for_user';
    await fixture.orchestrator.observeSession('ordinary-session');
    await fixture.orchestrator.observeSession('ordinary-session');
    target.inspectionStatus = 'running';
    await fixture.orchestrator.observeSession('ordinary-session');
    target.inspectionStatus = 'completed';
    await fixture.orchestrator.observeSession('ordinary-session');

    let snapshot = await fixture.orchestrator.snapshot();
    const events = snapshot.items.filter((item) => item.kind === 'lifecycle');
    assert.deepEqual(events.map((item) => item.status), ['waiting_for_user', 'completed']);
    assert.equal(snapshot.items.some((item) => item.kind === 'work'), false);

    await fixture.orchestrator.purgeSession('ordinary-session');
    snapshot = await fixture.orchestrator.snapshot();
    assert.equal(snapshot.items.some((item) => item.kind === 'lifecycle'), false);
  });

  test('does not project lifecycle events from an incognito Workspace', async () => {
    const target = host('ws-private', 'Private', { incognitoActive: true });
    target.candidates.push({
      work: { workspaceId: 'ws-private', sessionId: 'private-session' },
      workspaceName: 'Private', workName: 'Secret', searchableText: 'Secret',
      permissionMode: 'ask', archived: false, updatedAt: 1,
    });
    const fixture = await createFixture([target]);

    await fixture.orchestrator.observeSession('private-session');

    assert.deepEqual((await fixture.orchestrator.snapshot()).items, []);
  });

  test('asks which Work a short approval targets when multiple interactions are waiting', async () => {
    const fixture = await createFixture([host('ws-a', 'Alpha'), host('ws-b', 'Beta')]);
    for (const [index, workspace] of ['Alpha', 'Beta'].entries()) {
      const id = `waiting-${index}`;
      await fixture.projections.append({
        id,
        kind: 'work',
        block: {
          id,
          work: { workspaceId: index === 0 ? 'ws-a' : 'ws-b', sessionId: `session-${index}` },
          workspaceName: workspace,
          workName: `Decision ${index + 1}`,
          prompt: 'needs input',
          permissionMode: 'ask',
          status: 'waiting_for_user',
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }

    const result = await fixture.orchestrator.send({ text: '可以' });

    assert.equal(result.kind, 'clarify');
    if (result.kind !== 'clarify') assert.fail('expected clarification');
    assert.equal(result.options.length, 2);
    assert.equal(fixture.hosts.every((candidate) => candidate.started.length === 0), true);
    const response = (await fixture.orchestrator.snapshot()).items.at(-1);
    assert.equal(response?.kind === 'discussion' ? /哪一项/u.test(response.text) : false, true);
  });

  test('keeps abort authoritative when a Runtime emits a trailing complete event', async () => {
    const target = host('ws-a', 'Alpha');
    target.startTurn = async (work, text, onEvent) => {
      target.started.push({ work, text });
      emit(onEvent, { kind: 'started', turnId: 'turn-stop' });
      emit(onEvent, { kind: 'stopped' });
      emit(onEvent, { kind: 'completed' });
      return { turnId: 'turn-stop' };
    };
    const fixture = await createFixture([target]);
    const ended: string[] = [];
    fixture.orchestrator.subscribeWorkEnded((event) => ended.push(event.status));

    await fixture.orchestrator.send({ text: '在 Alpha 实现可停止任务' });
    const snapshot = await waitForTerminal(fixture.orchestrator.snapshot);
    const block = snapshot.items.find((item) => item.kind === 'work');

    assert.equal(block?.kind === 'work' ? block.block.status : undefined, 'stopped');
    assert.deepEqual(ended, []);
  });
});

interface FakeHost extends WorkspaceHostPort {
  candidates: WorkCandidate[];
  created: string[];
  restored: WorkRef[];
  started: Array<{ work: WorkRef; text: string }>;
  permissions: Array<{ work: WorkRef; mode: PermissionMode }>;
  sandboxResponses: Array<{ work: WorkRef; response: SandboxBoundaryResponse }>;
  questionResponses: Array<{ work: WorkRef; response: UserQuestionResponse }>;
  stopped: WorkRef[];
  listCalls: number;
  inspectionStatus: 'running' | 'waiting_for_user' | 'blocked' | 'failed' | 'completed' | 'stopped';
}

function host(
  id: string,
  name: string,
  overrides: Partial<UnifiedWorkspaceSummary> = {},
): FakeHost {
  const summary: UnifiedWorkspaceSummary = {
    id,
    name,
    path: `/workspaces/${id}`,
    available: true,
    incognitoActive: false,
    ...overrides,
  };
  const fake: FakeHost = {
    candidates: [],
    created: [],
    restored: [],
    started: [],
    permissions: [],
    sandboxResponses: [],
    questionResponses: [],
    stopped: [],
    listCalls: 0,
    inspectionStatus: 'completed',
    async summary() {
      return summary;
    },
    async listWorkCandidates() {
      fake.listCalls++;
      return fake.candidates;
    },
    async findWork(sessionId) {
      return fake.candidates.find((candidate) => candidate.work.sessionId === sessionId);
    },
    async createWork(input) {
      fake.created.push(input.title);
      const candidate: WorkCandidate = {
        work: { workspaceId: id, sessionId: `session-${fake.created.length}` },
        workspaceName: name,
        workName: input.title,
        searchableText: input.title,
        permissionMode: input.permissionMode,
        archived: false,
        updatedAt: 1,
      };
      fake.candidates.push(candidate);
      return candidate;
    },
    async restoreWork(work) {
      fake.restored.push(work);
    },
    async startTurn(work, text, onEvent) {
      fake.started.push({ work, text });
      emit(onEvent, { kind: 'started', turnId: 'turn-1' });
      emit(onEvent, { kind: 'running' });
      emit(onEvent, { kind: 'completed' });
      return { turnId: 'turn-1' };
    },
    async readWorkProjection() {
      return { text: '', tools: [] };
    },
    async inspectWork() {
      return fake.inspectionStatus;
    },
    async respondToSandboxBoundary(work, response) {
      fake.sandboxResponses.push({ work, response });
    },
    async respondToUserQuestion(work, response) {
      fake.questionResponses.push({ work, response });
    },
    async setPermissionMode(work, mode) {
      fake.permissions.push({ work, mode });
    },
    async stopWork(work) {
      fake.stopped.push(work);
    },
  };
  return fake;
}

function emit(listener: (event: UnifiedTargetEvent) => void, event: UnifiedTargetEvent): void {
  listener(event);
}

async function createFixture(
  hosts: FakeHost[],
  options: {
    answerDiscussion?: (text: string) => Promise<string>;
    resolveIntent?: UnifiedIntentResolver;
    onDecisionTrace?: (trace: DecisionTrace) => void;
  } = {},
) {
  const root = await temporaryRoot();
  const summaries = await Promise.all(hosts.map((candidate) => candidate.summary()));
  const directory: WorkspaceHostDirectory = {
    async list() {
      return hosts;
    },
    async get(workspaceId) {
      const index = summaries.findIndex((summary) => summary.id === workspaceId);
      return hosts[index];
    },
  };
  let id = 0;
  const projections = createUnifiedProjectionStore(root);
  return {
    hosts,
    directory,
    projections,
    orchestrator: createWorkOrchestrator({
      projections,
      hosts: directory,
      defaultPermissionMode: async () => 'ask',
      createId: () => `id-${++id}`,
      now: () => 100 + id,
      ...(options.answerDiscussion ? {
        answerDiscussion: (text: string) => options.answerDiscussion!(text),
      } : {}),
      ...(options.resolveIntent ? { resolveIntent: options.resolveIntent } : {}),
      ...(options.onDecisionTrace ? { onDecisionTrace: options.onDecisionTrace } : {}),
    }),
  };
}

async function waitForTerminal(
  read: () => ReturnType<ReturnType<typeof createWorkOrchestrator>['snapshot']>,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await read();
    const work = [...snapshot.items].reverse().find((item) => item.kind === 'work');
    if (
      work?.kind === 'work' &&
      ['completed', 'failed', 'blocked', 'stopped'].includes(work.block.status)
    ) {
      return snapshot;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Work did not reach a terminal state');
}

async function waitForCoordinationTerminal(
  read: () => ReturnType<ReturnType<typeof createWorkOrchestrator>['snapshot']>,
  planId: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await read();
    const item = snapshot.items.find(
      (candidate) => candidate.kind === 'coordination' && candidate.plan.id === planId,
    );
    if (
      item?.kind === 'coordination' &&
      ['completed', 'failed', 'cancelled'].includes(item.plan.status)
    ) {
      return item.plan;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Coordination plan did not reach a terminal state');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Condition was not met');
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Async condition was not met');
}
