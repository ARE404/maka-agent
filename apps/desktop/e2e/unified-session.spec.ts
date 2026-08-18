import { expect, test, COMPOSER_INPUT } from './fixtures.js';
import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';

test('Unified is the default entry and discussion stays outside ordinary Sessions', async ({
  unifiedSessionWindow: page,
}) => {
  await expect(page.getByRole('main', { name: 'Unified Session' })).toBeVisible();
  await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();

  const before = await page.evaluate(() => window.maka.sessions.list());
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('登录超时可能有问题');
  await composer.press('Enter');

  await expect(
    page.locator('.maka-unified-discussion[data-role="user"]', {
      hasText: '登录超时可能有问题',
    }),
  ).toBeVisible();
  await expect(
    page.locator('.maka-unified-discussion[data-role="user"] .maka-chat-message-bubble-user'),
  ).toBeVisible();
  await expect(
    page.locator('.maka-unified-discussion[data-role="assistant"] .maka-chat-message-bubble-assistant'),
  ).toBeVisible();
  const discussionGeometry = await page
    .locator('.maka-unified-discussion[data-role="user"]')
    .evaluate((message) => {
      const bubble = message.querySelector<HTMLElement>('.maka-chat-message-bubble-user');
      if (!bubble) throw new Error('missing user bubble');
      const messageRect = message.getBoundingClientRect();
      const bubbleRect = bubble.getBoundingClientRect();
      return {
        messageLeft: messageRect.left,
        messageWidth: messageRect.width,
        bubbleLeft: bubbleRect.left,
        background: getComputedStyle(bubble).backgroundColor,
      };
    });
  expect(discussionGeometry.bubbleLeft).toBeGreaterThan(
    discussionGeometry.messageLeft + discussionGeometry.messageWidth * 0.2,
  );
  expect(discussionGeometry.background).not.toBe('rgba(0, 0, 0, 0)');
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(before.length);
});

