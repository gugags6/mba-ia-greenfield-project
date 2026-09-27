import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  THUMBNAIL_FALLBACK_OFFSET_SECONDS,
  THUMBNAIL_OFFSET_RATIO,
} from '../videos/videos.constants';

const execFileAsync = promisify(execFile);

/**
 * 10% of the video's duration, or the fixed fallback offset when the
 * duration is unknown/zero — per phase-03-videos/TD-05.
 */
export function computeThumbnailOffset(durationSeconds: number): number {
  return durationSeconds > 0
    ? durationSeconds * THUMBNAIL_OFFSET_RATIO
    : THUMBNAIL_FALLBACK_OFFSET_SECONDS;
}

/**
 * Captures a single frame at `offsetSeconds` into `outputPath` as a JPEG,
 * per phase-03-videos/TD-05.
 */
export async function extractThumbnail(
  inputPath: string,
  offsetSeconds: number,
  outputPath: string,
): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    String(offsetSeconds),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outputPath,
  ]);
}
