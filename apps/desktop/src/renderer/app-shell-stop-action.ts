import type { UiLocale } from '@maka/core';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;

type ToastApi = {
  error(title: string, description?: string): void;
};

export function createAppShellStopAction(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  addPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => boolean;
  clearPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => void;
  setStopPendingBySession: BooleanRecordUpdater;
  stopPendingRef: RefBox<Set<string>>;
  toastApi: ToastApi;
}): () => Promise<boolean> {
  const {
    uiLocale,
    activeIdRef,
    addPendingSessionAction,
    clearPendingSessionAction,
    setStopPendingBySession,
    stopPendingRef,
    toastApi,
  } = deps;

  async function stop() {
    const sessionId = activeIdRef.current;
    if (!sessionId || !addPendingSessionAction(sessionId, stopPendingRef, setStopPendingBySession)) return false;
    try {
      await window.maka.sessions.stop(sessionId, { source: 'stop_button' });
      return true;
    } catch (error) {
      // The Composer's Escape path and the question prompt both invoke
      // `onStop` without awaiting, so a rejected IPC would otherwise surface as an
      // UnhandledPromiseRejection and the user would see nothing.
      // Surface it as a toast so the user knows the model wasn't
      // actually interrupted and can retry.
      if (activeIdRef.current === sessionId) {
        const copy = getDesktopConversationCopy(uiLocale).actions;
        toastApi.error(copy.stopFailedTitle, localizedShellErrorMessage(error, copy.stopFailedFallback, uiLocale));
      }
      return false;
    } finally {
      clearPendingSessionAction(sessionId, stopPendingRef, setStopPendingBySession);
    }
  }

  return stop;
}
