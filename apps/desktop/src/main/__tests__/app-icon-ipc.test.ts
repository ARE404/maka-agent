import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import { registerAppIconIpc } from '../app-icon-ipc.js';
import { customAppIconDirectory, resolveCustomAppIconPath } from '../custom-app-icon-store.js';

const ID = 'c'.repeat(32);
const ICON = `custom:${ID}`;

type Handler = (event: unknown, ...args: unknown[]) => unknown;

async function harness(selected: string) {
  const root = await mkdtemp(join(tmpdir(), 'maka-icon-ipc-'));
  await mkdir(customAppIconDirectory(root), { recursive: true });
  await writeFile(resolveCustomAppIconPath(root, ID), 'x');

  const handlers = new Map<string, Handler>();
  let settings = { appearance: { theme: 'auto', appIcon: selected } } as unknown as AppSettings;
  const applied: AppSettings[] = [];

  registerAppIconIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    listPreviews: async () => [],
    importArtwork: async () => 'default',
    settingsStore: {
      get: async () => settings,
      update: async (patch: UpdateAppSettingsInput) => {
        settings = {
          ...settings,
          appearance: { ...settings.appearance, ...patch.appearance },
        } as AppSettings;
        return settings;
      },
    },
    applySettings: async (next: AppSettings) => void applied.push(next),
    userDataPath: () => root,
  } as never);

  return {
    root,
    applied,
    remove: (icon: unknown) => handlers.get('app:removeIcon')!(undefined, icon),
    current: () => settings.appearance.appIcon,
  };
}

test('removing the current icon resets the selection before the file goes away', async () => {
  const h = await harness(ICON);
  const result = (await h.remove(ICON)) as { ok: boolean; selection?: string };

  assert.equal(result.ok, true);
  assert.equal(result.selection, 'default');
  // Both halves moved, and the setting is the half that moved first.
  assert.equal(h.current(), 'default');
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
  // The OS surface was told, so the dock is not still holding the deleted art.
  assert.equal(h.applied.length, 1);
});

test('removing an icon that is not selected leaves the selection alone', async () => {
  const h = await harness('sky');
  const result = (await h.remove(ICON)) as { ok: boolean; selection?: string };

  assert.equal(result.ok, true);
  assert.equal(result.selection, 'sky');
  assert.equal(h.current(), 'sky');
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
  assert.equal(h.applied.length, 0);
});

/**
 * The shipped set is not the user's to delete, and a malformed reference names
 * no artwork at all — neither may reach the store, which would otherwise turn
 * the string into a path.
 */
test('shipped ids and malformed references are refused without touching disk', async () => {
  const h = await harness(ICON);
  for (const bad of ['default', 'sky', 'custom:../../etc/passwd', 'custom:', 42, null]) {
    const result = (await h.remove(bad)) as { ok: boolean; reason?: string };
    assert.equal(result.ok, false, `${String(bad)} should be refused`);
    assert.equal(result.reason, 'invalid_id');
  }
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), [`${ID}.png`]);
  assert.equal(h.current(), ICON);
});
