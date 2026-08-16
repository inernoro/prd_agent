import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { r2BackupConfigFromEnv, uploadAndVerifyR2Backup } from '../../src/services/infra-backup-r2.js';

const created: string[] = [];
afterEach(() => {
  for (const file of created.splice(0)) fs.rmSync(file, { force: true });
});

describe('R2 离机备份', () => {
  it('配置缺项时返回未知而不是假装已配置', () => {
    expect(r2BackupConfigFromEnv({ R2_ENDPOINT: 'https://storage.invalid' })).toBeNull();
  });

  it('上传后必须按大小和 sha256 回读校验', async () => {
    const file = path.join(os.tmpdir(), `cds-r2-test-${process.pid}.bin`);
    created.push(file);
    fs.writeFileSync(file, 'verified-backup');
    const calls: Array<{ method: string; authorization: string }> = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      calls.push({ method: String(init?.method), authorization: String(headers.get('authorization')) });
      if (init?.method === 'PUT') {
        const body = init.body as unknown as AsyncIterable<Buffer>;
        for await (const _chunk of body) { /* consume the production stream */ }
        return new Response('', { status: 200 });
      }
      return new Response('', {
        status: 200,
        headers: {
          'content-length': String(Buffer.byteLength('verified-backup')),
          'x-amz-meta-sha256': 'd236906afac4baaba89924427135f1f0f5d22fbb1c46a0e176e276aabb215add',
        },
      });
    };
    const out = await uploadAndVerifyR2Backup({
      config: {
        endpoint: 'https://storage.invalid', bucket: 'backup', prefix: 'cds',
        accessKeyId: 'access-id', secretAccessKey: 'secret-key',
      },
      filePath: file,
      fileName: 'snapshot.bin',
      now: new Date('2026-08-17T00:00:00Z'),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(out.objectKey).toBe('cds/snapshot.bin');
    expect(out.bytes).toBe(Buffer.byteLength('verified-backup'));
    expect(calls.map((call) => call.method)).toEqual(['PUT', 'HEAD']);
    expect(calls.every((call) => call.authorization.startsWith('AWS4-HMAC-SHA256'))).toBe(true);
  });

  it('远端 checksum 不一致时失败', async () => {
    const file = path.join(os.tmpdir(), `cds-r2-test-bad-${process.pid}.bin`);
    created.push(file);
    fs.writeFileSync(file, 'verified-backup');
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PUT') {
        const body = init.body as unknown as AsyncIterable<Buffer>;
        for await (const _chunk of body) { /* consume the production stream */ }
        return new Response('', { status: 200 });
      }
      return new Response('', { status: 200, headers: { 'content-length': '15', 'x-amz-meta-sha256': 'wrong' } });
    };
    await expect(uploadAndVerifyR2Backup({
      config: {
        endpoint: 'https://storage.invalid', bucket: 'backup', prefix: 'cds',
        accessKeyId: 'access-id', secretAccessKey: 'secret-key',
      },
      filePath: file,
      fileName: 'snapshot.bin',
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow('checksum');
  });
});
