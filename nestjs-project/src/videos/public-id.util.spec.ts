import { generatePublicId } from './public-id.util';

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
