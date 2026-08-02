import { useEffect, useState } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core';

const NEXT_PROMPT_DEBOUNCE_MS = 250;

export interface NextPromptSuggestionTrigger {
  sessionId: string;
  key: string;
}

export function deriveNextPromptSuggestionTrigger(input: {
  session: SessionSummary | undefined;
  messages: readonly StoredMessage[];
  enabled: boolean;
  busy: boolean;
}): NextPromptSuggestionTrigger | null {
  const { session } = input;
  if (!input.enabled || input.busy || !session) return null;
  if (session.backend !== 'ai-sdk') return null;
  if (session.collaborationMode === 'plan' || session.subagentParent) return null;
  if (!['active', 'review', 'done'].includes(session.status)) return null;

  const conversation = input.messages.filter(
    (message) => message.type === 'user' || message.type === 'assistant',
  );
  const latest = conversation.at(-1);
  if (!latest || latest.type !== 'assistant' || !latest.text.trim()) return null;
  let latestUser: Extract<(typeof conversation)[number], { type: 'user' }> | undefined;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.type === 'user') {
      latestUser = message;
      break;
    }
  }
  if (!latestUser || latestUser.type !== 'user' || latestUser.origin || !latestUser.text.trim()) {
    return null;
  }
  return {
    sessionId: session.id,
    key: `${session.id}:${session.model}:${latestUser.id}:${latest.id}:${latest.text.length}`,
  };
}

export function useNextPromptSuggestion(input: {
  session: SessionSummary | undefined;
  messages: readonly StoredMessage[];
  enabled: boolean;
  busy: boolean;
}): string | undefined {
  const trigger = deriveNextPromptSuggestionTrigger(input);
  const [resolved, setResolved] = useState<{
    key: string;
    suggestion: string | undefined;
  } | null>(null);

  useEffect(() => {
    if (!trigger) return undefined;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void window.maka.sessions
        .suggestNextPrompt(trigger.sessionId)
        .then((result) => {
          if (disposed) return;
          const suggestion = result.suggestion?.trim() || undefined;
          setResolved({ key: trigger.key, suggestion });
        })
        .catch(() => {
          if (!disposed) setResolved({ key: trigger.key, suggestion: undefined });
        });
    }, NEXT_PROMPT_DEBOUNCE_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [trigger?.key, trigger?.sessionId]);

  return trigger && resolved?.key === trigger.key ? resolved.suggestion : undefined;
}
