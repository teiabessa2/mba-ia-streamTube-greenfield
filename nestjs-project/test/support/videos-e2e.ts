import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';

const PASSWORD = 'password123';

/** Boots `AppModule` reproducing the global config of `main.ts`. */
export async function createVideosE2eApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export interface AuthenticatedUser {
  userId: string;
  accessToken: string;
}

/** register → confirm (token captured from the mail) → login (phase 02 flow). */
export async function registerAndLogin(
  app: INestApplication<App>,
  email: string,
): Promise<AuthenticatedUser> {
  let confirmationToken = '';
  jest
    .spyOn(app.get(MailService), 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  const register = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: PASSWORD })
    .expect(201);

  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  return {
    userId: (register.body as { id: string }).id,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}
