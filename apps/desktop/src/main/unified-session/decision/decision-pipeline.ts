import { workRefKey } from '@maka/core/unified-session';
import type {
  ActionGate,
  ActionPolicy,
  DecisionPipeline,
  DecisionTrace,
  IntentClassifier,
  WorkRetriever,
} from './decision-types.js';

export function createDecisionPipeline(deps: {
  intentClassifier: IntentClassifier;
  workRetriever: WorkRetriever;
  actionPolicy: ActionPolicy;
  actionGate: ActionGate;
  onTrace?: (trace: DecisionTrace) => void;
}): DecisionPipeline {
  return {
    async decide(context) {
      const intent = deps.intentClassifier.classify(context);
      const recall = await deps.workRetriever.recall(intent, context);
      const proposal = await deps.actionPolicy.select(intent, recall, context);
      const decision = await deps.actionGate.evaluate(proposal, recall, context);
      const trace: DecisionTrace = {
        policyVersion: 'workhub-decision-v1',
        intent: intent.kind,
        recalledCandidateIds: recall.candidates.map((candidate) => workRefKey(candidate.work)),
        proposedAction: proposal.kind,
        gateDecision: decision.kind,
        evidence: [
          ...intent.evidence,
          ...('route' in proposal ? (proposal.route?.evidence ?? []) : []),
          ...decision.evidence,
        ]
          .slice(0, 12),
      };
      try {
        deps.onTrace?.(trace);
      } catch {
        // Observability must not alter a routing result or authorize execution.
      }
      return { decision, recall, trace };
    },
  };
}
