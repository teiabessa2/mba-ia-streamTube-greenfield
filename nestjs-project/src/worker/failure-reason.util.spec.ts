import { toFailureReason } from './failure-reason.util';

describe('toFailureReason', () => {
  it('should replace a presigned URL followed by the ffmpeg ": " separator, keeping the cause', () => {
    expect(
      toFailureReason(
        'ffprobe could not read the file: http://minio:9000/b/videos/1/original?X-Amz-Signature=s&x-id=GetObject: Invalid data found when processing input',
      ),
    ).toBe(
      'ffprobe could not read the file: <source>: Invalid data found when processing input',
    );
  });

  it('should replace every URL, including one at the end of the message', () => {
    expect(toFailureReason('a http://h:1/x?sig=1 b https://h/y?sig=2')).toBe(
      'a <source> b <source>',
    );
  });

  it('should keep a message without URLs unchanged', () => {
    expect(toFailureReason('No video stream found in the file')).toBe(
      'No video stream found in the file',
    );
  });
});