test('Unified creates a real Project Work and supports Focused View round-trip', async ({
  unifiedSessionWindow: page,
}) => {
  const before = await page.evaluate(() => window.maka.sessions.list());
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('在 fixture-project-alpha 实现登录超时修复');
  await composer.press('Enter');

  const pendingRoute = page.locator('.maka-unified-pending-route');
  await expect(pendingRoute).toHaveAttribute('data-phase', 'routing');
  await expect(pendingRoute.locator('.maka-unified-work-meta')).toHaveCount(0);
  const neutralBubbleColor = await pendingRoute
    .locator('.maka-unified-pending-bubble')
    .evaluate((bubble) => getComputedStyle(bubble).backgroundColor);

  const block = page.locator('.maka-unified-work').filter({ hasText: 'fixture-project-alpha' });
  await expect(block).toBeVisible();
  // The bound pending route is deliberately brief and may already have been
  // replaced by the authoritative Work block on a fast worker. Assert the two
  // durable visual invariants across that transition instead: the bubble keeps
  // its ordinary Session fill, while target identity appears as the side mark.
  const boundBubbleColor = await block
    .locator('.maka-unified-work-prompt-bubble')
    .evaluate((bubble) => getComputedStyle(bubble).backgroundColor);
  expect(boundBubbleColor).toBe(neutralBubbleColor);
  const boundMarkerColor = await block
    .locator('.maka-unified-work-prompt-bubble')
    .evaluate((bubble) => getComputedStyle(bubble, '::before').backgroundColor);
  expect(boundMarkerColor).not.toBe('rgba(0, 0, 0, 0)');
  const userMeta = block.locator('.maka-unified-work-meta[data-sender="user"]');
  const assistantMeta = block.locator('.maka-unified-work-meta[data-sender="assistant"]');
  await expect(userMeta).toContainText('fixture-project-alpha /');
  await expect(assistantMeta).toContainText('fixture-project-alpha /');
  await expect(block.locator(':scope > header')).toHaveCount(0);
  await expect(block.locator('.maka-unified-work-prompt-bubble')).toBeVisible();
  await expect(block.locator('.maka-unified-work-answer-bubble')).toBeVisible();
  const attachedMetadata = await block.evaluate((work) => {
    const userMeta = work.querySelector<HTMLElement>('.maka-unified-work-meta[data-sender="user"]');
    const prompt = work.querySelector<HTMLElement>('.maka-unified-work-prompt-bubble');
    const assistantMeta = work.querySelector<HTMLElement>(
      '.maka-unified-work-meta[data-sender="assistant"]',
    );
    const answer = work.querySelector<HTMLElement>('.maka-unified-work-answer-bubble');
    if (!userMeta || !prompt || !assistantMeta || !answer) throw new Error('missing Work bubbles');
    return {
      userGap: prompt.getBoundingClientRect().top - userMeta.getBoundingClientRect().bottom,
      assistantGap: answer.getBoundingClientRect().top - assistantMeta.getBoundingClientRect().bottom,
    };
  });
  expect(attachedMetadata.userGap).toBeLessThanOrEqual(6);
  expect(attachedMetadata.assistantGap).toBeLessThanOrEqual(6);
  const bubblePadding = await block.evaluate((work) => {
    const prompt = work.querySelector<HTMLElement>('.maka-unified-work-prompt-bubble');
    const answer = work.querySelector<HTMLElement>('.maka-unified-work-answer-bubble');
    if (!prompt || !answer) throw new Error('missing Work bubbles');
    const promptStyle = getComputedStyle(prompt);
    const answerStyle = getComputedStyle(answer);
    return {
      promptInline: Math.min(parseFloat(promptStyle.paddingLeft), parseFloat(promptStyle.paddingRight)),
      answerLeading: parseFloat(answerStyle.paddingLeft),
      answerBlock: Math.min(parseFloat(answerStyle.paddingTop), parseFloat(answerStyle.paddingBottom)),
    };
  });
  expect(bubblePadding.promptInline).toBeGreaterThanOrEqual(8);
  expect(bubblePadding.answerLeading).toBeGreaterThanOrEqual(12);
  const unifiedGeometry = await page.evaluate(() => {
    const items = document.querySelector<HTMLElement>('.maka-unified-items');
    const composer = document.querySelector<HTMLElement>('.maka-composer-astryx');
    const prompt = document.querySelector<HTMLElement>('.maka-unified-work-prompt-bubble');
    const answer = document.querySelector<HTMLElement>('.maka-unified-work-answer-bubble');
    const message = document.querySelector<HTMLElement>('.maka-unified-work-message[data-sender="assistant"]');
    if (!items || !composer || !prompt || !answer || !message) {
      throw new Error('missing Unified measure contract');
    }
    const promptStyle = getComputedStyle(prompt);
    const answerStyle = getComputedStyle(answer);
    return {
      itemsWidth: items.getBoundingClientRect().width,
      composerWidth: composer.getBoundingClientRect().width,
      answerWidth: answer.getBoundingClientRect().width,
      messageWidth: message.getBoundingClientRect().width,
      promptColor: promptStyle.backgroundColor,
      answerColor: answerStyle.backgroundColor,
      promptMarker: getComputedStyle(prompt, '::before').backgroundColor,
      answerMarker: getComputedStyle(answer, '::before').backgroundColor,
    };
  });
  expect(Math.abs(unifiedGeometry.itemsWidth - unifiedGeometry.composerWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(unifiedGeometry.answerWidth - unifiedGeometry.messageWidth)).toBeLessThanOrEqual(1);
  expect(unifiedGeometry.answerColor).not.toBe(unifiedGeometry.promptColor);
  expect(unifiedGeometry.answerMarker).toBe(unifiedGeometry.promptMarker);
  await expect(block.locator('.maka-unified-status')).toHaveText('完成');
  await expect(block).toContainText('Fake backend received');
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(before.length + 1);
  await expect
    .poll(async () => {
      const session = (await page.evaluate(() => window.maka.sessions.list()))
        .find((item) => item.name.includes('登录超时修复'));
      return session?.hasUnread;
    })
    .toBe(false);

  await block.getByRole('button', { name: '进入工作' }).click();
  await expect(page.getByRole('button', { name: '← 返回所有工作' })).toBeVisible();
  await expect(page.getByText('在 fixture-project-alpha 实现登录超时修复', { exact: true })).toBeVisible();

  const focusedComposer = page.locator(COMPOSER_INPUT);
  await focusedComposer.fill('这条只属于目标工作');
  await focusedComposer.press('Enter');
  await expect(page.getByText(/Fake backend received: 这条只属于目标工作/)).toBeVisible();

  await page.getByRole('button', { name: '← 返回所有工作' }).click();
  await expect(block).toBeVisible();
  await expect(block).toContainText('Fake backend received');
  await expect(block).not.toContainText('这条只属于目标工作');
  const lifecycle = page.locator('.maka-unified-lifecycle').filter({ hasText: 'fixture-project-alpha' });
  await expect(lifecycle).toContainText('完成');

  await page.reload();
  const restored = page.locator('.maka-unified-work').filter({ hasText: 'fixture-project-alpha' });
  await expect(restored).toContainText('Fake backend received');
});

test('Unified clarifies an ambiguous Project and supports changing the selected target', async ({
  unifiedSessionWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('修改登录超时');
  await composer.press('Enter');

  const clarification = page.locator('.maka-unified-clarification').last();
  await expect(clarification).toBeVisible();
  await expect(clarification.getByRole('button', { name: /fixture-project-alpha/u })).toBeVisible();
  await expect(clarification.getByRole('button', { name: /fixture-project-beta/u })).toBeVisible();
  await clarification.getByRole('button', { name: /fixture-project-alpha/u }).click();

  const first = page.locator('.maka-unified-work').filter({ hasText: '修改登录超时' }).last();
  await expect(first.locator('.maka-unified-work-meta').first()).toContainText(
    'fixture-project-alpha /',
  );
  await expect(first.locator('.maka-unified-status')).toHaveText('完成');
  await first.getByRole('button', { name: '更改目标' }).click();

  const retarget = page.locator('.maka-unified-clarification').last();
  await expect(retarget).toBeVisible();
  await retarget.getByRole('button', { name: /fixture-project-beta/u }).click();
  const replacement = page.locator('.maka-unified-work').filter({ hasText: '修改登录超时' }).last();
  await expect(replacement.locator('.maka-unified-work-meta').first()).toContainText(
    'fixture-project-beta /',
  );
  await expect(replacement.locator('.maka-unified-status')).toHaveText('完成');
});

test('Unified confirms and executes a persisted cross-Project dependency graph', async ({
  unifiedSessionWindow: page,
}) => {
  const before = await page.evaluate(() => window.maka.sessions.list());
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill(
    '在 fixture-project-alpha 实现接口，然后在 fixture-project-beta 更新调用方',
  );
  await composer.press('Enter');

  const scope = page.locator('.maka-unified-coordination');
  await expect(scope).toBeVisible();
  await expect(scope).toContainText('fixture-project-alpha');
  await expect(scope).toContainText('fixture-project-beta');
  await expect(scope).toContainText('依赖 fixture-project-alpha');
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(before.length);

  await scope.getByRole('button', { name: '确认并开始' }).click();
  await expect(scope).toHaveCount(0);
  const coordinationEvent = page.locator('.maka-unified-coordination-event');
  await expect(coordinationEvent).toContainText('已创建 2 项关联工作');
  await expect(coordinationEvent).toContainText('已完成');
  await expect(page.locator('.maka-unified-work')).toHaveCount(2);
  const workTones = await page.locator('.maka-unified-work').evaluateAll((blocks) =>
    blocks.map((block) => block.getAttribute('data-work-tone')),
  );
  expect(new Set(workTones).size).toBe(2);
  const workMarkerColors = await page.locator('.maka-unified-work-prompt-bubble').evaluateAll(
    (bubbles) => bubbles.map((bubble) => getComputedStyle(bubble, '::before').backgroundColor),
  );
  expect(new Set(workMarkerColors).size).toBe(2);
  const answerMarkerColors = await page.locator('.maka-unified-work-answer-bubble').evaluateAll(
    (bubbles) => bubbles.map((bubble) => getComputedStyle(bubble, '::before').backgroundColor),
  );
  expect(new Set(answerMarkerColors).size).toBe(2);
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(before.length + 2);

  await page.reload();
  await expect(page.locator('.maka-unified-coordination')).toHaveCount(0);
  await expect(page.locator('.maka-unified-coordination-event')).toContainText('已完成');
  await expect(page.locator('.maka-unified-work')).toHaveCount(2);
});

test('Unified feature toggle is reversible and preserves its history', async ({
  unifiedSessionWindow: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('先讨论一个不会创建工作的想法');
  await composer.press('Enter');
  await expect(
    page.locator('.maka-unified-discussion[data-role="user"]', {
      hasText: '先讨论一个不会创建工作的想法',
    }),
  ).toBeVisible();

  await page.evaluate(() => window.maka.settings.update({ unifiedSession: { enabled: false } }));
  await expect(page.getByRole('main', { name: 'Unified Session' })).toHaveCount(0);
  await expect(page.locator('.maka-unified-sidebar-entry')).toHaveCount(0);

  await page.evaluate(() => window.maka.settings.update({ unifiedSession: { enabled: true } }));
  await expect(page.getByRole('main', { name: 'Unified Session' })).toBeVisible();
  await expect(page.locator('[data-sidebar-state="collapsed"]')).toBeVisible();
  await expect(
    page.locator('.maka-unified-discussion[data-role="user"]', {
      hasText: '先讨论一个不会创建工作的想法',
    }),
  ).toBeVisible();
});

test('Unified restores an archived target Work before continuing it', async ({
  unifiedSessionWindow: page,
}) => {
  const created = await page.evaluate(() =>
    window.maka.unified.send({ text: '在 fixture-project-alpha 实现归档恢复验证' }),
  );
  if (created.kind !== 'work') throw new Error('expected Work');
  const initialBlock = page.locator('.maka-unified-work').filter({ hasText: '归档恢复验证' });
  await expect(initialBlock.locator('.maka-unified-status')).toHaveText('完成');
  await page.evaluate((sessionId) => window.maka.sessions.archive(sessionId), created.block.work.sessionId);

  await page.evaluate(
    ({ work }) => window.maka.unified.send({ text: '继续补完这个工作', explicitWork: work }),
    created.block,
  );

  const block = page.locator('.maka-unified-work').filter({ hasText: '继续补完这个工作' });
  await expect(block.locator('.maka-unified-status')).toHaveText('完成');
  await expect(block.locator('.maka-unified-work-meta').first()).toContainText(
    'fixture-project-alpha /',
  );
  await expect
    .poll(async () => {
      const session = (await page.evaluate(() => window.maka.sessions.list({ includeArchived: true })))
        .find((item) => item.id === created.block.work.sessionId);
      return session?.isArchived;
    })
    .toBe(false);
});

test('deleting a target Session purges its Unified projection and routing identity', async ({
  unifiedSessionWindow: page,
}) => {
  const created = await page.evaluate(() =>
    window.maka.unified.send({ text: '在 fixture-project-alpha 实现删除级联验证' }),
  );
  if (created.kind !== 'work') throw new Error('expected Work');
  const block = page.locator('.maka-unified-work').filter({ hasText: '删除级联验证' });
  await expect(block.locator('.maka-unified-status')).toHaveText('完成');

  await page.evaluate((sessionId) => window.maka.sessions.remove(sessionId), created.block.work.sessionId);
  await expect(block).toHaveCount(0);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.maka.sessions.list()))
        .some((session) => session.id === created.block.work.sessionId),
    )
    .toBe(false);

  const replacement = await page.evaluate(() =>
    window.maka.unified.send({ text: '在 fixture-project-alpha 实现删除级联验证' }),
  );
  expect(replacement.kind).toBe('work');
  if (replacement.kind !== 'work') throw new Error('expected replacement Work');
  expect(replacement.block.work.sessionId).not.toBe(created.block.work.sessionId);
});

