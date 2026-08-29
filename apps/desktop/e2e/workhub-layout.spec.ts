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

import { expect, test } from './fixtures';

test('WorkHub explains Coordination startup failure and recovers after a default model is set', async ({
  window: page,
}) => {
  await page.evaluate(async () => {
    await window.maka.connections.setDefaultModel(null);
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
  });

  const failure = page.getByRole('alert');
  await expect(failure).toContainText('WorkHub 暂时无法启动');
  await expect(failure).toContainText('请检查当前 Runtime Host 的默认模型配置');

  await page.evaluate(async () => {
    await window.maka.connections.setDefaultModel({
      slug: 'e2e',
      model: 'claude-sonnet-4-5-20250929',
    });
  });

  await expect(page.getByRole('region', { name: 'WorkHub' })).toBeVisible();
  await expect(page.locator('.workhub-empty')).toContainText('从这里继续所有工作');
  await expect(page.locator('.workhub-surface .maka-composer-editor')).toBeVisible();
});

test('WorkHub Anchor Rail filters Session facts and reflows without covering conversation', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('检查 WorkHub 锚点导航');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, {
    timeout: 20_000,
  });
  const sessionName = await page.evaluate(async () =>
    (await window.maka.sessions.list())[0]?.name,
  );
  expect(sessionName).toBeTruthy();
  await page.evaluate(async () => {
    await window.maka.settings.updateClient({ workHub: { enabled: true } });
  });

  const rail = page.getByRole('complementary', { name: '工作导航' });
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('button', { name: new RegExp(sessionName!) })).toBeVisible();
  await rail.getByRole('button', { name: '待处理' }).click();
  await expect(rail).toContainText('此筛选下没有工作');
  await rail.getByRole('button', { name: '全部' }).click();

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const anchor = document.querySelector<HTMLElement>('.workhub-anchor-rail')!;
    const conversation = document.querySelector<HTMLElement>('.workhub-conversation-shell')!;
    const composer = document.querySelector<HTMLElement>('.workhub-surface .maka-composer-editor')!;
    const anchorBox = anchor.getBoundingClientRect();
    const conversationBox = conversation.getBoundingClientRect();
    const composerBox = composer.getBoundingClientRect();
    return {
      railBeforeConversation: anchorBox.right <= conversationBox.left,
      composerCenterDelta: Math.abs(
        composerBox.left + composerBox.width / 2 -
        (conversationBox.left + conversationBox.width / 2),
      ),
    };
  });
  expect(wide.railBeforeConversation).toBe(true);
  expect(wide.composerCenterDelta).toBeLessThanOrEqual(4);

  await page.setViewportSize({ width: 900, height: 760 });
  const narrow = await page.evaluate(() => {
    const anchorBox = document.querySelector<HTMLElement>('.workhub-anchor-rail')!
      .getBoundingClientRect();
    const conversationBox = document.querySelector<HTMLElement>('.workhub-conversation-shell')!
      .getBoundingClientRect();
    return { railAboveConversation: anchorBox.bottom <= conversationBox.top + 1 };
  });
  expect(narrow.railAboveConversation).toBe(true);
});
