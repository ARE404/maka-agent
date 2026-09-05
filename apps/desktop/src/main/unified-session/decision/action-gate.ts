import type { WorkRef } from '@maka/core/unified-session';
import type { ActionGate, ActionProposal, GateDecision, WorkRecall } from './decision-types.js';

export function createActionGate(): ActionGate {
  return {
    async evaluate(proposal, recall) {
      if (proposal.kind === 'clarify') {
        return { kind: 'clarify', proposal, evidence: ['policy requested clarification'] };
      }
      if (
        proposal.kind === 'discussion' ||
        proposal.kind === 'register_workspace' ||
        proposal.kind === 'relink_workspace'
      ) {
        return {
          kind: 'block',
          proposal,
          reason: 'non_executable',
          evidence: ['proposal does not authorize execution'],
        };
      }
      if (proposal.kind === 'create_work') {
        const host = availableHost(recall, proposal.workspaceId);
        if (!host) return unavailableWorkspaceDecision();
        return {
          kind: 'allow',
          action: { kind: 'create_work', proposal, host },
          evidence: ['Workspace is available and routable'],
        };
      }
      if (proposal.kind === 'resume_work') {
        const host = availableHost(recall, proposal.work.workspaceId);
        if (!host) return unavailableWorkspaceDecision();
        const candidate = findCandidate(recall, proposal.work) ??
          await host.findWork(proposal.work.sessionId).catch(() => undefined);
        if (!candidate || !sameWork(candidate.work, proposal.work)) {
          return unavailableTargetDecision();
        }
        return {
          kind: 'allow',
          action: { kind: 'resume_work', proposal, host, candidate },
          evidence: ['target Work exists in the selected Workspace'],
        };
      }
      for (const step of proposal.steps) {
        const host = availableHost(recall, step.workspaceId);
        if (!host) return unavailableWorkspaceDecision();
        if (step.targetWork) {
          const candidate = findCandidate(recall, step.targetWork) ??
            await host.findWork(step.targetWork.sessionId).catch(() => undefined);
          if (!candidate || !sameWork(candidate.work, step.targetWork)) {
            return unavailableTargetDecision();
          }
        }
      }
      return {
        kind: 'allow',
        action: { kind: 'coordinate', proposal },
        evidence: ['all coordination targets are available and bounded'],
      };
    },
  };
}

function availableHost(recall: WorkRecall, workspaceId: string) {
  const workspace = recall.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace?.available || workspace.incognitoActive) return undefined;
  return recall.hosts.get(workspaceId);
}

function findCandidate(recall: WorkRecall, work: WorkRef) {
  return recall.candidates.find((candidate) => sameWork(candidate.work, work));
}

function sameWork(left: WorkRef, right: WorkRef): boolean {
  return left.workspaceId === right.workspaceId && left.sessionId === right.sessionId;
}

function unavailableWorkspaceDecision(): GateDecision {
  return {
    kind: 'block',
    proposal: { kind: 'register_workspace' },
    reason: 'workspace_unavailable',
    evidence: ['Workspace is unavailable, private, or unknown'],
  };
}

function unavailableTargetDecision(): GateDecision {
  return {
    kind: 'block',
    proposal: { kind: 'register_workspace' },
    reason: 'target_unavailable',
    evidence: ['target Work is not present in the bounded recall set or Workspace'],
  };
}
