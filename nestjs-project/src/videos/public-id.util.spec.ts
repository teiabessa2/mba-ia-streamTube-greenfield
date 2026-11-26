import { generatePublicId, isPublicIdFormat } from './public-id.util';

describe('generatePublicId', () => {
  it('should return 11 characters from the base64url alphabet', () => {
    const id = generatePublicId();

    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should not collide across 10,000 calls', () => {
    const ids = new Set(Array.from({ length: 10_000 }, generatePublicId));

    expect(ids.size).toBe(10_000);
  });
});

describe('isPublicIdFormat', () => {
  it('should accept every generated id', () => {
    for (let i = 0; i < 1_000; i++) {
      expect(isPublicIdFormat(generatePublicId())).toBe(true);
    }
  });

  it.each([
    'x',
    'AAAAAAAAAA',
    'AAAAAAAAAAAA',
    'AAAAAAAAAA=',
    'AAAAA/AAAAA',
    '',
  ])('should reject %p', (value) => {
    expect(isPublicIdFormat(value)).toBe(false);
  });
});
