import type { PermissionMode } from '@maka/core/permission';
import type { SessionEvent } from '@maka/core/events';
import type { SandboxBoundaryResponse, UserQuestionResponse } from '@maka/core';
import type {
  UnifiedIntentDisposition,
  UnifiedSendInput,
  UnifiedSnapshot,
  UnifiedWorkBlock,
  UnifiedWorkContentProjection,
  UnifiedWorkspaceSummary,
  WorkRef,
} from '@maka/core/unified-session';

export interface WorkCandidate {
  work: WorkRef;
  workspaceName: string;
  workName: string;
  searchableText: string;
  semanticCard?: {
    objective: string;
    recentOutcome: string;
    terms: string[];
  };
  permissionMode: PermissionMode;
  archived: boolean;
  updatedAt: number;
}

export type UnifiedTargetEvent =
  | { kind: 'session_event'; event: SessionEvent }
  | { kind: 'started'; turnId: string }
  | { kind: 'waiting_for_user'; detail?: string }
  | { kind: 'running'; detail?: string }
  | { kind: 'completed'; detail?: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'blocked'; detail: string }
  | { kind: 'stopped'; detail?: string };

export interface WorkspaceHostPort {
  summary(): Promise<UnifiedWorkspaceSummary>;
  listWorkCandidates(query: string, limit: number): Promise<WorkCandidate[]>;
  findWork(sessionId: string): Promise<WorkCandidate | undefined>;
  createWork(input: { title: string; permissionMode: PermissionMode }): Promise<WorkCandidate>;
  restoreWork(work: WorkRef): Promise<void>;
  startTurn(
    work: WorkRef,
    text: string,
    onEvent: (event: UnifiedTargetEvent) => void,
  ): Promise<{ turnId: string }>;
  readWorkProjection(work: WorkRef, turnId: string): Promise<UnifiedWorkContentProjection>;
  inspectWork(work: WorkRef): Promise<UnifiedWorkBlock['status'] | undefined>;
  respondToSandboxBoundary(work: WorkRef, response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(work: WorkRef, response: UserQuestionResponse): Promise<void>;
  setPermissionMode(work: WorkRef, mode: PermissionMode): Promise<void>;
  stopWork(work: WorkRef): Promise<void>;
  relink?(): Promise<void>;
}

export interface WorkspaceHostDirectory {
  list(): Promise<WorkspaceHostPort[]>;
  get(workspaceId: string): Promise<WorkspaceHostPort | undefined>;
}

export interface UnifiedIntentResolverInput {
  input: UnifiedSendInput;
  snapshot: UnifiedSnapshot;
  workspaces: UnifiedWorkspaceSummary[];
  candidates: WorkCandidate[];
}

export type UnifiedIntentResolver = (
  input: UnifiedIntentResolverInput,
) => Promise<UnifiedIntentDisposition>;

export type IntentKind =
  | 'explicit_work'
  | 'explicit_workspace'
  | 'bound_reply'
  | 'interaction_reply'
  | 'executable'
  | 'discussion_candidate';

export interface IntentResult {
  kind: IntentKind;
  evidence: string[];
}

export interface DecisionContext {
  input: UnifiedSendInput;
  snapshot: UnifiedSnapshot;
}

export interface WorkRecall {
  workspaces: UnifiedWorkspaceSummary[];
  candidates: WorkCandidate[];
  hosts: Map<string, WorkspaceHostPort>;
}

export type ActionProposal = UnifiedIntentDisposition;

export type ExecutableAction =
  | {
      kind: 'resume_work';
      proposal: Extract<ActionProposal, { kind: 'resume_work' }>;
      host: WorkspaceHostPort;
      candidate: WorkCandidate;
    }
  | {
      kind: 'create_work';
      proposal: Extract<ActionProposal, { kind: 'create_work' }>;
      host: WorkspaceHostPort;
    }
  | {
      kind: 'coordinate';
      proposal: Extract<ActionProposal, { kind: 'coordinate' }>;
    };

export type GateDecision =
  | { kind: 'allow'; action: ExecutableAction; evidence: string[] }
  | {
      kind: 'clarify';
      proposal: Extract<ActionProposal, { kind: 'clarify' }>;
      evidence: string[];
    }
  | {
      kind: 'block';
      proposal: Exclude<
        ActionProposal,
        { kind: 'resume_work' | 'create_work' | 'coordinate' | 'clarify' }
      >;
      reason: 'non_executable' | 'workspace_unavailable' | 'target_unavailable';
      evidence: string[];
    };

export interface DecisionTrace {
  policyVersion: 'workhub-decision-v1';
  intent: IntentKind;
  recalledCandidateIds: string[];
  proposedAction: ActionProposal['kind'];
  gateDecision: GateDecision['kind'];
  evidence: string[];
}

export interface DecisionPipelineResult {
  decision: GateDecision;
  recall: WorkRecall;
  trace: DecisionTrace;
}

export interface IntentClassifier {
  classify(context: DecisionContext): IntentResult;
}

export interface WorkRetriever {
  recall(intent: IntentResult, context: DecisionContext): Promise<WorkRecall>;
}

export interface ActionPolicy {
  select(
    intent: IntentResult,
    recall: WorkRecall,
    context: DecisionContext,
  ): Promise<ActionProposal>;
}

export interface ActionGate {
  evaluate(
    proposal: ActionProposal,
    recall: WorkRecall,
    context: DecisionContext,
  ): Promise<GateDecision>;
}

export interface DecisionPipeline {
  decide(context: DecisionContext): Promise<DecisionPipelineResult>;
}
