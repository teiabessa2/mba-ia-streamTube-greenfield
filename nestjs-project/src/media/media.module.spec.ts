import { Test } from '@nestjs/testing';
import { MEDIA_DEFAULTS, MEDIA_OPTIONS } from './media.constants';
import { MediaModule } from './media.module';
import { MediaService } from './media.service';

describe('MediaModule', () => {
  it('should compile and provide MediaService with the default time limits', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MediaModule],
    }).compile();

    expect(moduleRef.get(MediaService)).toBeInstanceOf(MediaService);
    expect(moduleRef.get(MEDIA_OPTIONS)).toEqual({
      probeTimeoutMs: MEDIA_DEFAULTS.PROBE_TIMEOUT_MS,
      frameTimeoutMs: MEDIA_DEFAULTS.FRAME_TIMEOUT_MS,
    });
    await moduleRef.close();
  });
});
