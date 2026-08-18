import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  UnifiedCoordinationPlan,
  UnifiedConversationItem,
  UnifiedDiscussionMessage,
  UnifiedSnapshot,
  UnifiedWorkBlock,
  WorkRef,
} from '@maka/core/unified-session';

export interface UnifiedProjectionStore {
  read(): Promise<UnifiedSnapshot>;
  append(item: UnifiedConversationItem): Promise<UnifiedSnapshot>;
  updateDiscussionMessage(
    messageId: string,
    patch: Partial<UnifiedDiscussionMessage>,
  ): Promise<UnifiedSnapshot>;
  updateWorkBlock(blockId: string, patch: Partial<UnifiedWorkBlock>): Promise<UnifiedSnapshot>;
  updateCoordinationPlan(
    planId: string,
    patch: Partial<Pick<UnifiedCoordinationPlan, 'status' | 'updatedAt'>>,
  ): Promise<UnifiedSnapshot>;
  updateCoordinationStep(
    planId: string,
    stepId: string,
    patch: Partial<UnifiedCoordinationPlan['steps'][number]>,
    updatedAt: number,
  ): Promise<UnifiedSnapshot>;
  setWorkFocus(work: WorkRef | undefined): Promise<UnifiedSnapshot>;
  deleteWork(work: WorkRef): Promise<UnifiedSnapshot>;
  deleteSession(sessionId: string): Promise<UnifiedSnapshot>;
}

export function createUnifiedProjectionStore(appDataRoot: string): UnifiedProjectionStore {
  return new FileUnifiedProjectionStore(`${appDataRoot}/unified-session/conversation.json`);
}

