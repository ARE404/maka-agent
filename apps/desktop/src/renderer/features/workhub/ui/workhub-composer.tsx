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

import { useRef, useState } from 'react';
import { Composer, useToast, type ComposerProps, type ChatModelChoice } from '@maka/ui';
import type { SessionSummary, WorkHubCreateDefaults } from '@maka/core/session';
import { isChatDefaultPermissionMode } from '@maka/core/settings';
import { useComposerAttachments } from '@maka/ui/use-composer-attachments';
import { toComposerIngestItems } from '@maka/ui/composer-attachments';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import type { AttachmentRef } from '@maka/core/events';
import { getDesktopConversationCopy } from '../../../locales/conversation-copy.js';
import { localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import type { UiLocale } from '@maka/core/ui-locale';
import { useWorkHubComposerServices } from '../services-context.js';
import { workHubIdentityHue } from './workhub-work-identity.js';

export interface WorkHubComposerServices {
  sessions: readonly SessionSummary[];
  modelChoices: ChatModelChoice[];
  defaults: WorkHubCreateDefaults;
  confirmBypass(): Promise<boolean>;
  onOpenModelSettings(): void;
}

export interface WorkHubComposerSelection {
  attachments?: AttachmentRef[];
  explicitTarget?: { sessionId: string };
  newWorkDefaults?: WorkHubCreateDefaults;
}

/** Bind the shared Composer to an explicit Work or to creation defaults. */
type WorkHubComposerProps = Omit<ComposerProps, 'onSend'> & {
  services?: WorkHubComposerServices;
  locale: UiLocale;
  attachmentScope?: string;
  onSend(text: string, selection: WorkHubComposerSelection, onAccepted?: () => void): Promise<boolean>;
};

export function WorkHubComposer(props: WorkHubComposerProps) {
  if (!props.services) return <Composer {...props} onSend={(text) => props.onSend(text, {})} />;
  return <ConfiguredWorkHubComposer {...props} />;
}

function ConfiguredWorkHubComposer({ services, locale, attachmentScope, onSend, ...composer }: WorkHubComposerProps) {
  const settings = useWorkHubComposerServices();
  const [selectedId, setSelectedId] = useState('');
  const [defaults, setDefaults] = useState<WorkHubCreateDefaults>(services?.defaults ?? {});
  const [changing, setChanging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const staged = useComposerAttachments({
    draftKey: `workhub:${attachmentScope}`,
    toastApi: toast,
    service: settings.attachments,
    copy: getDesktopConversationCopy(locale).actions,
    formatError: (error, fallback) => localizedShellErrorMessage(error, fallback, locale),
  });
  const uploaded = useRef(new Map<string, AttachmentRef>());
  const chinese = locale === 'zh-CN';
  const selected = services?.sessions.find((session) => session.id === selectedId);
  const unavailable = Boolean(selectedId && !selected);
  const defaultChoice = services?.modelChoices.find((choice) => defaults.model &&
    choice.connectionId === defaults.model.llmConnectionId && choice.connectionSlug === defaults.model.llmConnectionSlug && choice.model === defaults.model.model)
    ?? services?.modelChoices.find((choice) => choice.isDefault);
  const defaultModel = defaultChoice ? { llmConnectionId: defaultChoice.connectionId, llmConnectionSlug: defaultChoice.connectionSlug, model: defaultChoice.model } : undefined;
  const busy = changing || submitting || Boolean(composer.sendBlocked);
  const settingsLocked = busy || unavailable || selected?.status === 'running' || selected?.status === 'waiting_for_user';
  const change = async (operation: () => Promise<unknown>) => {
    setChanging(true);
    try { await operation(); }
    catch { toast.error(chinese ? '配置更新失败，请重试' : 'Could not update settings. Try again.'); }
    finally { setChanging(false); }
  };
  return <>
    <div className="workhub-composer-scope workhub-work-identity" style={selected ? { color: `oklch(var(--workhub-tone) ${workHubIdentityHue(selected.id)})` } : undefined}>
      <label>
        <span>{chinese ? '发送到' : 'Send to'}</span>
        <select aria-label={chinese ? '当前 Work' : 'Current Work'} value={selectedId} disabled={busy} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">{chinese ? '自动识别工作' : 'Route automatically'}</option>
          {unavailable ? <option value={selectedId}>{chinese ? '工作不可用' : 'Work unavailable'}</option> : null}
          {services?.sessions.filter((session) => !session.isArchived).map((session) => <option key={session.id} value={session.id}>{session.name || session.id}</option>)}
        </select>
      </label>
      <span>{selected ? (chinese ? '模型与权限用于此 Work' : 'Settings apply to this Work') : (chinese ? '模型与权限用于新 Work' : 'Settings apply to new Work')}</span>
    </div>
    <Composer {...composer}
      sendBlocked={busy || unavailable}
      allowAttachmentOnlySend
      pendingAttachments={staged.pendingAttachments}
      onPickAttachments={staged.pickAttachments}
      onAttachFilePaths={staged.attachFilePaths}
      onRemoveAttachment={staged.removeAttachment}
      onSend={async (text) => {
        const snapshot = [...staged.pendingAttachments];
        setSubmitting(true);
        try {
          if (snapshot.length > MAX_ATTACHMENT_COUNT || snapshot.some((item) => item.size > MAX_ATTACHMENT_BYTES)) {
            throw new Error(chinese ? '附件数量或大小超过限制' : 'Attachment count or size exceeds the limit');
          }
          const attachments: AttachmentRef[] = [];
          for (const item of snapshot) {
            let ref = uploaded.current.get(item.stagingKey);
            if (!ref) {
              [ref] = await settings.prepareAttachments(attachmentScope!, toComposerIngestItems([item]));
              if (!ref) throw new Error('Attachment upload did not return a reference');
              uploaded.current.set(item.stagingKey, ref);
            }
            attachments.push(ref);
          }
          const accepted = await onSend(text.trim() || (chinese ? '请查看附件。' : 'Please review the attachments.'), {
            ...(selectedId ? { explicitTarget: { sessionId: selectedId } } : { newWorkDefaults: { ...defaults, model: defaultModel } }),
            ...(attachments.length ? { attachments } : {}),
          }, () => {
            staged.clearSubmittedAttachments(snapshot);
            for (const item of snapshot) uploaded.current.delete(item.stagingKey);
          });
          return accepted;
        } catch (error) {
          toast.error(chinese ? '发送失败' : 'Could not send', localizedShellErrorMessage(error, chinese ? '请重试' : 'Try again', locale));
          return false;
        } finally { setSubmitting(false); }
      }}
      activeSession={selected}
      modelChoices={services?.modelChoices}
      noModelConnection={!selected && services?.modelChoices.length === 0}
      activeModelConnectionId={selected?.llmConnectionId}
      activeModelConnectionSlug={selected?.llmConnectionSlug}
      activeModel={selected?.model}
      modelLabel={selected?.model ?? defaultModel?.model}
      onModelChange={selected && services ? (model) => change(() => settings.setModelConfiguration(selected.id, { ...model, thinkingLevel: null })) : undefined}
      modelSwitchAvailability={settingsLocked ? { available: false, pending: changing, reason: 'pending' } : undefined}
      newChatModel={defaultModel}
      onPickNewChatModel={services ? (model) => { setDefaults((current) => ({ ...current, model })); } : undefined}
      onOpenModelSettings={services?.onOpenModelSettings}
      permissionMode={selected?.permissionMode ?? defaults.permissionMode ?? 'ask'}
      permissionModeDisabledReason={settingsLocked ? (chinese ? '当前无法修改配置' : 'Settings are currently locked') : undefined}
      onPermissionModeChange={services ? (mode) => change(async () => {
        if (!isChatDefaultPermissionMode(mode)) return;
        if (mode === 'bypass' && !await services.confirmBypass()) return;
        if (selected) await settings.setPermissionMode(selected.id, mode);
        else setDefaults((current) => ({ ...current, permissionMode: mode }));
      }) : undefined}
    />
  </>;
}
