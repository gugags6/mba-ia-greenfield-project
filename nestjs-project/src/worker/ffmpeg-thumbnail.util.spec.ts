import { computeThumbnailOffset } from './ffmpeg-thumbnail.util';

describe('computeThumbnailOffset', () => {
  it('returns 10% of the duration when duration is known', () => {
    expect(computeThumbnailOffset(120)).toBe(12);
    expect(computeThumbnailOffset(1)).toBeCloseTo(0.1);
  });

  it('returns the 1.0s fallback when duration is 0/unknown', () => {
    expect(computeThumbnailOffset(0)).toBe(1.0);
  });
});
