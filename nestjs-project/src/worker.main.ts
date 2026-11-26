import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/** Video worker entrypoint: application context without HTTP (phase-03-videos/TD-04). */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Closes the BullMQ worker on SIGTERM, so `docker compose stop` drains cleanly.
  app.enableShutdownHooks();
  new Logger('VideoWorker').log('Video worker started');
}

void bootstrap();
