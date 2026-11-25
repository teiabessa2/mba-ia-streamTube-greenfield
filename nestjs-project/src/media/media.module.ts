import { Module } from '@nestjs/common';
import { MEDIA_DEFAULTS, MEDIA_OPTIONS } from './media.constants';
import { MediaService } from './media.service';
import type { MediaOptions } from './media.types';

@Module({
  providers: [
    {
      provide: MEDIA_OPTIONS,
      useValue: {
        probeTimeoutMs: MEDIA_DEFAULTS.PROBE_TIMEOUT_MS,
        frameTimeoutMs: MEDIA_DEFAULTS.FRAME_TIMEOUT_MS,
      } satisfies MediaOptions,
    },
    MediaService,
  ],
  exports: [MediaService],
})
export class MediaModule {}
