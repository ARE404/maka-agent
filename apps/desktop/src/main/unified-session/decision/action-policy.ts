import type {
  UnifiedCoordinationDraftStep,
  UnifiedIntentDisposition,
  UnifiedRouteOption,
  UnifiedRouteTrace,
  UnifiedWorkspaceSummary,
  WorkRef,
} from '@maka/core/unified-session';
import type {
  ActionPolicy,
  UnifiedIntentResolver,
  UnifiedIntentResolverInput,
  WorkCandidate,
} from './decision-types.js';
import { looksExecutable } from './intent-classifier.js';

export function createActionPolicy(resolveIntent: UnifiedIntentResolver): ActionPolicy {
  return {
    select(_intent, recall, context) {
      return resolveIntent({
        input: context.input,
        snapshot: context.snapshot,
        workspaces: recall.workspaces,
        candidates: recall.candidates,
      });
    },
  };
}

/** Deterministic policy. Model policy may refine only its uncertain results. */
export async function resolveUnifiedIntent(
  input: UnifiedIntentResolverInput,
): Promise<UnifiedIntentDisposition> {
  const { explicitWork, explicitWorkspaceId, replyToBlockId } = input.input;
  if (explicitWork) {
    return {
      kind: 'resume_work',
      work: explicitWork,
      route: routeTrace('explicit', 1, ['用户明确选择了目标 Work']),
    };
  }
  if (explicitWorkspaceId) {
    const workspace = input.workspaces.find(
      (candidate) => candidate.id === explicitWorkspaceId && candidate.available && !candidate.incognitoActive,
    );
    if (workspace) {
      return {
        kind: 'create_work',
        workspaceId: workspace.id,
        title: deriveWorkTitle(input.input.text),
        route: routeTrace('explicit', 1, [`用户明确选择了 ${workspace.name}`]),
      };
    }
  }
  if (replyToBlockId) {
    const bound = input.snapshot.items.find(
      (item) => item.kind === 'work' && item.block.id === replyToBlockId,
    );
    if (bound?.kind === 'work') {
      return {
        kind: 'resume_work',
        work: bound.block.work,
        route: routeTrace('explicit', 1, ['消息回复绑定到已有工作气泡']),
      };
    }
  }

  const text = input.input.text.trim();
  if (isInteractionReply(text)) {
    const waiting = input.snapshot.items.flatMap((item) =>
      item.kind === 'work' && item.block.status === 'waiting_for_user' ? [item.block] : [],
    );
    if (waiting.length > 0) {
      const scope = waiting.length === 1
        ? `${waiting[0]!.workspaceName} / ${waiting[0]!.workName}`
        : waiting.map((block) => `${block.workspaceName} / ${block.workName}`).join('、');
      return {
        kind: 'clarify',
        options: waiting.map((block, index) => ({
          id: `waiting-${index}`,
          kind: 'work' as const,
          workspaceId: block.work.workspaceId,
          workspaceName: block.workspaceName,
          work: block.work,
          workName: block.workName,
          reason: '正在等待你的决定',
        })),
        question: waiting.length === 1
          ? `“${text}”是回答 ${scope} 吗？请在该工作的交互卡片中确认。`
          : `目前有多项工作等待你的决定：${scope}。你指的是哪一项？`,
        route: routeTrace('interaction', 1, ['存在等待用户输入的工作']),
      };
    }
  }
  if (!looksExecutable(text)) {
    return {
      kind: 'discussion',
      route: routeTrace('fallback', 0.72, ['未发现明确执行意图']),
    };
  }

  const unavailableMatches = input.workspaces
    .filter((workspace) => !workspace.available && !workspace.incognitoActive)
    .map((workspace) => ({ workspace, score: workspaceMatchScore(text, workspace) }))
    .filter((entry) => entry.score >= 10)
    .sort((left, right) => right.score - left.score);
  if (unavailableMatches[0] && unavailableMatches[0].score !== unavailableMatches[1]?.score) {
    return { kind: 'relink_workspace', workspaceId: unavailableMatches[0].workspace.id };
  }

  const available = input.workspaces.filter(
    (workspace) => workspace.available && !workspace.incognitoActive,
  );
  if (available.length === 0) return { kind: 'register_workspace' };

  const coordination = detectCoordination(text, available, input.candidates);
  if (coordination) return { kind: 'coordinate', steps: coordination };

  const rankedCandidates = input.candidates
    .map((candidate) => ({ candidate, score: candidateMatchScore(text, candidate) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.updatedAt - left.candidate.updatedAt ||
        left.candidate.work.sessionId.localeCompare(right.candidate.work.sessionId),
    );
  const best = rankedCandidates[0];
  const second = rankedCandidates[1];
  const margin = best ? best.score - (second?.score ?? 0) : 0;
  if (best && best.score >= 3 && (!second || margin >= 2)) {
    return {
      kind: 'resume_work',
      work: best.candidate.work,
      route: routeTrace('lexical', Math.min(0.96, 0.68 + margin * 0.06), [
        `语义名片匹配 ${best.candidate.workspaceName} / ${best.candidate.workName}`,
        `领先候选 ${margin} 分`,
      ]),
    };
  }
  if (best && best.score >= 2) {
    return {
      kind: 'clarify',
      options: rankedCandidates.slice(0, 3).map((entry, index) =>
        workRouteOption(entry.candidate, `candidate-${index}`, `匹配分 ${entry.score}`)),
      question: '我找到了几项相近的工作。你指的是哪一项？',
      route: routeTrace('lexical', 0.45, ['候选领先幅度不足，避免静默绑定']),
    };
  }

  const focused = input.snapshot.workFocus;
  if (focused && isFollowUp(text)) {
    return {
      kind: 'resume_work',
      work: focused,
      route: routeTrace('focus', 0.9, ['输入是承接表达，使用最近聚焦工作']),
    };
  }

  const workspaceScores = available
    .map((workspace) => ({ workspace, score: lexicalScore(text, `${workspace.name} ${workspace.path}`) }))
    .sort((left, right) => right.score - left.score || left.workspace.id.localeCompare(right.workspace.id));
  const topWorkspace = workspaceScores[0];
  const nextWorkspace = workspaceScores[1];
  if ((!topWorkspace || topWorkspace.score === 0) && mentionsWorkspaceScope(text)) {
    return { kind: 'register_workspace', hint: text };
  }
  if (
    available.length > 1 &&
    (!topWorkspace || topWorkspace.score === 0 || topWorkspace.score === nextWorkspace?.score)
  ) {
    return {
      kind: 'clarify',
      options: available.map((workspace, index) => ({
        id: `project-${index}`,
        kind: 'new_work' as const,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        reason: '在此 Project 中创建新工作',
      })),
      question: '这项工作要在哪个 Project 中进行？请说出项目名或相关文件。',
      route: routeTrace('fallback', 0.35, ['多个 Project 同样可能']),
    };
  }
  const workspaceId = topWorkspace?.workspace.id ?? available[0]!.id;
  return {
    kind: 'create_work',
    workspaceId,
    title: deriveWorkTitle(text),
    route: routeTrace(
      topWorkspace?.score ? 'lexical' : 'fallback',
      topWorkspace?.score ? 0.86 : 0.62,
      [topWorkspace?.score ? `匹配 Project ${topWorkspace.workspace.name}` : '当前只有一个可用 Project'],
    ),
  };
}

const FOLLOW_UP_PATTERNS = [
  /^(?:继续|接着|再|然后|顺便|把它|这个|那就)/u,
  /^(?:continue|then|also|now|do it|that)\b/iu,
];

function isFollowUp(text: string): boolean {
  return FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text));
}