test('incognito Workspaces are excluded from Unified recall and creation', async ({
  unifiedSessionWindow: page,
}) => {
  const before = await page.evaluate(() => window.maka.sessions.list());
  await page.evaluate(() => window.maka.settings.update({ privacy: { incognitoActive: true } }));
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.maka.unified.listWorkspaces()))
        .every((workspace) => workspace.incognitoActive),
    )
    .toBe(true);

  await page.evaluate(() =>
    window.maka.unified.send({ text: '在 fixture-project-alpha 实现隐身验证' }),
  );

  await expect(page.getByRole('button', { name: '打开或注册项目' })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(before.length);
});

test('an explicitly named unknown Project offers registration without creating Work', async ({
  unifiedSessionWindow: page,
}) => {
  const before = await page.evaluate(() => window.maka.sessions.list());
  await page.evaluate(() =>
    window.maka.unified.send({ text: '在 NewPortal 项目实现登录页' }),
  );

  await expect(page.getByRole('button', { name: '打开或注册项目' })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.maka.sessions.list())).length)
    .toBe(before.length);
});

test('a target question remains bound to and answered inside its Work block', async ({
  unifiedSessionWindow: page,
}) => {
  const target = await page.evaluate(async (prompt) => {
    const project = (await window.maka.projects.list()).find(
      (item) => item.name === 'fixture-project-alpha',
    );
    const session = (await window.maka.sessions.list()).find(
      (item) => item.projectId === project?.id,
    );
    const workspace = (await window.maka.unified.listWorkspaces()).find(
      (item) => item.name === 'fixture-project-alpha',
    );
    if (!session || !workspace) throw new Error('missing fixture target');
    return window.maka.unified.send({
      text: prompt,
      explicitWork: { workspaceId: workspace.id, sessionId: session.id },
    });
  }, FAKE_ASK_USER_QUESTION_PROMPT);
  expect(target.kind).toBe('work');

  const block = page.locator('.maka-unified-work').filter({ hasText: 'fixture-project-alpha' });
  const prompt = block.locator('.maka-user-question-prompt');
  await expect(prompt).toBeVisible();
  await expect(block.locator('.maka-unified-status')).toHaveText('等待你');
  await prompt.getByRole('radio', { name: /邀请制/ }).click();
  await prompt.getByRole('button', { name: '下一题' }).click();
  await prompt.getByRole('radio', { name: '本周' }).click();
  await prompt.getByRole('button', { name: '下一题' }).click();
  await prompt.getByRole('radio', { name: '是' }).click();
  await prompt.getByRole('button', { name: '提交答案' }).click();

  await expect(prompt).toHaveCount(0);
  await expect(block.locator('.maka-unified-status')).toHaveText('完成');
  await expect(block).toContainText(/Fake question answers: 邀请制 \/ 本周 \/ 是/);
});

