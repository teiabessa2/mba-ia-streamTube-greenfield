import { deriveVideoTitle } from './video-title.util';

describe('deriveVideoTitle', () => {
  it('should drop only the last extension', () => {
    expect(deriveVideoTitle('clip.final.mp4')).toBe('clip.final');
  });

  it('should trim the name left after dropping the extension', () => {
    expect(deriveVideoTitle('  Minhas férias.mp4 ')).toBe('Minhas férias');
  });

  it('should fall back to the trimmed file name when nothing is left before the extension', () => {
    expect(deriveVideoTitle('.mp4')).toBe('.mp4');
    expect(deriveVideoTitle(' .mp4')).toBe('.mp4');
  });

  it('should cap the title at 100 characters', () => {
    const fileName = `${'a'.repeat(251)}.mp4`;

    expect(deriveVideoTitle(fileName)).toBe('a'.repeat(100));
  });

  it('should count code points, never splitting a surrogate pair', () => {
    const fileName = `${'😀'.repeat(101)}.mp4`;

    const title = deriveVideoTitle(fileName);

    expect(Array.from(title)).toHaveLength(100);
    expect(title).toBe('😀'.repeat(100));
  });
});
