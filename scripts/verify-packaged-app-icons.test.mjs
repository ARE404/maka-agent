import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ICONS } from '../packages/core/dist/settings.js';
import { assertPackagedResources } from './verify-packaged-app.mjs';

/**
 * The icon artwork is read at runtime, and Electron reports a missing file as
 * an EMPTY image rather than an error — a packaging change that dropped it
 * would ship a blank dock tile with nothing failing. So the packaged-resource
 * check has to name it, and this proves the check would notice.
 */
function recorder(missing = new Set()) {
  const asked = [];
  return {
    asked,
    requirePath: async (path) => {
      asked.push(path);
      if ([...missing].some((suffix) => path.endsWith(suffix))) {
        throw new Error(`missing ${path}`);
      }
    },
    forbidPath: async () => {},
  };
}

test('every shipped icon is required in a packaged build', async () => {
  const probe = recorder();
  await assertPackagedResources('/Resources', probe);

  assert.ok(probe.asked.includes(join('/Resources', 'assets', 'icon.png')));
  for (const icon of APP_ICONS.filter((id) => id !== 'default')) {
    assert.ok(
      probe.asked.includes(join('/Resources', 'assets', 'app-icons', `${icon}.png`)),
      `${icon} is selectable but not required in the package`,
    );
  }
});

test('a package that dropped the artwork fails the check', async () => {
  for (const dropped of ['assets/icon.png', join('assets', 'app-icons', 'sky.png')]) {
    await assert.rejects(
      assertPackagedResources('/Resources', recorder(new Set([dropped]))),
      /missing/,
      `dropping ${dropped} should fail`,
    );
  }
});
