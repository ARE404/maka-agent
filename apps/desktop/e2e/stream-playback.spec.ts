import { test, expect, COMPOSER_INPUT } from './fixtures';

test('offers only pause before the first token', async ({
  streamPlaybackWindow: page,
}) => {
  const pause = page.getByRole('button', { name: '暂停显示回答' });
  const terminate = page.getByRole('button', { name: '结束生成', exact: true });
  await expect(pause).toBeVisible();
  await expect(pause).toHaveAttribute('data-variant', 'primary');
  await expect(terminate).toHaveCount(0);

  await pause.click();
  const play = page.getByRole('button', { name: '继续显示回答' });
  await expect(play).toBeVisible();
  await expect(play).toHaveAttribute('data-variant', 'primary');
  await expect(play).toHaveAttribute('data-state', 'paused');
  await expect(terminate).toHaveCount(0);
  await expect(play).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const screenshotPath = process.env.MAKA_STREAM_PLAYBACK_SCREENSHOT;
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });

  await play.click();
  await expect(pause).toBeVisible();
  await expect(pause).toHaveAttribute('data-state', 'playing');
});

test('keeps pause and resume available after streamed content arrives', async ({
  disclosureOutputWindow: page,
}) => {
  const pause = page.getByRole('button', { name: '暂停显示回答' });
  const terminate = page.getByRole('button', { name: '结束生成', exact: true });
  await expect(pause).toBeVisible();
  await expect(terminate).toHaveCount(0);

  await pause.click();
  const play = page.getByRole('button', { name: '继续显示回答' });
  await expect(play).toBeVisible();
  await expect(terminate).toHaveCount(0);

  await play.click();
  await expect(pause).toBeVisible();
});

test('turns resume into send when a paused user starts the next prompt', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('先生成一段回答');
  await composer.press('Enter');
  await page.getByRole('button', { name: '暂停显示回答' }).click();
  await expect(page.getByRole('button', { name: '继续显示回答' })).toBeVisible();

  await composer.fill('直接开始下一轮');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续显示回答' })).toHaveCount(0);

  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '暂停显示回答' })).toBeVisible();
  await expect(
    page.getByLabel('你发送的消息').getByText('直接开始下一轮', { exact: true }),
  ).toBeVisible();
});
