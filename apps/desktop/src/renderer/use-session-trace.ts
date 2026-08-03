import { useCallback, useEffect, useRef, useState } from 'react';
import { generalizedErrorMessage, generalizedErrorMessageChinese } from '@maka/core';
import type { SessionTrace } from '@maka/core/session-trace';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

interface SessionTraceSnapshot {
  sessionId?: string;
  trace?: SessionTrace;
  loading: boolean;
  error?: string;
}

const EMPTY_SNAPSHOT: SessionTraceSnapshot = { loading: false };

/**
 * Reads the per-session causal trace (#1625).
 *
 * Reloads on the session's own event stream rather than on a timer: the trace
 * is a projection of the two ledgers, so the moment worth re-reading is when
 * one of them gained an event. Only refreshes while the panel is visible —
 * a hidden panel that keeps re-projecting a long session is a cost with no
 * reader.
 */
export function useSessionTrace(
  sessionId: string | undefined,
  active: boolean,
): SessionTraceSnapshot & { retry: () => void } {
  const locale = useUiLocale();
  const copy = getDesktopConversationCopy(locale).inspector;
  const revisionRef = useRef(0);
  const [snapshot, setSnapshot] = useState<SessionTraceSnapshot>(EMPTY_SNAPSHOT);

  const load = useCallback(
    (targetSessionId: string, preserveTrace: boolean) => {
      const revision = ++revisionRef.current;
      setSnapshot((current) => ({
        sessionId: targetSessionId,
        // Keep the last trace on screen through a refresh: a live turn would
        // otherwise blank the timeline on every event.
        ...(preserveTrace && current.sessionId === targetSessionId
          ? { trace: current.trace }
          : {}),
        loading: true,
      }));
      void window.maka.inspector.trace(targetSessionId).then(
        (result) => {
          if (revision !== revisionRef.current) return;
          if (!result.ok) {
            setSnapshot((current) => ({
              sessionId: targetSessionId,
              ...(current.sessionId === targetSessionId ? { trace: current.trace } : {}),
              loading: false,
              error: result.error.message ?? copy.loadFailed,
            }));
            return;
          }
          setSnapshot({ sessionId: targetSessionId, trace: result.value, loading: false });
        },
        (error: unknown) => {
          if (revision !== revisionRef.current) return;
          setSnapshot((current) => ({
            sessionId: targetSessionId,
            ...(current.sessionId === targetSessionId ? { trace: current.trace } : {}),
            loading: false,
            error:
              locale === 'zh'
                ? generalizedErrorMessageChinese(error, copy.loadFailed)
                : generalizedErrorMessage(error, copy.loadFailed),
          }));
        },
      );
    },
    [copy.loadFailed, locale],
  );

  useEffect(() => {
    revisionRef.current += 1;
    if (!sessionId || !active) {
      if (!sessionId) setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    load(sessionId, false);
    return () => {
      revisionRef.current += 1;
    };
  }, [active, load, sessionId]);

  const retry = useCallback(() => {
    if (sessionId) load(sessionId, true);
  }, [load, sessionId]);

  if (snapshot.sessionId !== sessionId) {
    return { ...EMPTY_SNAPSHOT, loading: Boolean(sessionId) && active, retry };
  }
  return { ...snapshot, retry };
}