function isInteractionReply(text: string): boolean {
  return /^(?:可以|同意|允许|继续|是|否|好的|确认|ok|okay|yes|no|allow|continue)[。.!！]?$/iu.test(text);
}

function lexicalScore(query: string, candidate: string): number {
  const target = candidate.toLocaleLowerCase();
  let score = 0;
  for (const token of tokenize(query)) {
    if (target.includes(token)) score += token.length >= 4 ? 2 : 1;
  }
  return score;
}

function candidateMatchScore(query: string, candidate: WorkCandidate): number {
  const card = candidate.semanticCard;
  return (
    lexicalScore(query, candidate.workName) * 4 +
    lexicalScore(query, card?.objective ?? candidate.searchableText) * 3 +
    lexicalScore(query, card?.terms.join(' ') ?? '') * 2 +
    lexicalScore(query, card?.recentOutcome ?? '')
  );
}

function routeTrace(
  resolver: UnifiedRouteTrace['resolver'],
  confidence: number,
  evidence: string[],
): UnifiedRouteTrace {
  return {
    resolver,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence: evidence.slice(0, 4),
  };
}

function workRouteOption(
  candidate: WorkCandidate,
  id: string,
  reason = '继续这项工作',
): UnifiedRouteOption {
  return {
    id,
    kind: 'work',
    workspaceId: candidate.work.workspaceId,
    workspaceName: candidate.workspaceName,
    work: candidate.work,
    workName: candidate.workName,
    reason,
  };
}

