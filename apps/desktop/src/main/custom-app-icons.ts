import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { nativeImage } from 'electron';
import { CUSTOM_APP_ICON_PREFIX, type CustomAppIcon } from '@maka/core/settings';
import {
  CustomAppIconError,
  CUSTOM_ICON_EDGE,
  CUSTOM_ICON_MAX_INPUT_BYTES,
  CUSTOM_ICON_MIN_EDGE,
  customAppIconDirectory,
  resolveCustomAppIconPath,
} from './custom-app-icon-store.js';

/**
 * Decode, square, scale, store. Non-square art is centre-cropped rather than
 * letterboxed: an icon that keeps its own transparent margin is the caller's
 * business, and silently adding one would change art the user already framed.
 */
export async function importCustomAppIcon(input: {
  readonly sourcePath: string;
  readonly userDataPath: string;
}): Promise<CustomAppIcon> {
  const info = await stat(input.sourcePath).catch(() => undefined);
  if (!info?.isFile()) throw new CustomAppIconError('unreadable', 'not a file');
  if (info.size > CUSTOM_ICON_MAX_INPUT_BYTES) {
    throw new CustomAppIconError('too_large', `over ${CUSTOM_ICON_MAX_INPUT_BYTES} bytes`);
  }

  // An undecodable file comes back EMPTY rather than throwing — the same trap
  // the shipped set falls into, and the reason emptiness is the failure test.
  const source = nativeImage.createFromPath(input.sourcePath);
  if (source.isEmpty()) throw new CustomAppIconError('unreadable', 'no decodable image');

  const { width, height } = source.getSize();
  if (Math.min(width, height) < CUSTOM_ICON_MIN_EDGE) {
    throw new CustomAppIconError('too_small', `${width}×${height} is under ${CUSTOM_ICON_MIN_EDGE}`);
  }

  const edge = Math.min(width, height);
  const squared =
    width === height
      ? source
      : source.crop({
          x: Math.round((width - edge) / 2),
          y: Math.round((height - edge) / 2),
          width: edge,
          height: edge,
        });
  const png = squared
    .resize({ width: CUSTOM_ICON_EDGE, height: CUSTOM_ICON_EDGE, quality: 'better' })
    .toPNG();
  if (png.length === 0) throw new CustomAppIconError('unreadable', 're-encode produced nothing');

  const id = randomUUID().replaceAll('-', '');
  try {
    await mkdir(customAppIconDirectory(input.userDataPath), { recursive: true });
    await writeFile(resolveCustomAppIconPath(input.userDataPath, id), png);
  } catch (error) {
    throw new CustomAppIconError('write_failed', `could not store the icon: ${String(error)}`);
  }
  return `${CUSTOM_APP_ICON_PREFIX}${id}` as CustomAppIcon;
}
