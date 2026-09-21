import { test, expect } from './fixtures';

test('Jev settings save, enable, persist on re-entry, and remove the masked key', async ({ window: page }, testInfo) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '设置分组' });
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  const section = page.locator('.jevAdvancedSettings');
  await expect(section).not.toHaveAttribute('open', '');
  await section.locator('summary').click();
  const toggle = section.getByRole('switch', { name: 'Jev 辅助决策' });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await section.getByLabel('TypeSafe API Key', { exact: true }).fill('jev-e2e-fake-key');
  await section.getByRole('button', { name: '保存密钥', exact: true }).click();
  await expect(toggle).toBeEnabled();
  await expect(section.getByLabel('TypeSafe API Key', { exact: true })).toHaveValue('');
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => page.evaluate(async () => (await window.maka.settings.get()).jev)).toEqual({
    enabled: true, apiKey: '••••••••',
  });
  await nav.getByRole('button', { name: '外观', exact: true }).click();
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await section.locator('summary').click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(toggle).toBeInViewport();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(() => section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(toggle).toBeInViewport();
  await section.screenshot({ path: testInfo.outputPath('jev-settings.png') });
  await section.getByRole('button', { name: '移除密钥', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect.poll(() => page.evaluate(async () => (await window.maka.settings.get()).jev)).toEqual({
    enabled: false, apiKey: '',
  });
});
