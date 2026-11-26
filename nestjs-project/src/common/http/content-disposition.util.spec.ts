import { attachmentDisposition } from './content-disposition.util';

describe('attachmentDisposition', () => {
  it('should wrap the file name in an attachment quoted-string', () => {
    expect(attachmentDisposition('happy.mp4')).toBe(
      'attachment; filename="happy.mp4"',
    );
  });

  it('should remove quotes, backslashes and control characters', () => {
    expect(attachmentDisposition('a"b\\c\r\n\u007fd.mp4')).toBe(
      'attachment; filename="abcd.mp4"',
    );
  });

  it('should keep non-ASCII characters as they are', () => {
    expect(attachmentDisposition('vídeo.mp4')).toBe(
      'attachment; filename="vídeo.mp4"',
    );
  });
});
