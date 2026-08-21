import { join } from 'node:path';
import type { AppIcon, AppIconChoice } from '@maka/core/settings';

/**
 * Where one icon choice's artwork lives, relative to `apps/desktop`.
 *
 * `default` deliberately keeps pointing at the long-standing
 * `assets/icon.png` instead of moving under `assets/app-icons/`: that path is
 * also what the packaging config and the window `icon` option name, so moving
 * it to make the set look tidy would be a rename with no product value.
 */
export function appIconAssetSegments(icon: AppIcon): readonly string[] {
  return icon === 'default' ? ['assets', 'icon.png'] : ['assets', 'app-icons', `${icon}.png`];
}

export function resolveAppIconPath(desktopRoot: string, icon: AppIcon): string {
  return join(desktopRoot, ...appIconAssetSegments(icon));
}

/**
 * Which artwork to try, in order, for one choice. A build whose optional
 * artwork is missing — a packaging filter that dropped `assets/app-icons/`,
 * a partially applied update — falls back to the brand mark rather than to
 * the OS placeholder, which on macOS is the generic Electron rocket.
 */
export function appIconLoadOrder(icon: AppIconChoice): readonly AppIconChoice[] {
  return icon === 'default' ? ['default'] : [icon, 'default'];
}
