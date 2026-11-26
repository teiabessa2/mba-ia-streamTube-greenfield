import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { useTestQueuePrefix } from '../test/test-queue';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with config, TypeORM, queue, storage and media wiring the VideoProcessor', async () => {
    const testPrefix = useTestQueuePrefix('worker-module');
    // compile() does not run onModuleInit: no BullMQ worker starts consuming.
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessor)).toBeInstanceOf(VideoProcessor);
    // Video#channel resolves: Channel/User metadata is registered too.
    expect(
      moduleRef
        .get(DataSource)
        .getMetadata(Video)
        .findRelationWithPropertyPath('channel'),
    ).toBeDefined();

    await moduleRef.close();
    testPrefix.restore();
  });
});