test('changing a target Work to full access uses the existing confirmation gate', async ({
  unifiedSessionWindow: page,
}) => {
  const created = await page.evaluate(() =>
    window.maka.unified.send({ text: '在 fixture-project-alpha 实现权限切换验证' }),
  );
  if (created.kind !== 'work') throw new Error('expected Work');
  const block = page.locator('.maka-unified-work').filter({ hasText: '权限切换验证' });
  await expect(block.locator('.maka-unified-status')).toHaveText('完成');
  const mode = block.getByRole('button', { name: '目标工作的权限模式' });
  const footer = block.locator('.maka-unified-work-footer');
  await expect(footer).toContainText('自动');

  await mode.click();
  await page.getByRole('menuitemradio', { name: '完全权限' }).click();
  await expect(page.locator('.maka-confirm-modal')).toBeVisible();
  await page.getByRole('button', { name: '保持自动' }).click();
  await expect(page.locator('.maka-confirm-modal')).toHaveCount(0);
  await expect(footer).toContainText('自动');

  await mode.click();
  await page.getByRole('menuitemradio', { name: '完全权限' }).click();
  await page.getByRole('button', { name: '开启完全权限' }).click();
  await expect(footer).toContainText('完全权限');
  await expect
    .poll(async () => {
      const session = (await page.evaluate(() => window.maka.sessions.list()))
        .find((item) => item.id === created.block.work.sessionId);
      return session?.permissionMode;
    })
    .toBe('bypass');
});

test('stopping a waiting target Work remains stopped after Runtime stream closure', async ({
  unifiedSessionWindow: page,
}) => {
  const result = await page.evaluate(async (prompt) => {
    const project = (await window.maka.projects.list()).find(
      (item) => item.name === 'fixture-project-alpha',
    );
    const session = (await window.maka.sessions.list()).find(
      (item) => item.projectId === project?.id,
    );
    const workspace = (await window.maka.unified.listWorkspaces()).find(
      (item) => item.name === 'fixture-project-alpha',
    );
    if (!session || !workspace) throw new Error('missing fixture target');
    return window.maka.unified.send({
      text: prompt,
      explicitWork: { workspaceId: workspace.id, sessionId: session.id },
    });
  }, FAKE_ASK_USER_QUESTION_PROMPT);
  if (result.kind !== 'work') throw new Error('expected Work');
  const block = page.locator('.maka-unified-work').filter({ hasText: 'fixture-project-alpha' });
  await expect(block.locator('.maka-user-question-prompt')).toBeVisible();

  await block.getByRole('button', { name: '停止' }).last().click();

  await expect(block.locator('.maka-user-question-prompt')).toHaveCount(0);
  await expect(block.locator('.maka-unified-status')).toHaveText('已停止');
});
