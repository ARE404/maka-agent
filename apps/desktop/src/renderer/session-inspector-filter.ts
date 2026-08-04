import type { TraceStep } from '@maka/core/session-trace';
import type { InspectorPanelModel, InspectorStepRow, InspectorTurnRow } from './session-inspector-panel-model.js';

/**
 * Filtering the Inspector timeline (#1625).
 *
 * Pure predicates over the projected trace, deliberately not a query API on the
 * contract: the questions a reader actually asks — "which tool failed", "what
 * cost more than a cent", "where did it compact" — are `Array.filter` over
 * `TraceStep[]`, and inventing a query language for them would be surface
 * nobody needs.
 *
 * Free text matches what the panel renders — tool names, model ids, turn ids,
 * error messages, recovery dispositions. It deliberately does **not** reach
 * into event bodies: that is `searchRuntimeEventHistory`'s job, and shipping
 * every tool result into the renderer to fake it here would multiply a payload
 * this panel is already asked to bound, with silent truncation as the only way
 * out. A filter that quietly stops matching is worse than one with a stated
 * reach.
 */
export interface InspectorFilter {
  /** Case-insensitive substring over the rendered fields. */
  query?: string;
  /** Restrict to these step kinds; empty or absent means every kind. */
  kinds?: readonly TraceStep['kind'][];
  /** Only turns that failed, and within them every step. */
  failedOnly?: boolean;
  /** Only priced steps at or above this amount. Unpriced steps never match. */
  minCostUsd?: number;
}

export interface FilteredInspectorModel extends InspectorPanelModel {
  /**
   * Whether a filter is narrowing the view. Kept separate from `empty` so the
   * panel can say "nothing matches" instead of "nothing happened" — a filtered
   * timeline that reads as an idle session is the same lie as an unreported
   * coverage gap, one layer up.
   */
  filtered: boolean;
  /** Turns present in the trace but hidden by the filter. */
  hiddenTurns: number;
  /** Steps hidden inside the turns that still render. */
  hiddenSteps: number;
}

export function isEmptyInspectorFilter(filter: InspectorFilter | undefined): boolean {
  if (!filter) return true;
  return (
    !filter.query?.trim() &&
    (filter.kinds === undefined || filter.kinds.length === 0) &&
    !filter.failedOnly &&
    filter.minCostUsd === undefined
  );
}

export function applyInspectorFilter(
  model: InspectorPanelModel,
  filter: InspectorFilter | undefined,
): FilteredInspectorModel {
  if (isEmptyInspectorFilter(filter)) {
    return { ...model, filtered: false, hiddenTurns: 0, hiddenSteps: 0 };
  }
  const active = filter!;
  const query = active.query?.trim().toLowerCase();

  let hiddenSteps = 0;
  const turns: InspectorTurnRow[] = [];
  for (const turn of model.turns) {
    if (active.failedOnly && !turn.failed) continue;
    const steps = turn.steps.filter((step) => matchesStep(step, turn, active, query));
    // A turn whose own identity matches keeps its place even with no matching
    // step: hiding it would answer "where is turn-7" with silence.
    const turnMatches = query !== undefined && turn.turnId.toLowerCase().includes(query);
    if (steps.length === 0 && !turnMatches) continue;
    hiddenSteps += turn.steps.length - steps.length;
    turns.push({ ...turn, steps });
  }

  return {
    ...model,
    turns,
    filtered: true,
    hiddenTurns: model.turns.length - turns.length,
    hiddenSteps,
    // `empty` stays a statement about the session, not about the filter. The
    // panel distinguishes the two; collapsing them here would make a narrow
    // filter indistinguishable from an empty session.
    empty: model.empty,
  };
}

function matchesStep(
  step: InspectorStepRow,
  turn: InspectorTurnRow,
  filter: InspectorFilter,
  query: string | undefined,
): boolean {
  if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(step.kind)) return false;
  if (filter.minCostUsd !== undefined) {
    // An unpriced step is not a cheap step. Excluding it from a cost threshold
    // is the same rule the ledger keeps: absent is not zero.
    if (step.costUsd === undefined || step.costUsd < filter.minCostUsd) return false;
  }
  if (filter.failedOnly && !turn.failed) return false;
  if (query === undefined || query === '') return true;
  return stepSearchText(step, turn).includes(query);
}

/** Exactly the fields the panel renders — the filter's reach is what you see. */
function stepSearchText(step: InspectorStepRow, turn: InspectorTurnRow): string {
  return [
    step.kind,
    step.label,
    step.detail,
    step.status,
    step.recovered,
    turn.turnId,
    turn.failureCode,
    turn.failureMessage,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}
