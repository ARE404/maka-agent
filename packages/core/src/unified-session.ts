import type { PermissionMode } from './permission.js';

export const UNIFIED_INTERNAL_SESSION_LABEL = 'maka:unified-internal';

/** Stable identity for a Work whose Session id is only unique inside one Workspace. */
export interface WorkRef {
  workspaceId: string;
  sessionId: string;
}

export interface UnifiedWorkspaceSummary {
  id: string;
  name: string;
  path: string;
  available: boolean;
  incognitoActive: boolean;
}

export type UnifiedWorkStatus =
  | 'queued'
  | 'routing'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stopped';

export interface UnifiedWorkBlock {
  id: string;
  work: WorkRef;
  workspaceName: string;
  workName: string;
  prompt: string;
  permissionMode: PermissionMode;
  status: UnifiedWorkStatus;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  detail?: string;
  createdNew?: boolean;
  resumedFromArchive?: boolean;
  reroutedFromBlockId?: string;
  route?: UnifiedRouteTrace;
  background?: {
    summary: string;
    sourceDiscussionMessageIds: string[];
  };
}

export interface UnifiedRouteTrace {
  resolver: 'explicit' | 'interaction' | 'lexical' | 'focus' | 'model' | 'fallback';
  confidence: number;
  evidence: string[];
}

export interface UnifiedRouteOption {
  id: string;
  kind: 'work' | 'new_work';
  workspaceId: string;
  workspaceName: string;
  work?: WorkRef;
  workName?: string;
  reason?: string;
}

export interface UnifiedWorkToolProjection {
  id: string;
  name: string;
  settled: boolean;
  failed: boolean;
}

/** Reconstructed from the target Session authority; never persisted by Unified. */
export interface UnifiedWorkContentProjection {
  text: string;
  tools: UnifiedWorkToolProjection[];
}

export interface UnifiedWorkEndedEvent {
  blockId: string;
  work: WorkRef;
  workspaceName: string;
  workName: string;
  status: 'completed' | 'failed' | 'blocked';
  detail?: string;
}

export interface UnifiedDiscussionMessage {
  id: string;
  kind: 'discussion';
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  status?: 'running' | 'completed' | 'failed';
  replyToMessageId?: string;
  route?: UnifiedRouteTrace;
  action?:
    | { kind: 'register_workspace' }
    | { kind: 'relink_workspace'; workspaceId: string }
    | {
        kind: 'clarify';
        originalText: string;
        options: UnifiedRouteOption[];
        resolved?: boolean;
        replacesBlockId?: string;
      };
}

export interface UnifiedWorkBlockItem {
  id: string;
  kind: 'work';
  block: UnifiedWorkBlock;
}

export type UnifiedLifecycleStatus = 'completed' | 'blocked' | 'waiting_for_user';

export interface UnifiedLifecycleEventItem {
  id: string;
  kind: 'lifecycle';
  work: WorkRef;
  workspaceName: string;
  workName: string;
  status: UnifiedLifecycleStatus;
  createdAt: number;
}

export type UnifiedCoordinationStatus =
  | 'awaiting_confirmation'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface UnifiedCoordinationStep {
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  status: UnifiedWorkStatus;
  targetWork?: WorkRef;
  work?: WorkRef;
  blockId?: string;
}

export interface UnifiedCoordinationPlan {
  id: string;
  prompt: string;
  status: UnifiedCoordinationStatus;
  steps: UnifiedCoordinationStep[];
  createdAt: number;
  updatedAt: number;
}

export interface UnifiedCoordinationPlanItem {
  id: string;
  kind: 'coordination';
  plan: UnifiedCoordinationPlan;
}

export interface UnifiedCoordinationDraftStep {
  workspaceId: string;
  workspaceName: string;
  title: string;
  prompt: string;
  targetWork?: WorkRef;
  dependsOnStepIndexes: number[];
}

export type UnifiedConversationItem =
  | UnifiedDiscussionMessage
  | UnifiedWorkBlockItem
  | UnifiedLifecycleEventItem
  | UnifiedCoordinationPlanItem;

export interface UnifiedSnapshot {
  revision: number;
  items: UnifiedConversationItem[];
  workFocus?: WorkRef;
}

export type UnifiedIntentDisposition =
  | { kind: 'discussion'; route?: UnifiedRouteTrace }
  | { kind: 'clarify'; options: UnifiedRouteOption[]; question: string; route?: UnifiedRouteTrace }
  | { kind: 'resume_work'; work: WorkRef; route?: UnifiedRouteTrace }
  | { kind: 'create_work'; workspaceId: string; title: string; route?: UnifiedRouteTrace }
  | { kind: 'coordinate'; steps: UnifiedCoordinationDraftStep[] }
  | { kind: 'relink_workspace'; workspaceId: string }
  | { kind: 'register_workspace'; hint?: string };

export interface UnifiedSendInput {
  text: string;
  replyToBlockId?: string;
  explicitWork?: WorkRef;
  explicitWorkspaceId?: string;
  sourceClarificationMessageId?: string;
  replacesBlockId?: string;
}

export type UnifiedSendResult =
  | { kind: 'discussion'; messageId: string }
  | { kind: 'clarify'; messageId: string; options: UnifiedRouteOption[] }
  | { kind: 'work'; block: UnifiedWorkBlock }
  | { kind: 'coordination'; plan: UnifiedCoordinationPlan }
  | { kind: 'register_workspace'; messageId: string };

export type UnifiedCommand =
  | { kind: 'send'; input: UnifiedSendInput }
  | { kind: 'set_permission'; work: WorkRef; mode: PermissionMode }
  | { kind: 'stop_work'; work: WorkRef }
  | { kind: 'confirm_coordination'; planId: string }
  | { kind: 'cancel_coordination'; planId: string };

export function workRefKey(work: WorkRef): string {
  return `${encodeURIComponent(work.workspaceId)}:${encodeURIComponent(work.sessionId)}`;
}

export function sameWorkRef(left: WorkRef | undefined, right: WorkRef | undefined): boolean {
  return Boolean(
    left && right && left.workspaceId === right.workspaceId && left.sessionId === right.sessionId,
  );
}
