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

import { useState } from 'react';
import {
  deriveWorkHubAnchors,
  matchesWorkHubFilter,
  type WorkHubAnchorSession,
  type WorkHubWorkFilter,
} from '../model/anchor-rail.js';

export interface WorkHubNavigationRailCopy {
  readonly work: string;
  readonly workNavigation: string;
  readonly filterWork: string;
  readonly focused: string;
  readonly archived: string;
  readonly states: Readonly<Record<WorkHubAnchorSession['state'], string>>;
  readonly filteredWorkCount: (visible: number, total: number) => string;
  readonly noFilteredWork: string;
  readonly filters: ReadonlyArray<{
    readonly id: WorkHubWorkFilter;
    readonly label: string;
  }>;
}

export function WorkHubNavigationRail(props: {
  readonly sessions: readonly WorkHubAnchorSession[];
  readonly focusSessionId?: string;
  readonly delegatedSessionIds: readonly string[];
  readonly copy: WorkHubNavigationRailCopy;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const [filter, setFilter] = useState<WorkHubWorkFilter>('all');
  const anchors = deriveWorkHubAnchors({
    sessions: props.sessions,
    focusSessionId: props.focusSessionId,
    delegatedSessionIds: props.delegatedSessionIds,
    filter,
  });
  const filteredWorkCount = props.sessions.filter((session) =>
    matchesWorkHubFilter(session, filter)).length;

  return (
    <aside className="workhub-anchor-rail" aria-label={props.copy.workNavigation}>
      <div className="workhub-anchor-heading">
        <strong>{props.copy.work}</strong>
        <span>{props.copy.filteredWorkCount(filteredWorkCount, props.sessions.length)}</span>
      </div>
      <div className="workhub-filters" role="toolbar" aria-label={props.copy.filterWork}>
        {props.copy.filters.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            aria-pressed={filter === candidate.id}
            onClick={() => setFilter(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <nav className="workhub-anchors" aria-label={props.copy.workNavigation}>
        {anchors.length > 0 ? anchors.map((anchor) => {
          const state = anchor.session.archived
            ? props.copy.archived
            : props.copy.states[anchor.session.state];
          return (
            <button
              key={anchor.session.target.sessionId}
              type="button"
              aria-current={anchor.reason === 'focus' ? 'page' : undefined}
              data-state={anchor.session.archived ? 'archived' : anchor.session.state}
              onClick={() => props.onOpenSession(anchor.session.target.sessionId)}
            >
              <span className="workhub-anchor-title">
                <span className="workhub-anchor-state" aria-hidden="true" />
                <strong>{anchor.session.sessionName}</strong>
              </span>
              <small>
                {anchor.reason === 'focus' ? props.copy.focused : anchor.session.projectName}
                {' · '}{state}
              </small>
            </button>
          );
        }) : (
          <p className="workhub-anchor-empty">{props.copy.noFilteredWork}</p>
        )}
      </nav>
    </aside>
  );
}

