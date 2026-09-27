import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class InvalidVideoFormatError extends Error {}

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string };
}

/**
 * Runs ffprobe against a local file and returns its video stream metadata.
 * Throws InvalidVideoFormatError when ffprobe can't process the file or finds
 * no video stream — per phase-03-videos/TD-10, this is the authoritative,
 * non-retryable format gate (as opposed to a transient I/O error, which
 * propagates as a plain Error so BullMQ retries the job).
 */
export async function probeVideo(filePath: string): Promise<ProbeResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]));
  } catch (err) {
    throw new InvalidVideoFormatError(
      `ffprobe could not process the file: ${(err as Error).message}`,
    );
  }

  let data: FfprobeOutput;
  try {
    data = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new InvalidVideoFormatError('ffprobe returned malformed output');
  }

  const videoStream = data.streams?.find((s) => s.codec_type === 'video');
  if (!videoStream || !videoStream.codec_name) {
    throw new InvalidVideoFormatError('No video stream found in the file');
  }

  const durationSeconds = parseFloat(
    data.format?.duration ?? videoStream.duration ?? '0',
  );
  const bitrate = parseInt(
    data.format?.bit_rate ?? videoStream.bit_rate ?? '0',
    10,
  );

  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    codec: videoStream.codec_name,
    bitrate: Number.isFinite(bitrate) ? bitrate : 0,
  };
}
