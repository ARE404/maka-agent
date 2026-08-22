import { randomUUID } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { nativeImage } from 'electron';
import { CUSTOM_APP_ICON_PREFIX, type CustomAppIcon } from '@maka/core/settings';
import {
  CustomAppIconError,
  CUSTOM_ICON_EDGE,
  CUSTOM_ICON_MAX_EDGE,
  CUSTOM_ICON_MAX_INPUT_BYTES,
  CUSTOM_ICON_MIN_EDGE,
  customAppIconDirectory,
  resolveCustomAppIconPath,
} from './custom-app-icon-store.js';
import { readImageHeader } from './image-header.js';

/**
 * Decode, square, scale, store. Non-square art is centre-cropped rather than
 * letterboxed: an icon that keeps its own transparent margin is the caller's
 * business, and silently adding one would change art the user already framed.
 *
 * The file is read ONCE into a capped buffer and everything downstream works
 * on that snapshot. Reading first closes two holes at the same time: the path
 * cannot be swapped between a stat and a decode, and the dimensions are known
 * from the header before any decoder allocates a bitmap for them.
 */
export async function importCustomAppIcon(input: {
  readonly sourcePath: string;
  readonly userDataPath: string;
}): Promise<CustomAppIcon> {
  const bytes = await readCapped(input.sourcePath);

  const header = readImageHeader(bytes);
  if (!header) throw new CustomAppIconError('unsupported_format', 'not a PNG or JPEG');
  const { width, height } = header;
  if (Math.max(width, height) > CUSTOM_ICON_MAX_EDGE) {
    throw new CustomAppIconError('too_many_pixels', `${width}×${height} is over ${CUSTOM_ICON_MAX_EDGE}`);
  }
  if (Math.min(width, height) < CUSTOM_ICON_MIN_EDGE) {
    throw new CustomAppIconError('too_small', `${width}×${height} is under ${CUSTOM_ICON_MIN_EDGE}`);
  }

  // Same bytes the header came from — nothing re-read from the path.
  const source = nativeImage.createFromBuffer(bytes);
  if (source.isEmpty()) throw new CustomAppIconError('unreadable', 'no decodable image');

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

/**
 * One read, one byte cap. Reading a byte past the cap is how oversize is
 * detected — asking the filesystem for the size first and trusting it is the
 * check that a swapped path defeats.
 */
async function readCapped(path: string): Promise<Buffer> {
  const file = await open(path, 'r').catch(() => undefined);
  if (!file) throw new CustomAppIconError('unreadable', 'not a readable file');
  try {
    const buffer = Buffer.alloc(CUSTOM_ICON_MAX_INPUT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CUSTOM_ICON_MAX_INPUT_BYTES) {
      throw new CustomAppIconError('too_large', `over ${CUSTOM_ICON_MAX_INPUT_BYTES} bytes`);
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
