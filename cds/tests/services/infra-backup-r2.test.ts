import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  downloadAndVerifyR2Backup,
  r2BackupConfigFromEnv,
  uploadAndVerifyR2Backup,
} from '../../src/services/infra-backup-r2.js';

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

  it('下载后按远端大小和 sha256 校验再原子落盘', async () => {
    const file = path.join(os.tmpdir(), `cds-r2-download-${process.pid}.bin`);
    created.push(file);
    const body = Buffer.from('restorable-backup');
    const sha256 = '75cc973cdc0b77c0a27d9bb21caa779c6e40a041e067cbb4ff612d206da8b56c';
    const calls: string[] = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push(String(init?.method));
      if (init?.method === 'HEAD') {
        return new Response('', {
          status: 200,
          headers: { 'content-length': String(body.byteLength), 'x-amz-meta-sha256': sha256 },
        });
      }
      return new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } });
    };
    const out = await downloadAndVerifyR2Backup({
      config: {
        endpoint: 'https://storage.invalid', bucket: 'backup', prefix: 'cds',
        accessKeyId: 'access-id', secretAccessKey: 'secret-key',
      },
      objectKey: 'cds/snapshot.bin',
      filePath: file,
      now: new Date('2026-08-17T00:00:00Z'),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(calls).toEqual(['HEAD', 'GET']);
    expect(out).toEqual({ objectKey: 'cds/snapshot.bin', bytes: body.byteLength, sha256 });
    expect(fs.readFileSync(file)).toEqual(body);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(os.tmpdir()).some((name) => name.startsWith(`cds-r2-download-${process.pid}.bin.tmp-`))).toBe(false);
  });

  it('下载校验失败时删除临时文件且不覆盖既有目标', async () => {
    const file = path.join(os.tmpdir(), `cds-r2-download-bad-${process.pid}.bin`);
    created.push(file);
    fs.writeFileSync(file, 'known-good');
    const body = Buffer.from('corrupted');
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'HEAD') {
        return new Response('', {
          status: 200,
          headers: {
            'content-length': String(body.byteLength),
            'x-amz-meta-sha256': 'a'.repeat(64),
          },
        });
      }
      return new Response(body, { status: 200 });
    };
    await expect(downloadAndVerifyR2Backup({
      config: {
        endpoint: 'https://storage.invalid', bucket: 'backup', prefix: 'cds',
        accessKeyId: 'access-id', secretAccessKey: 'secret-key',
      },
      objectKey: 'cds/snapshot.bin',
      filePath: file,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow('checksum');
    expect(fs.readFileSync(file, 'utf8')).toBe('known-good');
    expect(fs.readdirSync(os.tmpdir()).some((name) => name.startsWith(`cds-r2-download-bad-${process.pid}.bin.tmp-`))).toBe(false);
  });
});
