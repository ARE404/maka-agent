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

import { useContext, useMemo, type ComponentProps, type CSSProperties } from 'react';
import { ChatView, useUiLocale } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import { Button } from '@astryxdesign/core';
import { WorkHubHighlightContext, workHubIdentityHue } from './workhub-work-identity.js';
import type { WorkHubLinkedWork } from '../model/linked-work.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

export function WorkHubResultCard(props: {
  work: WorkHubLinkedWork;
  locale: UiLocale;
  highlighted: boolean;
  onHighlight(highlighted: boolean): void;
  onOpenWork(sessionId: string): void;
}) {
  const { work } = props;
  const copy = workHubLiveCopy[props.locale];
  const state = work.state ?? 'accepted';
  const stateLabel = {
    accepted: copy.delegationAccepted,
    running: copy.delegationRunning,
    waiting_for_user: copy.delegationWaiting,
    completed: copy.delegationCompleted,
    failed: copy.delegationFailed,
    aborted: copy.delegationAborted,
    recovering: copy.delegationRecovering,
  }[state];
  return <div className="workhub-message-identity workhub-work-identity"
    style={{ '--workhub-work-hue': workHubIdentityHue(work.targetSessionId) } as CSSProperties}
    data-work-session-id={work.targetSessionId}
    data-work-highlighted={props.highlighted}
    data-work-state={state}
    onMouseEnter={() => props.onHighlight(true)}
    onMouseLeave={() => props.onHighlight(false)}
    onFocus={() => props.onHighlight(true)}
    onBlur={() => props.onHighlight(false)}>
    <div className="workhub-result-card">
      <div className="workhub-result-heading">
        <strong>{work.workspaceName ? `${work.workspaceName} / ` : ''}{work.targetSessionName}</strong>
        <span role="status">{stateLabel}</span>
      </div>
      {work.resultPreview ? <p>{work.resultPreview}</p> : null}
      <Button
        variant="ghost"
        label={work.resultPreview ? copy.openResult : copy.openWork}
        onClick={() => props.onOpenWork(work.targetSessionId)}
      />
    </div>
  </div>;
}

export function WorkHubConversation(props: ComponentProps<typeof ChatView> & { workLinks: readonly WorkHubLinkedWork[]; onOpenWork(sessionId: string): void }) {
  const { onOpenWork, workLinks: assignments, ...chat } = props;
  const highlight = useContext(WorkHubHighlightContext);
  const locale = useUiLocale();
  // A coordination turn can delegate to several Works. Keep every label and
  // leave its shared bar neutral rather than attributing the entire turn to one.
  const worksByTurn = useMemo(() => {
    const grouped = new Map<string, WorkHubLinkedWork[]>();
    for (const work of assignments) {
      const works = grouped.get(work.coordinationTurnId) ?? [];
      if (!works.some((item) => item.targetSessionId === work.targetSessionId)) works.push(work);
      grouped.set(work.coordinationTurnId, works);
    }
    return grouped;
  }, [assignments]);
  const workByTurn = useMemo(() => new Map([...worksByTurn].flatMap(([turnId, works]) =>
    works.length === 1 ? [[turnId, works[0]!.targetSessionId] as const] : [])), [worksByTurn]);
  const promptRailDecorations = useMemo(() => new Map([...workByTurn].map(([turnId, sessionId]) => [turnId, {
    accentColor: `oklch(var(--workhub-${highlight.sessionId === sessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(sessionId)})`,
    highlighted: highlight.sessionId === sessionId,
  }])), [workByTurn, highlight.sessionId]);
  const turnDecorations = new Map([...worksByTurn].map(([turnId, works]) => [turnId, {
    accentColor: promptRailDecorations.get(turnId)?.accentColor,
    header: <div className="workhub-turn-heading">
      {works.map((work) => <Button
        key={work.targetSessionId}
        variant="ghost"
        className="workhub-work-identity workhub-turn-label"
        style={{ '--workhub-work-hue': workHubIdentityHue(work.targetSessionId) } as CSSProperties}
        data-work-session-id={work.targetSessionId}
        data-work-highlighted={highlight.sessionId === work.targetSessionId}
        label={work.workspaceName ? `${work.workspaceName} / ${work.targetSessionName}` : work.targetSessionName}
        onMouseEnter={() => highlight.highlight(work.targetSessionId)}
        onMouseLeave={() => highlight.highlight(undefined)}
        onFocus={() => highlight.highlight(work.targetSessionId)}
        onBlur={() => highlight.highlight(undefined)}
        onClick={() => onOpenWork(work.targetSessionId)}
      />)}
    </div>,
  }]));
  return <ChatView {...chat}
    turnDecorations={turnDecorations}
    promptRailDecorations={promptRailDecorations}
    onPromptRailHighlight={(turnId) => highlight.highlight(turnId ? workByTurn.get(turnId) : undefined)}
    conversationItems={assignments.map((assignment) => ({
      id: assignment.id,
      afterTurnId: assignment.coordinationTurnId,
      renderWhenAnchorMissing: true,
      content: <WorkHubResultCard
        work={assignment}
        locale={locale}
        highlighted={highlight.sessionId === assignment.targetSessionId}
        onHighlight={(active) => highlight.highlight(active ? assignment.targetSessionId : undefined)}
        onOpenWork={onOpenWork}
      />,
    }))}
  />;
}
