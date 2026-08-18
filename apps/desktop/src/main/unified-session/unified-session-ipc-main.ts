import { ipcMain as electronIpcMain } from 'electron';
import { isPermissionMode } from '@maka/core/permission';
import type { UnifiedSendInput, WorkRef } from '@maka/core/unified-session';
import type { WorkOrchestrator, WorkspaceHostDirectory } from './work-orchestrator.js';
import {
  normalizeSandboxBoundaryResponse,
  normalizeUserQuestionResponse,
} from '../permission-response-guard.js';

interface IpcMainLike {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface UnifiedSessionIpcHandle {
  dispose(): void;
}

export function registerUnifiedSessionIpc(deps: {
  orchestrator: WorkOrchestrator;
  hosts: WorkspaceHostDirectory;
  registerWorkspace(): Promise<unknown>;
  openWork(work: WorkRef): Promise<void> | void;
  ipcMain?: IpcMainLike;
}): UnifiedSessionIpcHandle {
  const ipcMain = deps.ipcMain ?? electronIpcMain;
  const channels = [
    'unified:getSnapshot',
    'unified:listWorkspaces',
    'unified:send',
    'unified:confirmCoordination',
    'unified:cancelCoordination',
    'unified:readWorkProjection',
    'unified:respondToSandboxBoundary',
    'unified:respondToUserQuestion',
    'unified:setPermissionMode',
    'unified:stopWork',
    'unified:requestRetarget',
    'unified:registerWorkspace',
    'unified:relinkWorkspace',
    'unified:openWork',
  ];

  ipcMain.handle('unified:getSnapshot', () => deps.orchestrator.snapshot());
  ipcMain.handle('unified:listWorkspaces', async () => {
    const hosts = await deps.hosts.list();
    return Promise.all(hosts.map((host) => host.summary()));
  });
  ipcMain.handle('unified:send', (_event, value: unknown) =>
    deps.orchestrator.send(normalizeUnifiedSendInput(value)),
  );
  ipcMain.handle('unified:confirmCoordination', (_event, planId: unknown) =>
    deps.orchestrator.confirmCoordination(normalizePlanId(planId)),
  );
  ipcMain.handle('unified:cancelCoordination', (_event, planId: unknown) =>
    deps.orchestrator.cancelCoordination(normalizePlanId(planId)),
  );
  ipcMain.handle(
    'unified:readWorkProjection',
    (_event, workValue: unknown, turnIdValue: unknown) => {
      if (typeof turnIdValue !== 'string' || !turnIdValue || turnIdValue.length > 512) {
        throw new TypeError('Invalid Unified turn id');
      }
      return deps.orchestrator.readWorkProjection(normalizeWorkRef(workValue), turnIdValue);
    },
  );
  ipcMain.handle(
    'unified:respondToSandboxBoundary',
    (_event, workValue: unknown, responseValue: unknown) =>
      deps.orchestrator.respondToSandboxBoundary(
        normalizeWorkRef(workValue),
        normalizeSandboxBoundaryResponse(responseValue),
      ),
  );
  ipcMain.handle(
    'unified:respondToUserQuestion',
    (_event, workValue: unknown, responseValue: unknown) =>
      deps.orchestrator.respondToUserQuestion(
        normalizeWorkRef(workValue),
        normalizeUserQuestionResponse(responseValue),
      ),
  );
  ipcMain.handle('unified:setPermissionMode', (_event, workValue: unknown, mode: unknown) => {
    const work = normalizeWorkRef(workValue);
    if (!isPermissionMode(mode) || mode === 'explore') {
      throw new TypeError(`Invalid Unified permission mode: ${String(mode)}`);
    }
    return deps.orchestrator.setPermissionMode(work, mode);
  });
  ipcMain.handle('unified:stopWork', (_event, workValue: unknown) =>
    deps.orchestrator.stopWork(normalizeWorkRef(workValue)),
  );
  ipcMain.handle('unified:requestRetarget', (_event, blockId: unknown) =>
    deps.orchestrator.requestRetarget(normalizePlanId(blockId)),
  );
  ipcMain.handle('unified:registerWorkspace', () => deps.registerWorkspace());
  ipcMain.handle('unified:relinkWorkspace', async (_event, workspaceId: unknown) => {
    const id = normalizePlanId(workspaceId);
    const host = await deps.hosts.get(id);
    if (!host?.relink) throw new Error('Workspace cannot be relinked');
    await host.relink();
  });
  ipcMain.handle('unified:openWork', (_event, workValue: unknown) =>
    deps.openWork(normalizeWorkRef(workValue)),
  );

  return {
    dispose() {
      for (const channel of channels) ipcMain.removeHandler(channel);
    },
  };
}

function normalizeUnifiedSendInput(value: unknown): UnifiedSendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Unified send input');
  }
  const candidate = value as Partial<UnifiedSendInput>;
  const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
  if (!text || text.length > 128_000) throw new TypeError('Invalid Unified input text');
  return {
    text,
    ...(typeof candidate.replyToBlockId === 'string' && candidate.replyToBlockId
      ? { replyToBlockId: candidate.replyToBlockId }
      : {}),
    ...(candidate.explicitWork ? { explicitWork: normalizeWorkRef(candidate.explicitWork) } : {}),
    ...(typeof candidate.explicitWorkspaceId === 'string' && candidate.explicitWorkspaceId
      ? { explicitWorkspaceId: normalizePlanId(candidate.explicitWorkspaceId) }
      : {}),
    ...(typeof candidate.sourceClarificationMessageId === 'string' && candidate.sourceClarificationMessageId
      ? { sourceClarificationMessageId: normalizePlanId(candidate.sourceClarificationMessageId) }
      : {}),
    ...(typeof candidate.replacesBlockId === 'string' && candidate.replacesBlockId
      ? { replacesBlockId: normalizePlanId(candidate.replacesBlockId) }
      : {}),
  };
}

function normalizeWorkRef(value: unknown): WorkRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Work reference');
  }
  const candidate = value as Partial<WorkRef>;
  if (
    typeof candidate.workspaceId !== 'string' ||
    !candidate.workspaceId ||
    typeof candidate.sessionId !== 'string' ||
    !candidate.sessionId
  ) {
    throw new TypeError('Invalid Work reference');
  }
  return { workspaceId: candidate.workspaceId, sessionId: candidate.sessionId };
}

function normalizePlanId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) {
    throw new TypeError('Invalid coordination plan id');
  }
  return value;
}
