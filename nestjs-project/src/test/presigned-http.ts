import { request } from 'node:http';

export interface PresignedRequestOptions {
  method: 'GET' | 'PUT' | 'HEAD';
  headers?: Record<string, string>;
  body?: Buffer | string;
}

export interface PresignedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Sends a request to a URL signed by the public S3 client from inside the
 * test container. The TCP connection goes to the `S3_ENDPOINT` host
 * (`minio:9000`), because `localhost:9000` is the container itself here, while
 * path, query and the original `Host` header are kept untouched: SigV4 signs
 * the `Host`, so rewriting the URL would invalidate the signature.
 */
export function requestPresigned(
  url: string,
  options: PresignedRequestOptions,
): Promise<PresignedResponse> {
  const signed = new URL(url);
  const target = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');
  const body =
    typeof options.body === 'string' ? Buffer.from(options.body) : options.body;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: Number(target.port || 80),
        method: options.method,
        path: `${signed.pathname}${signed.search}`,
        headers: {
          ...options.headers,
          Host: signed.host,
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
