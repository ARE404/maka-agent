import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionHeader, StoredMessage } from '@maka/core';
import {
  buildNextPromptSuggestionRequest,
  createNextPromptSuggestionService,
  sanitizeNextPromptSuggestion,
} from '../next-prompt-suggestion.js';

function session(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-test',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    schemaVersion: 1,
    ...overrides,
  };
}

function conversation(userOrigin?: Extract<StoredMessage, { type: 'user' }>['origin']): StoredMessage[] {
  return [
    { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '实现登录页', origin: userOrigin },
    {
      type: 'assistant',
      id: 'a1',
      turnId: 't1',
      ts: 2,
      text: '登录页已完成，相关测试通过。',
      modelId: 'gpt-test',
    },
  ];
}

describe('next prompt suggestion request', () => {
  it('uses a bounded visible conversation ending in an assistant reply', () => {
    const request = buildNextPromptSuggestionRequest(session(), conversation());
    assert.ok(request);
    assert.equal(request.connectionSlug, 'openai');
    assert.match(request.prompt, /<user>实现登录页<\/user>/);
    assert.match(request.prompt, /<assistant>登录页已完成，相关测试通过。<\/assistant>/);
    assert.match(request.cacheKey, /u1:a1$/);
  });

  it('skips unsafe or non-interactive conversation states', () => {
    assert.equal(buildNextPromptSuggestionRequest(session({ backend: 'fake' }), conversation()), null);
    assert.equal(buildNextPromptSuggestionRequest(session({ collaborationMode: 'plan' }), conversation()), null);
    assert.equal(buildNextPromptSuggestionRequest(session({ status: 'running' }), conversation()), null);
    assert.equal(buildNextPromptSuggestionRequest(session(), conversation({ kind: 'goal', goalId: 'g1' })), null);
    assert.equal(buildNextPromptSuggestionRequest(session(), conversation().slice(0, 1)), null);
  });
});

describe('next prompt suggestion output', () => {
  it('cleans common model wrappers and sentinel output', () => {
    assert.equal(sanitizeNextPromptSuggestion('```text\n"运行测试并修复失败项"\n```'), '运行测试并修复失败项');
    assert.equal(sanitizeNextPromptSuggestion('{"suggestion":"总结一下这次修改"}'), '总结一下这次修改');
    assert.equal(sanitizeNextPromptSuggestion('NO_SUGGESTION'), null);
  });

  it('deduplicates in-flight and cached requests for the same turn', async () => {
    let calls = 0;
    const service = createNextPromptSuggestionService({
      readSession: async () => session(),
      readMessages: async () => conversation(),
      generate: async () => {
        calls += 1;
        await Promise.resolve();
        return '运行测试';
      },
      now: () => 1_000,
    });

    const [first, second] = await Promise.all([
      service.suggest('session-1'),
      service.suggest('session-1'),
    ]);
    assert.equal(first, '运行测试');
    assert.equal(second, '运行测试');
    assert.equal(await service.suggest('session-1'), '运行测试');
    assert.equal(calls, 1);
  });

  it('fails silently when generation rejects', async () => {
    const service = createNextPromptSuggestionService({
      readSession: async () => session(),
      readMessages: async () => conversation(),
      generate: async () => { throw new Error('offline'); },
    });
    assert.equal(await service.suggest('session-1'), null);
  });
});
