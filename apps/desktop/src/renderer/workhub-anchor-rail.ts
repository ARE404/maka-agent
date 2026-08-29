/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { WorkHubSessionSummary } from "./workhub-controller.js";

export type WorkHubWorkFilter = "all" | "active" | "attention" | "stopped";
export type WorkHubAnchorReason = "focus" | "delegated" | "recent";

export interface WorkHubAnchor {
  readonly session: WorkHubSessionSummary;
  readonly reason: WorkHubAnchorReason;
}

export const MAX_WORKHUB_ANCHORS = 8;

/**
 * Bounded, rebuildable navigation projection. It never changes the routing
 * candidate set and owns no Session or delegation state.
 */
export function deriveWorkHubAnchors(input: {
  readonly sessions: readonly WorkHubSessionSummary[];
  readonly focusSessionId?: string;
  readonly delegatedSessionIds: readonly string[];
  readonly filter: WorkHubWorkFilter;
  readonly limit?: number;
}): WorkHubAnchor[] {
  const limit = Math.max(
    0,
    Math.min(input.limit ?? MAX_WORKHUB_ANCHORS, MAX_WORKHUB_ANCHORS),
  );
  const sessionById = new Map(
    input.sessions.map((session) => [session.target.sessionId, session]),
  );
  const ordered: WorkHubAnchor[] = [];
  const seen = new Set<string>();
  const append = (
    sessionId: string | undefined,
    reason: WorkHubAnchorReason,
  ) => {
    if (!sessionId || seen.has(sessionId)) return;
    const session = sessionById.get(sessionId);
    if (!session || !matchesWorkHubFilter(session, input.filter)) return;
    seen.add(sessionId);
    ordered.push({ session, reason });
  };

  append(input.focusSessionId, "focus");
  for (const sessionId of input.delegatedSessionIds)
    append(sessionId, "delegated");
  for (const session of [...input.sessions].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  )) {
    append(session.target.sessionId, "recent");
  }
  return ordered.slice(0, limit);
}

export function matchesWorkHubFilter(
  session: WorkHubSessionSummary,
  filter: WorkHubWorkFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "active")
    return (
      !session.archived &&
      (session.state === "active" || session.state === "running")
    );
  if (filter === "attention")
    return (
      !session.archived &&
      (session.state === "waiting_for_user" || session.state === "blocked")
    );
  return session.archived || session.state === "aborted";
}
