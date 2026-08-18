import type {
  UnifiedIntentDisposition,
  UnifiedRouteOption,
  UnifiedRouteTrace,
} from '@maka/core/unified-session';
import {
  resolveUnifiedIntent,
  type UnifiedIntentResolver,
  type UnifiedIntentResolverInput,
  type WorkCandidate,
} from './work-orchestrator.js';

export interface BoundedRouteCandidate {
  id: string;
  kind: 'work' | 'project';
  project: string;
  work?: string;
  objective?: string;
  recentOutcome?: string;
}

export interface BoundedModelRouteRequest {
  text: string;
  baseline: UnifiedIntentDisposition['kind'];
  candidates: BoundedRouteCandidate[];
  focusedCandidateId?: string;
}

export interface BoundedModelRouteDecision {
  intent: 'discussion' | 'resume_work' | 'create_work' | 'clarify';
  targetId: string | null;
  confidence: number;
  evidence: string[];
}

export type BoundedModelRouteClassifier = (
  request: BoundedModelRouteRequest,
) => Promise<BoundedModelRouteDecision>;

/**
 * Adds semantic judgment only at uncertain seams. Hard bindings, explicit
 * Project names, interaction replies, and coordination remain deterministic.
 * The model receives opaque candidate ids and its output is validated back
 * against that bounded set before any target Session can be selected.
 */
export function createBoundedModelIntentResolver(
  classify: BoundedModelRouteClassifier,
): UnifiedIntentResolver {
  return async (input) => {
    const baseline = await resolveUnifiedIntent(input);
    if (!shouldConsultModel(input, baseline)) return baseline;
    const bounded = boundedCandidates(input);
    try {
      const decision = await classify({
        text: input.input.text,
        baseline: baseline.kind,
        candidates: bounded.list,
        ...(bounded.focusedCandidateId
          ? { focusedCandidateId: bounded.focusedCandidateId }
          : {}),
      });
      return applyBoundedDecision(input, baseline, bounded, decision);
    } catch {
      return baseline;
    }
  };
}

function shouldConsultModel(
  input: UnifiedIntentResolverInput,
  baseline: UnifiedIntentDisposition,
): boolean {
  if (input.input.explicitWork || input.input.explicitWorkspaceId || input.input.replyToBlockId) {
    return false;
  }
  if (baseline.kind === 'coordinate' || baseline.kind === 'register_workspace' ||
      baseline.kind === 'relink_workspace') {
    return false;
  }
  if (baseline.route?.confidence !== undefined && baseline.route.confidence >= 0.86) {
    return false;
  }
  if (baseline.kind === 'discussion') return mayNeedSemanticRouting(input.input.text);
  return baseline.kind === 'clarify' || baseline.kind === 'create_work' ||
    baseline.kind === 'resume_work';
}

function mayNeedSemanticRouting(text: string): boolean {
  if (/[?？]$/u.test(text.trim())) return false;
  return /(?:我想|需要|帮我|麻烦|研究一下|看看|看下|弄一下|处理一下|接着|那个|这个|它|please|could you|i want|need to|take a look)/iu.test(text);
}

function boundedCandidates(input: UnifiedIntentResolverInput): {
  list: BoundedRouteCandidate[];
  works: Map<string, WorkCandidate>;
  projects: Map<string, UnifiedIntentResolverInput['workspaces'][number]>;
  focusedCandidateId?: string;
} {
  const works = new Map<string, WorkCandidate>();
  const projects = new Map<string, UnifiedIntentResolverInput['workspaces'][number]>();
  const list: BoundedRouteCandidate[] = [];
  for (const [index, candidate] of input.candidates.slice(0, 16).entries()) {
    const id = `work-${index}`;
    works.set(id, candidate);
    list.push({
      id,
      kind: 'work',
      project: candidate.workspaceName,
      work: candidate.workName,
      objective: candidate.semanticCard?.objective ?? candidate.workName,
      recentOutcome: candidate.semanticCard?.recentOutcome ?? '',
    });
  }
  for (const [index, workspace] of input.workspaces
    .filter((candidate) => candidate.available && !candidate.incognitoActive)
    .entries()) {
    const id = `project-${index}`;
    projects.set(id, workspace);
    list.push({ id, kind: 'project', project: workspace.name });
  }
  const focusedCandidateId = [...works].find(([, candidate]) =>
    candidate.work.workspaceId === input.snapshot.workFocus?.workspaceId &&
    candidate.work.sessionId === input.snapshot.workFocus?.sessionId,
  )?.[0];
  return { list, works, projects, ...(focusedCandidateId ? { focusedCandidateId } : {}) };
}

function applyBoundedDecision(
  input: UnifiedIntentResolverInput,
  baseline: UnifiedIntentDisposition,
  bounded: ReturnType<typeof boundedCandidates>,
  decision: BoundedModelRouteDecision,
): UnifiedIntentDisposition {
  const confidence = Number.isFinite(decision.confidence)
    ? Math.max(0, Math.min(1, decision.confidence))
    : 0;
  const trace: UnifiedRouteTrace = {
    resolver: 'model',
    confidence,
    evidence: decision.evidence.filter((item) => typeof item === 'string').slice(0, 4),
  };
  if (decision.intent === 'discussion') return { kind: 'discussion', route: trace };
  if (decision.intent === 'resume_work') {
    const candidate = decision.targetId ? bounded.works.get(decision.targetId) : undefined;
    if (candidate && confidence >= 0.82) {
      return { kind: 'resume_work', work: candidate.work, route: trace };
    }
  }
  if (decision.intent === 'create_work') {
    const workspace = decision.targetId ? bounded.projects.get(decision.targetId) : undefined;
    if (workspace && confidence >= 0.78) {
      return {
        kind: 'create_work',
        workspaceId: workspace.id,
        title: deriveModelWorkTitle(input.input.text),
        route: trace,
      };
    }
  }
  if (decision.intent === 'clarify' || confidence < 0.82) {
    const options = clarificationOptions(bounded, decision.targetId);
    if (options.length > 0) {
      return {
        kind: 'clarify',
        options,
        question: '我还不能可靠判断目标。请选择要继续的工作，或在哪个 Project 中新建工作。',
        route: trace,
      };
    }
  }
  return baseline;
}

function clarificationOptions(
  bounded: ReturnType<typeof boundedCandidates>,
  preferredId: string | null,
): UnifiedRouteOption[] {
  const workEntries = [...bounded.works.entries()];
  const orderedWorks = preferredId
    ? [...workEntries.filter(([id]) => id === preferredId), ...workEntries.filter(([id]) => id !== preferredId)]
    : workEntries;
  const workOptions = orderedWorks.slice(0, 3).map(([id, candidate]) => ({
    id,
    kind: 'work' as const,
    workspaceId: candidate.work.workspaceId,
    workspaceName: candidate.workspaceName,
    work: candidate.work,
    workName: candidate.workName,
    reason: candidate.semanticCard?.objective || '继续这项工作',
  }));
  const projectOptions = [...bounded.projects.entries()].slice(0, 4).map(([id, workspace]) => ({
    id,
    kind: 'new_work' as const,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    reason: '在此 Project 中创建新工作',
  }));
  return [...workOptions, ...projectOptions];
}

function deriveModelWorkTitle(text: string): string {
  return [...text.replace(/[。！？!?]+$/u, '').trim()].slice(0, 40).join('') || '新工作';
}
