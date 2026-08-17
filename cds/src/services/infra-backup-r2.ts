import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface R2BackupConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface VerifiedRemoteBackup {
  objectKey: string;
  bytes: number;
  sha256: string;
}

/**
 * 从 R2 取回一份备份，并在正式文件名出现前完成大小与 sha256 双校验。
 *
 * 下载必须走流式管道：基础设施备份可能远大于 Node 可用堆，不能先读进 Buffer。
 * 临时文件只在校验通过后原子改名，网络中断或进程退出不会留下看似可恢复的半截文件。
 */
export async function downloadAndVerifyR2Backup(opts: {
  config: R2BackupConfig;
  objectKey: string;
  filePath: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedRemoteBackup> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = objectUrl(opts.config, opts.objectKey);
  const now = opts.now ?? new Date();
  const emptyHash = crypto.createHash('sha256').update('').digest('hex');
  const head = await fetchImpl(url, {
    method: 'HEAD',
    headers: signedHeaders({
      config: opts.config,
      method: 'HEAD',
      url,
      payloadHash: emptyHash,
      now,
    }),
  });
  if (!head.ok) throw new Error(`离机备份下载前校验失败（HTTP ${head.status}）`);
  const expectedBytes = Number(head.headers.get('content-length') || '0');
  const expectedSha256 = String(head.headers.get('x-amz-meta-sha256') || '').trim().toLowerCase();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('离机备份缺少可信的大小或 sha256 元数据');
  }

  const get = await fetchImpl(url, {
    method: 'GET',
    headers: signedHeaders({
      config: opts.config,
      method: 'GET',
      url,
      payloadHash: emptyHash,
      now: new Date(now.getTime() + 1),
    }),
  });
  if (!get.ok || !get.body) throw new Error(`离机备份下载失败（HTTP ${get.status}）`);

  await fs.promises.mkdir(path.dirname(opts.filePath), { recursive: true, mode: 0o700 });
  const tmp = `${opts.filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(get.body as never),
      digest,
      fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
    );
    const actualSha256 = hash.digest('hex');
    if (bytes !== expectedBytes || actualSha256 !== expectedSha256) {
      throw new Error('离机备份下载后的大小或 checksum 与远端元数据不一致');
    }
    await fs.promises.rename(tmp, opts.filePath);
    return { objectKey: opts.objectKey, bytes, sha256: actualSha256 };
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function uploadAndVerifyR2Object(opts: {
  config: R2BackupConfig;
  objectKey: string;
  body: Buffer;
  contentType?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedRemoteBackup> {
  if (opts.body.byteLength <= 0) throw new Error('拒绝上传空对象');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sha256 = crypto.createHash('sha256').update(opts.body).digest('hex');
  const url = objectUrl(opts.config, opts.objectKey);
  const now = opts.now ?? new Date();
  const put = await fetchImpl(url, {
    method: 'PUT',
    headers: signedHeaders({
      config: opts.config,
      method: 'PUT',
      url,
      payloadHash: sha256,
      now,
      extra: {
        'content-length': String(opts.body.byteLength),
        'content-type': opts.contentType || 'application/octet-stream',
        'x-amz-meta-sha256': sha256,
      },
    }),
    body: opts.body as unknown as BodyInit,
  });
  if (!put.ok) throw new Error(`离机对象上传失败（HTTP ${put.status}）`);
  const head = await fetchImpl(url, {
    method: 'HEAD',
    headers: signedHeaders({
      config: opts.config,
      method: 'HEAD',
      url,
      payloadHash: crypto.createHash('sha256').update('').digest('hex'),
      now: new Date(now.getTime() + 1),
    }),
  });
  if (!head.ok) throw new Error(`离机对象回读校验失败（HTTP ${head.status}）`);
  const bytes = Number(head.headers.get('content-length') || '0');
  const remoteSha256 = String(head.headers.get('x-amz-meta-sha256') || '').trim().toLowerCase();
  if (bytes !== opts.body.byteLength || remoteSha256 !== sha256) {
    throw new Error('离机对象大小或 checksum 与本地产物不一致');
  }
  return { objectKey: opts.objectKey, bytes, sha256 };
}

export function r2BackupConfigFromEnv(env: Record<string, string | undefined> = process.env): R2BackupConfig | null {
  const endpoint = String(env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  const bucket = String(env.R2_BUCKET || '').trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix: String(env.R2_PREFIX || 'cds-infra-backups').trim().replace(/^\/+|\/+$/g, ''),
  };
}

function hmac(key: crypto.BinaryLike | crypto.KeyObject, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function encodePath(value: string): string {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function objectUrl(config: R2BackupConfig, objectKey: string): URL {
  return new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodePath(objectKey)}`);
}

function signedHeaders(opts: {
  config: R2BackupConfig;
  method: 'PUT' | 'HEAD' | 'GET';
  url: URL;
  payloadHash: string;
  now: Date;
  extra?: Record<string, string>;
}): Record<string, string> {
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: opts.url.host,
    'x-amz-content-sha256': opts.payloadHash,
    'x-amz-date': amzDate,
    ...(opts.extra || {}),
  };
  const keys = Object.keys(headers).map((key) => key.toLowerCase()).sort();
  const canonicalHeaders = keys.map((key) => `${key}:${String(headers[key]).trim()}\n`).join('');
  const signed = keys.join(';');
  const canonical = [
    opts.method,
    opts.url.pathname,
    opts.url.searchParams.toString(),
    canonicalHeaders,
    signed,
    opts.payloadHash,
  ].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const dateKey = hmac(`AWS4${opts.config.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.config.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => { bytes += Buffer.byteLength(chunk); hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), bytes };
}

export async function uploadAndVerifyR2Backup(opts: {
  config: R2BackupConfig;
  filePath: string;
  fileName: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<VerifiedRemoteBackup> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const digest = await sha256File(opts.filePath);
  if (digest.bytes <= 0) throw new Error('离机备份拒绝上传空文件');
  const objectKey = [opts.config.prefix, opts.fileName].filter(Boolean).join('/');
  const url = objectUrl(opts.config, objectKey);
  const now = opts.now ?? new Date();
  const putHeaders = signedHeaders({
    config: opts.config,
    method: 'PUT',
    url,
    payloadHash: digest.sha256,
    now,
    extra: {
      'content-length': String(digest.bytes),
      'x-amz-meta-sha256': digest.sha256,
    },
  });
  const put = await fetchImpl(url, {
    method: 'PUT',
    headers: putHeaders,
    body: fs.createReadStream(opts.filePath) as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!put.ok) throw new Error(`离机备份上传失败（HTTP ${put.status}）`);

  const head = await fetchImpl(url, {
    method: 'HEAD',
    headers: signedHeaders({
      config: opts.config,
      method: 'HEAD',
      url,
      payloadHash: crypto.createHash('sha256').update('').digest('hex'),
      now: new Date(now.getTime() + 1),
    }),
  });
  if (!head.ok) throw new Error(`离机备份回读校验失败（HTTP ${head.status}）`);
  const remoteBytes = Number(head.headers.get('content-length') || '0');
  const remoteSha256 = String(head.headers.get('x-amz-meta-sha256') || '').trim().toLowerCase();
  if (remoteBytes !== digest.bytes || remoteSha256 !== digest.sha256) {
    throw new Error('离机备份大小或 checksum 与本地产物不一致');
  }
  return { objectKey, bytes: digest.bytes, sha256: digest.sha256 };
}
