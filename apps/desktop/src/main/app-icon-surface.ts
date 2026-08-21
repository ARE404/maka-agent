import { app, BrowserWindow, nativeImage } from 'electron';
import { APP_ICONS, type AppIcon } from '@maka/core/settings';
import { appIconLoadOrder, resolveAppIconPath } from './app-icon.js';
import { desktopAssetRoot } from './desktop-assets.js';

/** Where this process reads icon artwork from — dev tree or packaged copy. */
export function currentAssetRoot(): string {
  return desktopAssetRoot({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
}

/** Edge length of the picker thumbnails handed to the renderer. */
const PREVIEW_SIZE = 128;

export interface AppIconPreview {
  readonly id: AppIcon;
  /** PNG data URL, sized for the Settings picker tile. */
  readonly dataUrl: string;
}

let previews: readonly AppIconPreview[] | undefined;

/**
 * Point the OS at one of the shipped icons.
 *
 * macOS draws one tile for the whole app, so the dock owns the icon there and
 * per-window icons are ignored. Windows and Linux draw it per window instead,
 * which is why every open window is updated: the `icon` option in
 * `createWindow` only covers windows opened *after* the choice was persisted.
 */
export function applyAppIcon(icon: AppIcon, onIconError: (error: unknown) => void): void {
  try {
    const image = loadAppIcon(icon);
    if (!image) {
      onIconError(new Error(`no readable artwork for app icon "${icon}"`));
      return;
    }
    if (app.dock) {
      app.dock.setIcon(image);
      return;
    }
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(image);
  } catch (error) {
    onIconError(error);
  }
}

/**
 * Thumbnails for the Settings picker. The renderer never learns a path — it
 * asks for the set and gets ids plus artwork — so the icon files stay outside
 * the renderer bundle (they are 1024px masters) and outside its reach.
 *
 * Computed once: the artwork ships with the build and cannot change while the
 * app runs, and decoding a 1024px PNG per picker visit is pure waste.
 */
export function listAppIconPreviews(): readonly AppIconPreview[] {
  if (previews) return previews;
  const built: AppIconPreview[] = [];
  for (const id of APP_ICONS) {
    const image = loadAppIcon(id);
    if (!image) continue;
    built.push({
      id,
      dataUrl: image
        .resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, quality: 'better' })
        .toDataURL(),
    });
  }
  previews = built;
  return previews;
}

/**
 * `nativeImage.createFromPath` reports a missing or undecodable file as an
 * EMPTY image rather than throwing, and handing an empty image to `setIcon`
 * blanks the dock tile instead of leaving the previous one alone. So emptiness
 * is the read failure, and it is what advances the fallback chain.
 */
function loadAppIcon(icon: AppIcon): Electron.NativeImage | undefined {
  for (const candidate of appIconLoadOrder(icon)) {
    const image = nativeImage.createFromPath(resolveAppIconPath(currentAssetRoot(), candidate));
    if (!image.isEmpty()) return image;
  }
  return undefined;
}
