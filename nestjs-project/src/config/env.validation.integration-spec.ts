import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://minio:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
};

const withoutKeys = (...keys: string[]): Record<string, string> => {
  const env: Record<string, string> = { ...requiredEnv };
  for (const key of keys) delete env[key];
  return env;
};

const validateExact = (env: Record<string, string>) =>
  envValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, string>;
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage (S3_*)', () => {
  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET',
  ])('should reject the env when the required key %s is missing', (key) => {
    const { error } = validateExact(withoutKeys(key));
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject S3_ENDPOINT that is not a URI', () => {
    const { error } = validate({ S3_ENDPOINT: 'minio' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should reject S3_FORCE_PATH_STYLE outside true/false', () => {
    const { error } = validate({ S3_FORCE_PATH_STYLE: 'yes' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_FORCE_PATH_STYLE');
  });

  it('should apply defaults for S3_REGION and S3_FORCE_PATH_STYLE', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, unknown>;
    expect(value.S3_REGION).toBe('us-east-1');
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
  });
});

describe('envValidationSchema — queue (REDIS_* / QUEUE_*)', () => {
  it('should apply defaults for REDIS_HOST, REDIS_PORT, QUEUE_PREFIX and QUEUE_BACKOFF_DELAY_MS', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const value = result.value as Record<string, unknown>;
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('streamtube');
    expect(value.QUEUE_BACKOFF_DELAY_MS).toBe(30000);
  });

  it('should reject a negative QUEUE_BACKOFF_DELAY_MS', () => {
    const { error } = validate({ QUEUE_BACKOFF_DELAY_MS: '-1' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_BACKOFF_DELAY_MS');
  });

  it('should reject a non-integer QUEUE_BACKOFF_DELAY_MS', () => {
    const { error } = validate({ QUEUE_BACKOFF_DELAY_MS: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_BACKOFF_DELAY_MS');
  });

  it('should accept QUEUE_BACKOFF_DELAY_MS=0', () => {
    const result = validate({ QUEUE_BACKOFF_DELAY_MS: '0' });
    expect(result.error).toBeUndefined();
    expect(
      (result.value as Record<string, unknown>).QUEUE_BACKOFF_DELAY_MS,
    ).toBe(0);
  });

  it('should reject a REDIS_PORT outside the port range', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });
});

describe('ConfigModule boot — storage and queue namespaces', () => {
  const ENV_KEYS = [
    ...Object.keys(requiredEnv),
    'S3_REGION',
    'S3_FORCE_PATH_STYLE',
    'REDIS_HOST',
    'REDIS_PORT',
    'QUEUE_PREFIX',
    'QUEUE_BACKOFF_DELAY_MS',
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const boot = async (env: Record<string, string>): Promise<TestingModule> => {
    Object.assign(process.env, env);
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [storageConfig, queueConfig],
          validationSchema: envValidationSchema,
          validationOptions: { allowUnknown: true, abortEarly: false },
        }),
      ],
    }).compile();
  };

  it('should abort the boot naming S3_BUCKET when it is missing', async () => {
    await expect(boot(withoutKeys('S3_BUCKET'))).rejects.toThrow(/S3_BUCKET/);
  });

  it('should abort the boot when QUEUE_BACKOFF_DELAY_MS=-1', async () => {
    await expect(
      boot({ ...requiredEnv, QUEUE_BACKOFF_DELAY_MS: '-1' }),
    ).rejects.toThrow(/QUEUE_BACKOFF_DELAY_MS/);
  });

  it('should resolve queue defaults when REDIS_HOST, QUEUE_PREFIX and QUEUE_BACKOFF_DELAY_MS are unset', async () => {
    const moduleRef = await boot({ ...requiredEnv });
    const queue = moduleRef.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
    );
    expect(queue).toEqual({
      host: 'redis',
      port: 6379,
      prefix: 'streamtube',
      backoffDelayMs: 30000,
    });
  });

  it('should expose S3_FORCE_PATH_STYLE=true as boolean true in the storage namespace', async () => {
    const moduleRef = await boot({
      ...requiredEnv,
      S3_FORCE_PATH_STYLE: 'true',
    });
    const storage = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    expect(storage.forcePathStyle).toBe(true);
    expect(storage).toMatchObject({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'bucket',
    });
  });

  it('should expose S3_FORCE_PATH_STYLE=false as boolean false in the storage namespace', async () => {
    const moduleRef = await boot({
      ...requiredEnv,
      S3_FORCE_PATH_STYLE: 'false',
    });
    const storage = moduleRef.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
    expect(storage.forcePathStyle).toBe(false);
  });
});
