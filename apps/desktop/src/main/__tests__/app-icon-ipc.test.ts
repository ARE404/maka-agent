import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IpcMainInvokeEvent } from 'electron';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import { registerAppIconIpc } from '../app-icon-ipc.js';
import { customAppIconDirectory, resolveCustomAppIconPath } from '../custom-app-icon-store.js';

const ID = 'c'.repeat(32);
const ICON = `custom:${ID}`;

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

async function harness(selected: string, options: { onCompareAndSet?: () => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-icon-ipc-'));
  await mkdir(customAppIconDirectory(root), { recursive: true });
  await writeFile(resolveCustomAppIconPath(root, ID), 'x');

  const handlers = new Map<string, Handler>();
  let settings = { appearance: { theme: 'auto', appIcon: selected } } as unknown as AppSettings;
  const applied: AppSettings[] = [];

  registerAppIconIpc({
    // Typed, not cast: a stub that stops matching the real dependencies should
    // fail the build rather than keep passing against a shape that is gone.
    ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    listPreviews: async () => [],
    importArtwork: async () => 'default',
    settingsStore: {
      updateIf: async (
        predicate: (current: AppSettings) => boolean,
        patch: UpdateAppSettingsInput,
      ) => {
        // The real store evaluates the predicate and writes on one queue. The
        // hook stands in for whatever else reached that queue first.
        options.onCompareAndSet?.();
        if (!predicate(settings)) return { applied: false, settings };
        settings = {
          ...settings,
          appearance: { ...settings.appearance, ...patch.appearance },
        } as AppSettings;
        return { applied: true, settings };
      },
    },
    applySettings: async (next: AppSettings) => void applied.push(next),
    userDataPath: () => root,
  });

  return {
    root,
    applied,
    remove: (icon: unknown) =>
      handlers.get('app:removeIcon')!(undefined as unknown as IpcMainInvokeEvent, icon),
    current: () => settings.appearance.appIcon,
    select: (icon: string) => {
      settings = {
        ...settings,
        appearance: { ...settings.appearance, appIcon: icon },
      } as AppSettings;
    },
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

/**
 * The gap a busy flag cannot close: the selection can move between the read
 * and the write, and on the far side of an IPC boundary at that. Resetting
 * unconditionally would stamp `default` over a choice the user just made.
 */
test('a selection landing during removal wins, and the file still goes', async () => {
  const newer = 'sky';
  const h = await harness(ICON, { onCompareAndSet: () => h.select(newer) });

  const result = (await h.remove(ICON)) as { ok: boolean; selection?: string };

  assert.equal(result.ok, true);
  // The newer choice is the authority, and it is what the caller is told.
  assert.equal(result.selection, newer);
  assert.equal(h.current(), newer);
  // Nothing was applied, because nothing about the selection changed here.
  assert.equal(h.applied.length, 0);
  // The artwork is still deleted: it is no longer in use, which is what was asked.
  assert.deepEqual(await readdir(customAppIconDirectory(h.root)), []);
});
