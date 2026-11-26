import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Internal endpoint (Compose service name) — used for all real traffic.
  endpoint: process.env.S3_ENDPOINT as string,
  // Host reachable by the consumer of presigned URLs — used only to sign.
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT as string,
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  bucket: process.env.S3_BUCKET as string,
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
}));
