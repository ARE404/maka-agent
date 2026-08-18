import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, normalize, resolve } from 'node:path';
import type { UnifiedWorkspaceSummary } from '@maka/core/unified-session';

interface PersistedWorkspace {
  id: string;
  stableKey?: string;
  name: string;
  path: string;
  createdAt: number;
  lastUsedAt: number;
}

interface PersistedRegistry {
  schemaVersion: 1;
  workspaces: PersistedWorkspace[];
}

export interface WorkspaceRegistryRecord extends UnifiedWorkspaceSummary {
  createdAt: number;
  lastUsedAt: number;
}

export interface UnifiedWorkspaceRegistry {
  list(): Promise<WorkspaceRegistryRecord[]>;
  get(workspaceId: string): Promise<WorkspaceRegistryRecord | undefined>;
  ensure(path: string, name?: string, stableKey?: string): Promise<WorkspaceRegistryRecord>;
  touch(workspaceId: string): Promise<WorkspaceRegistryRecord>;
}

export function createUnifiedWorkspaceRegistry(
  appDataRoot: string,
  deps: { now?: () => number; createId?: () => string } = {},
): UnifiedWorkspaceRegistry {
  return new FileUnifiedWorkspaceRegistry(
    `${appDataRoot}/unified-session/workspaces.json`,
    deps.now ?? Date.now,
    deps.createId ?? randomUUID,
  );
}

class FileUnifiedWorkspaceRegistry implements UnifiedWorkspaceRegistry {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  async list(): Promise<WorkspaceRegistryRecord[]> {
    let records: PersistedWorkspace[] = [];
    await this.withQueue(async () => {
      records = (await this.read()).workspaces;
    });
    const presented = await Promise.all(records.map((record) => this.present(record)));
    return presented.sort(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.id.localeCompare(right.id),
    );
  }

  async get(workspaceId: string): Promise<WorkspaceRegistryRecord | undefined> {
    return (await this.list()).find((workspace) => workspace.id === workspaceId);
  }

  async ensure(path: string, name?: string, stableKey?: string): Promise<WorkspaceRegistryRecord> {
    const canonicalPath = normalize(resolve(path));
    let result: PersistedWorkspace | undefined;
    await this.withQueue(async () => {
      const registry = await this.read();
      const normalizedStableKey = stableKey?.trim() || undefined;
      const existing = registry.workspaces.find((workspace) =>
        normalizedStableKey
          ? workspace.stableKey === normalizedStableKey ||
            (workspace.stableKey === undefined && workspace.path === canonicalPath)
          : workspace.path === canonicalPath,
      );
      if (existing) {
        existing.path = canonicalPath;
        if (normalizedStableKey) existing.stableKey = normalizedStableKey;
        existing.lastUsedAt = this.now();
        if (name?.trim()) existing.name = name.trim();
        result = existing;
      } else {
        const timestamp = this.now();
        result = {
          id: this.createId(),
          ...(normalizedStableKey ? { stableKey: normalizedStableKey } : {}),
          name: name?.trim() || basename(canonicalPath) || 'Workspace',
          path: canonicalPath,
          createdAt: timestamp,
          lastUsedAt: timestamp,
        };
        registry.workspaces.push(result);
      }
      await this.write(registry);
    });
    if (!result) throw new Error(`Unable to register Workspace: ${canonicalPath}`);
    return this.present(result);
  }

  async touch(workspaceId: string): Promise<WorkspaceRegistryRecord> {
    let result: PersistedWorkspace | undefined;
    await this.withQueue(async () => {
      const registry = await this.read();
      const workspace = registry.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) throw new Error(`No such Workspace: ${workspaceId}`);
      workspace.lastUsedAt = this.now();
      result = workspace;
      await this.write(registry);
    });
    if (!result) throw new Error(`Unable to touch Workspace: ${workspaceId}`);
    return this.present(result);
  }

  private async read(): Promise<PersistedRegistry> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return normalizeRegistry(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { schemaVersion: 1, workspaces: [] };
    }
  }

  private async write(registry: PersistedRegistry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private async present(record: PersistedWorkspace): Promise<WorkspaceRegistryRecord> {
    return {
      ...record,
      available: await isDirectory(record.path),
      // The registry never infers privacy. The owning Workspace Host replaces
      // this conservative value before the Workspace enters route candidates.
      incognitoActive: true,
    };
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

function normalizeRegistry(input: unknown): PersistedRegistry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { schemaVersion: 1, workspaces: [] };
  }
  const workspaces = (input as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(workspaces)) return { schemaVersion: 1, workspaces: [] };
  return {
    schemaVersion: 1,
    workspaces: workspaces.flatMap((value): PersistedWorkspace[] => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const candidate = value as Partial<PersistedWorkspace>;
      if (
        typeof candidate.id !== 'string' ||
        !candidate.id ||
        typeof candidate.name !== 'string' ||
        !candidate.name ||
        typeof candidate.path !== 'string' ||
        !candidate.path ||
        typeof candidate.createdAt !== 'number' ||
        !Number.isFinite(candidate.createdAt) ||
        typeof candidate.lastUsedAt !== 'number' ||
        !Number.isFinite(candidate.lastUsedAt)
      ) {
        return [];
      }
      return [{
        id: candidate.id,
        ...(typeof candidate.stableKey === 'string' && candidate.stableKey
          ? { stableKey: candidate.stableKey }
          : {}),
        name: candidate.name,
        path: normalize(resolve(candidate.path)),
        createdAt: candidate.createdAt,
        lastUsedAt: candidate.lastUsedAt,
      }];
    }),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