class FileUnifiedProjectionStore implements UnifiedProjectionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<UnifiedSnapshot> {
    let snapshot = emptySnapshot();
    await this.withQueue(async () => {
      snapshot = await this.readUnsafe();
    });
    return structuredClone(snapshot);
  }

  append(item: UnifiedConversationItem): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: [...snapshot.items, item],
    }));
  }

  updateDiscussionMessage(
    messageId: string,
    patch: Partial<UnifiedDiscussionMessage>,
  ): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: snapshot.items.map((item) =>
        item.kind === 'discussion' && item.id === messageId
          ? { ...item, ...patch, id: item.id, kind: 'discussion' as const }
          : item,
      ),
    }));
  }

  updateWorkBlock(blockId: string, patch: Partial<UnifiedWorkBlock>): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: snapshot.items.map((item) =>
        item.kind === 'work' && item.block.id === blockId
          ? { ...item, block: { ...item.block, ...patch, id: item.block.id } }
          : item,
      ),
    }));
  }

  updateCoordinationPlan(
    planId: string,
    patch: Partial<Pick<UnifiedCoordinationPlan, 'status' | 'updatedAt'>>,
  ): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: snapshot.items.map((item) =>
        item.kind === 'coordination' && item.plan.id === planId
          ? { ...item, plan: { ...item.plan, ...patch, id: item.plan.id } }
          : item,
      ),
    }));
  }

  updateCoordinationStep(
    planId: string,
    stepId: string,
    patch: Partial<UnifiedCoordinationPlan['steps'][number]>,
    updatedAt: number,
  ): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: snapshot.items.map((item) =>
        item.kind === 'coordination' && item.plan.id === planId
          ? {
              ...item,
              plan: {
                ...item.plan,
                updatedAt,
                steps: item.plan.steps.map((step) =>
                  step.id === stepId ? { ...step, ...patch, id: step.id } : step,
                ),
              },
            }
          : item,
      ),
    }));
  }

  setWorkFocus(work: WorkRef | undefined): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      ...(work ? { workFocus: work } : { workFocus: undefined }),
    }));
  }

  deleteWork(work: WorkRef): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: snapshot.items.filter((item) => {
        if (item.kind === 'work') {
          return item.block.work.workspaceId !== work.workspaceId ||
            item.block.work.sessionId !== work.sessionId;
        }
        if (item.kind === 'lifecycle') {
          return item.work.workspaceId !== work.workspaceId || item.work.sessionId !== work.sessionId;
        }
        if (item.kind === 'coordination') {
          return !item.plan.steps.some(
            (step) =>
              (step.work?.workspaceId === work.workspaceId &&
                step.work.sessionId === work.sessionId) ||
              (step.targetWork?.workspaceId === work.workspaceId &&
                step.targetWork.sessionId === work.sessionId),
          );
        }
        return true;
      }),
      ...(snapshot.workFocus?.workspaceId === work.workspaceId &&
      snapshot.workFocus.sessionId === work.sessionId
        ? { workFocus: undefined }
        : {}),
    }));
  }

  deleteSession(sessionId: string): Promise<UnifiedSnapshot> {
    return this.mutate((snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      items: snapshot.items.filter((item) => {
        if (item.kind === 'work') return item.block.work.sessionId !== sessionId;
        if (item.kind === 'lifecycle') return item.work.sessionId !== sessionId;
        if (item.kind === 'coordination') {
          return !item.plan.steps.some(
            (step) =>
              step.work?.sessionId === sessionId || step.targetWork?.sessionId === sessionId,
          );
        }
        return true;
      }),
      ...(snapshot.workFocus?.sessionId === sessionId ? { workFocus: undefined } : {}),
    }));
  }

  private async mutate(
    operation: (snapshot: UnifiedSnapshot) => UnifiedSnapshot,
  ): Promise<UnifiedSnapshot> {
    let result = emptySnapshot();
    await this.withQueue(async () => {
      result = operation(await this.readUnsafe());
      await this.write(result);
    });
    return structuredClone(result);
  }

  private async readUnsafe(): Promise<UnifiedSnapshot> {
    try {
      return normalizeSnapshot(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return emptySnapshot();
    }
  }

  private async write(snapshot: UnifiedSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

function emptySnapshot(): UnifiedSnapshot {
  return { revision: 0, items: [] };
}

function normalizeSnapshot(input: unknown): UnifiedSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptySnapshot();
  const candidate = input as Partial<UnifiedSnapshot>;
  return {
    revision:
      typeof candidate.revision === 'number' && Number.isSafeInteger(candidate.revision)
        ? candidate.revision
        : 0,
    items: Array.isArray(candidate.items)
      ? candidate.items.filter(isUnifiedConversationItem)
      : [],
    ...(isWorkRef(candidate.workFocus) ? { workFocus: candidate.workFocus } : {}),
  };
}

function isUnifiedConversationItem(value: unknown): value is UnifiedConversationItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { id?: unknown; kind?: unknown; [key: string]: unknown };
  if (typeof candidate.id !== 'string' || !candidate.id) return false;
  if (candidate.kind === 'discussion') {
    return (
      (candidate.role === 'user' || candidate.role === 'assistant') &&
      typeof candidate.text === 'string' &&
      typeof candidate.createdAt === 'number' &&
      (candidate.status === undefined ||
        ['running', 'completed', 'failed'].includes(String(candidate.status))) &&
      (candidate.replyToMessageId === undefined ||
        typeof candidate.replyToMessageId === 'string') &&
      (candidate.action === undefined ||
        (candidate.action !== null &&
          typeof candidate.action === 'object' &&
          !Array.isArray(candidate.action) &&
          ((candidate.action as { kind?: unknown }).kind === 'register_workspace' ||
            ((candidate.action as { kind?: unknown; workspaceId?: unknown }).kind === 'relink_workspace' &&
              typeof (candidate.action as { workspaceId?: unknown }).workspaceId === 'string') ||
            ((candidate.action as { kind?: unknown; originalText?: unknown; options?: unknown }).kind === 'clarify' &&
              typeof (candidate.action as { originalText?: unknown }).originalText === 'string' &&
              Array.isArray((candidate.action as { options?: unknown }).options)))))
    );
  }
  if (candidate.kind === 'coordination') {
    return isCoordinationPlan(candidate.plan);
  }
  if (candidate.kind === 'lifecycle') {
    return (
      isWorkRef(candidate.work) &&
      typeof candidate.workspaceName === 'string' &&
      typeof candidate.workName === 'string' &&
      ['completed', 'blocked', 'waiting_for_user'].includes(String(candidate.status)) &&
      typeof candidate.createdAt === 'number'
    );
  }
  if (candidate.kind !== 'work' || !candidate.block || typeof candidate.block !== 'object') {
    return false;
  }
  const block = candidate.block as Partial<UnifiedWorkBlock>;
  return (
    typeof block.id === 'string' &&
    isWorkRef(block.work) &&
    typeof block.workspaceName === 'string' &&
    typeof block.workName === 'string' &&
    typeof block.prompt === 'string' &&
    typeof block.permissionMode === 'string' &&
    typeof block.status === 'string' &&
    typeof block.createdAt === 'number' &&
    typeof block.updatedAt === 'number'
  );
}

function isCoordinationPlan(value: unknown): value is UnifiedCoordinationPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<UnifiedCoordinationPlan>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.prompt === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every(
      (step) =>
        step &&
        typeof step === 'object' &&
        typeof step.id === 'string' &&
        typeof step.workspaceId === 'string' &&
        typeof step.workspaceName === 'string' &&
        typeof step.title === 'string' &&
        typeof step.prompt === 'string' &&
        Array.isArray(step.dependsOn) &&
        step.dependsOn.every((id) => typeof id === 'string') &&
        typeof step.status === 'string' &&
        (!step.targetWork || isWorkRef(step.targetWork)) &&
        (!step.work || isWorkRef(step.work))
    )
  );
}


function isWorkRef(value: unknown): value is WorkRef {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as WorkRef).workspaceId === 'string' &&
      typeof (value as WorkRef).sessionId === 'string',
  );
}
