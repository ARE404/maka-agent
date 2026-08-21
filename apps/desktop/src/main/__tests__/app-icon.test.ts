import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_ICONS } from '@maka/core/settings';
import {
  appIconAssetSegments,
  appIconLoadOrder,
  resolveAppIconPath,
} from '../app-icon.js';
import { desktopAssetRoot } from '../desktop-assets.js';

const DEV_ROOT = desktopAssetRoot({ isPackaged: false, resourcesPath: '/not-used-in-dev' });

/**
 * The OS is handed these files directly, and Electron reports an unreadable
 * one as an EMPTY image rather than as an error — a dock tile silently goes
 * blank. So the contract every id must meet is checked here, against the
 * bytes: present, a real PNG, and the square master the dock wants rather
 * than a screenshot someone dropped in with the right name.
 */
test('every shipped icon id resolves to a square 1024px PNG master', async () => {
  for (const icon of APP_ICONS) {
    const path = resolveAppIconPath(DEV_ROOT, icon);
    const where = `app icon "${icon}" (${appIconAssetSegments(icon).join('/')})`;
    const file = await open(path, 'r').catch(() => undefined);
    assert.ok(file, `${where} has no artwork in the build`);
    try {
      // PNG signature, then the IHDR width/height at bytes 16..24.
      const header = Buffer.alloc(24);
      await file.read(header, 0, header.length, 0);
      assert.equal(
        header.subarray(0, 8).toString('hex'),
        '89504e470d0a1a0a',
        `${where} is not a PNG`,
      );
      assert.equal(header.readUInt32BE(16), 1024, `${where} is not 1024px wide`);
      assert.equal(header.readUInt32BE(20), 1024, `${where} is not 1024px tall`);
    } finally {
      await file.close();
    }
  }
});

test('the default keeps its long-standing path while variants live in their own directory', () => {
  assert.deepEqual(appIconAssetSegments('default'), ['assets', 'icon.png']);
  assert.deepEqual(appIconAssetSegments('mono'), ['assets', 'app-icons', 'mono.png']);
  assert.equal(
    resolveAppIconPath(join('/tmp', 'desktop'), 'mono'),
    join('/tmp', 'desktop', 'assets', 'app-icons', 'mono.png'),
  );
});

test('a variant falls back to the brand mark, and the brand mark has nothing to fall back to', () => {
  // A build that lost assets/app-icons/ — a packaging filter, a half-applied
  // update — should land on the brand mark rather than on the OS placeholder.
  assert.deepEqual(appIconLoadOrder('mono'), ['mono', 'default']);
  // No self-referential retry: if the brand mark itself is unreadable there is
  // nothing left to try, and looping over it twice would only hide that.
  assert.deepEqual(appIconLoadOrder('default'), ['default']);
});
