import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import { deriveNextPromptSuggestionTrigger } from '../../renderer/use-next-prompt-suggestion.js';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    name: 'Test',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-test',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    ...overrides,
  };
}

const messages: StoredMessage[] = [
  { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '修复这个问题' },
  { type: 'assistant', id: 'a1', turnId: 't1', ts: 2, text: '问题已经修复。', modelId: 'gpt-test' },
];

describe('next prompt suggestion renderer trigger', () => {
  it('requests only after a completed assistant response', () => {
    assert.deepEqual(
      deriveNextPromptSuggestionTrigger({ session: session(), messages, enabled: true, busy: false }),
      { sessionId: 'session-1', key: 'session-1:gpt-test:u1:a1:7' },
    );
    assert.equal(
      deriveNextPromptSuggestionTrigger({ session: session(), messages, enabled: true, busy: true }),
      null,
    );
    assert.equal(
      deriveNextPromptSuggestionTrigger({ session: session(), messages, enabled: false, busy: false }),
      null,
    );
  });

  it('does not request for plan, subagent, or automated conversations', () => {
    assert.equal(
      deriveNextPromptSuggestionTrigger({
        session: session({ collaborationMode: 'plan' }),
        messages,
        enabled: true,
        busy: false,
      }),
      null,
    );
    assert.equal(
      deriveNextPromptSuggestionTrigger({
        session: session({
          subagentParent: {
            kind: 'subagent',
            parentSessionId: 'parent',
            spawnedBy: { parentRunId: 'run', parentTurnId: 'turn', toolCallId: 'tool' },
            lifecycle: 'foreground',
          },
        }),
        messages,
        enabled: true,
        busy: false,
      }),
      null,
    );
    const automated: StoredMessage[] = [
      { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: '继续', origin: { kind: 'goal', goalId: 'g1' } },
      messages[1]!,
    ];
    assert.equal(
      deriveNextPromptSuggestionTrigger({ session: session(), messages: automated, enabled: true, busy: false }),
      null,
    );
  });
});
