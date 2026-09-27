export const ACCEPTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
] as const;

export const MULTIPART_PART_SIZE_BYTES = 50 * 1024 * 1024;

export const MAX_VIDEO_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const VIDEO_SLUG_LENGTH = 16;

/** Codecs accepted as authoritative validation by the worker's ffprobe check (per phase-03-videos/TD-10). */
export const ACCEPTED_VIDEO_CODECS = [
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
] as const;

/** Offset (fraction of duration) used to pick the thumbnail frame, per phase-03-videos/TD-05. */
export const THUMBNAIL_OFFSET_RATIO = 0.1;
export const THUMBNAIL_FALLBACK_OFFSET_SECONDS = 1.0;
