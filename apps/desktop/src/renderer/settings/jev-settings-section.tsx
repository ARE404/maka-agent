import { useState } from 'react';
import { Card, Item } from '@astryxdesign/core';
import type { AppSettings, UpdateAppSettingsInput, UpdateAppSettingsResult } from '@maka/core';
import { Button, FormLayout, Switch, TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { useActionGuard } from './use-action-guard';

const COPY = {
  zh: {
    advanced: '高级设置', title: 'Jev 辅助决策',
    help: '使用 TypeSafe Jev 辅助 Unified 的意图分类和工作路由。会发送当前消息与候选工作摘要；对话、执行和标题仍使用原模型。',
    key: 'TypeSafe API Key', saved: '已保存密钥；输入新值以替换',
    save: '保存密钥', saving: '正在保存…', clear: '移除密钥',
    behavior: '判断不确定时请求澄清；服务不可用时使用原有路由。',
    failure: 'Jev 设置保存失败，请重试。',
  },
  en: {
    advanced: 'Advanced settings', title: 'Jev assisted decisions',
    help: 'Use TypeSafe Jev for Unified intent classification and work routing. Sends the current message and candidate work summaries. Conversation, execution, and titles keep their original models.',
    key: 'TypeSafe API Key', saved: 'Key saved; enter a new value to replace it',
    save: 'Save key', saving: 'Saving…', clear: 'Remove key',
    behavior: 'Uncertain decisions ask for clarification; service failures use the existing router.',
    failure: 'Could not save Jev settings. Please try again.',
  },
};

export function JevSettingsSection(props: {
  settings: AppSettings['jev'];
  onUpdate(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult>;
}) {
  const copy = COPY[useUiLocale()];
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const guard = useActionGuard<'save'>();
  const mounted = useMountedRef();
  const toast = useToast();
  async function save(patch: Partial<AppSettings['jev']>) {
    if (!guard.begin('save')) return;
    setSaving(true);
    try {
      await props.onUpdate({ jev: patch });
      if (mounted.current && patch.apiKey !== undefined) setKey('');
    } catch {
      if (mounted.current) toast.error(copy.failure);
    } finally {
      guard.finish();
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <details className="jevAdvancedSettings">
      <summary>{copy.advanced}</summary>
      <Card padding={0} className="settingsRows">
        <Item label={copy.title} description={<>{copy.help}</>} align="start" endContent={(
          <Switch label={copy.title} isLabelHidden value={props.settings.enabled}
            isDisabled={saving || !props.settings.apiKey}
            onChange={(enabled) => void save({ enabled })} />
        )} />
        <FormLayout className="settingsFormLayout">
          <TextInput label={copy.key} type="password" value={key}
            placeholder={props.settings.apiKey ? copy.saved : 'TypeSafe API Key'}
            description={copy.behavior} isDisabled={saving}
            onChange={setKey} />
          <div className="settingsActionRow">
            <Button label={saving ? copy.saving : copy.save} variant="primary"
              isDisabled={saving || !key.trim()} onClick={() => void save({ apiKey: key.trim() })} />
            {props.settings.apiKey && <Button label={copy.clear} variant="secondary"
              isDisabled={saving} onClick={() => void save({ apiKey: '', enabled: false })} />}
          </div>
        </FormLayout>
      </Card>
    </details>
  );
}
