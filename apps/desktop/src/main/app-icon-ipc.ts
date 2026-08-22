import type { IpcMain, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import {
  customAppIconId,
  isCustomAppIcon,
  toAppIconChoice,
  type AppIconChoice,
  type AppSettings,
} from '@maka/core/settings';
import type { SettingsStore } from '@maka/storage';
import type { AppIconPreview } from './app-icon-surface.js';
import {
  CustomAppIconError,
  removeCustomAppIcon,
  type CustomAppIconImportReason,
} from './custom-app-icon-store.js';

export type AppIconImportResult =
  | { readonly ok: true; readonly icon: AppIconChoice }
  | { readonly ok: false; readonly reason: CustomAppIconImportReason };

export type AppIconRemoveResult =
  | { readonly ok: true; readonly selection: AppIconChoice }
  | {
      readonly ok: false;
      readonly reason: 'invalid_id' | 'reset_failed' | 'remove_failed';
    };

/**
 * The icon surface's one main-process owner.
 *
 * Selection and artwork are two pieces of state that must not disagree, so the
 * operation that can break the pair lives here rather than being sequenced by
 * the renderer: a renderer that deletes and then persists leaves the setting
 * pointing at a file that is gone whenever the second call fails.
 */
/**
 * Everything that touches Electron is injected rather than imported: this
 * module holds the policy, and keeping `electron` out of its import graph is
 * what lets the removal contract be tested without booting a browser process.
 */
export function registerAppIconIpc(input: {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  readonly listPreviews: () => Promise<readonly AppIconPreview[]>;
  readonly importArtwork: (source: {
    readonly sourcePath: string;
    readonly userDataPath: string;
  }) => Promise<AppIconChoice>;
  readonly settingsStore: Pick<SettingsStore, 'get' | 'update'>;
  readonly applySettings: (settings: AppSettings) => Promise<void>;
  readonly userDataPath: () => string;
}): void {
  const { userDataPath } = input;

  // The picker asks for the whole set at once; there is no per-id request, so
  // no id from the renderer ever reaches the filesystem.
  input.ipcMain.handle(
    'app:iconPreviews',
    (): Promise<readonly AppIconPreview[]> => input.listPreviews(),
  );

  // The dialog runs here and the file it returns is the only path this sees.
  input.ipcMain.handle('app:importIcon', async (): Promise<AppIconImportResult> => {
    const picked = await input.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'tiff', 'webp'] }],
    });
    const sourcePath = picked.canceled ? undefined : picked.filePaths[0];
    if (!sourcePath) return { ok: false, reason: 'cancelled' };
    try {
      return {
        ok: true,
        icon: await input.importArtwork({ sourcePath, userDataPath: userDataPath() }),
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof CustomAppIconError ? error.reason : 'unreadable',
      };
    }
  });

  input.ipcMain.handle(
    'app:removeIcon',
    async (_event, icon: unknown): Promise<AppIconRemoveResult> => {
      // Only imported artwork is the user's to delete, and only a well-formed
      // reference names any of it.
      if (!isCustomAppIcon(icon)) return { ok: false, reason: 'invalid_id' };
      const id = customAppIconId(icon);
      if (!id) return { ok: false, reason: 'invalid_id' };

      const current = await input.settingsStore.get();
      let selection = toAppIconChoice(current.appearance.appIcon);
      if (selection === icon) {
        // Hand the OS back to the brand mark BEFORE the file goes away. The
        // other order leaves a persisted choice pointing at nothing whenever
        // this write fails.
        try {
          const next = await input.settingsStore.update({ appearance: { appIcon: 'default' } });
          await input.applySettings(next);
          selection = toAppIconChoice(next.appearance.appIcon);
        } catch {
          return { ok: false, reason: 'reset_failed' };
        }
      }

      try {
        await removeCustomAppIcon({ id, userDataPath: userDataPath() });
      } catch {
        return { ok: false, reason: 'remove_failed' };
      }
      return { ok: true, selection };
    },
  );
}