function tokenize(text: string): string[] {
  const latin = text.toLocaleLowerCase().match(/[a-z0-9_./-]{2,}/giu) ?? [];
  const chineseRuns = text.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    const points = [...run];
    const grams: string[] = [];
    for (const size of [2, 3, 4]) {
      for (let index = 0; index + size <= points.length; index += 1) {
        grams.push(points.slice(index, index + size).join(''));
      }
    }
    return grams;
  });
  return [...new Set([...latin, ...chinese])].slice(0, 128);
}

function deriveWorkTitle(text: string): string {
  const title = text.replace(/[。！？!?]+$/u, '').trim();
  return [...title].slice(0, 40).join('') || '新工作';
}

function mentionsWorkspaceScope(text: string): boolean {
  return /(?:项目|工程|代码库|仓库|\bworkspace\b|\bproject\b|\brepo(?:sitory)?\b)/iu.test(text);
}

const SEQUENCE_CONNECTOR = /(?:然后|之后|接着|随后|再由|再在|再去|\bthen\b|\bafter that\b|\bnext\b)/iu;
const COORDINATION_BOUNDARY = /(?:[,，;；。]\s*|然后|之后|接着|随后|再由|再在|再去|\bthen\b|\bafter that\b|\bnext\b)/iu;

function detectCoordination(
  text: string,
  workspaces: UnifiedWorkspaceSummary[],
  candidates: WorkCandidate[],
): UnifiedCoordinationDraftStep[] | undefined {
  const segments = text.split(COORDINATION_BOUNDARY).map((segment) => segment.trim()).filter(Boolean);
  const sequential = SEQUENCE_CONNECTOR.test(text);
  const selected: Array<{
    segment: string;
    workspace: UnifiedWorkspaceSummary;
    targetWork?: WorkRef;
    title?: string;
  }> = [];
  for (const segment of segments) {
    const rankedWorkspaces = workspaces
      .map((workspace) => ({ workspace, score: workspaceMatchScore(segment, workspace) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.workspace.id.localeCompare(right.workspace.id));
    const rankedCandidates = candidates
      .map((candidate) => ({
        candidate,
        score: lexicalScore(segment, candidate.workName) * 3 + candidateMatchScore(segment, candidate),
      }))
      .filter((entry) => entry.score >= 3)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.candidate.updatedAt - left.candidate.updatedAt ||
          left.candidate.work.sessionId.localeCompare(right.candidate.work.sessionId),
      );
    const explicitWorkspace = rankedWorkspaces[0]?.score >= 10 &&
      rankedWorkspaces[0].score !== rankedWorkspaces[1]?.score
      ? rankedWorkspaces[0].workspace
      : undefined;
    const matchingCandidate = rankedCandidates.find(
      (entry) => !explicitWorkspace || entry.candidate.work.workspaceId === explicitWorkspace.id,
    );
    const uniqueCandidate = matchingCandidate &&
      !rankedCandidates.some(
        (entry) =>
          entry !== matchingCandidate &&
          entry.score === matchingCandidate.score &&
          entry.candidate.work.workspaceId !== matchingCandidate.candidate.work.workspaceId,
      )
      ? matchingCandidate.candidate
      : undefined;
    const workspace = explicitWorkspace ?? (
      uniqueCandidate
        ? workspaces.find((candidate) => candidate.id === uniqueCandidate.work.workspaceId)
        : rankedWorkspaces[0]?.score !== rankedWorkspaces[1]?.score
          ? rankedWorkspaces[0]?.workspace
          : undefined
    );
    if (!workspace) continue;
    selected.push({
      segment,
      workspace,
      ...(uniqueCandidate ? { targetWork: uniqueCandidate.work, title: uniqueCandidate.workName } : {}),
    });
  }

  if (new Set(selected.map((entry) => entry.workspace.id)).size < 2) {
    const named = workspaces.filter((workspace) => workspaceMatchScore(text, workspace) >= 10);
    if (named.length < 2) return undefined;
    selected.splice(0, selected.length, ...named.map((workspace) => ({ segment: text, workspace })));
  }

  return selected.map((entry, index) => ({
    workspaceId: entry.workspace.id,
    workspaceName: entry.workspace.name,
    title: entry.title ?? deriveWorkTitle(entry.segment),
    prompt: entry.segment,
    ...(entry.targetWork ? { targetWork: entry.targetWork } : {}),
    dependsOnStepIndexes: sequential && index > 0 ? [index - 1] : [],
  }));
}

function workspaceMatchScore(text: string, workspace: UnifiedWorkspaceSummary): number {
  const normalized = text.toLocaleLowerCase();
  const name = workspace.name.trim().toLocaleLowerCase();
  const exactNameScore = name && normalized.includes(name) ? 10 : 0;
  return exactNameScore + lexicalScore(text, `${workspace.name} ${workspace.path}`);
}
