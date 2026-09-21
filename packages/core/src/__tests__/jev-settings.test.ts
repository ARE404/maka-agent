import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings, mergeSettings, normalizeSettings } from '../settings.js';
import { SENSITIVE_PLACEHOLDER } from '../settings/network-settings.js';

test('Jev is opt-in, old settings migrate disabled, malformed values fail closed', () => {
  assert.deepEqual(normalizeSettings({}).jev, { enabled: false, apiKey: '' });
  assert.deepEqual(normalizeSettings({ jev: { enabled: 'true', apiKey: 42 } }).jev, { enabled: false, apiKey: '' });
  assert.deepEqual(normalizeSettings({ jev: null }).jev, { enabled: false, apiKey: '' });
});

test('Jev updates preserve masked secrets and unrelated settings; clearing is explicit', () => {
  const current = mergeSettings(createDefaultSettings(), { jev: { apiKey: ' key ', enabled: true } });
  assert.equal(current.jev.apiKey, 'key');
  const disabled = mergeSettings(current, { jev: { enabled: false, apiKey: SENSITIVE_PLACEHOLDER } });
  assert.deepEqual(disabled.jev, { enabled: false, apiKey: 'key' });
  assert.deepEqual(disabled.chatDefaults, current.chatDefaults);
  assert.equal(mergeSettings(current, { jev: { apiKey: '' } }).jev.apiKey, '');
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(current))).jev, current.jev);
});
