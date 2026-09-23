import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  downloadAndVerifyR2Backup,
  r2BackupConfigFromEnv,
  uploadAndVerifyR2Backup,
  uploadAndVerifyR2Object,
} from '../../src/services/infra-backup-r2.js';

const created: string[] = [];
afterEach(() => {
  for (const file of created.splice(0)) fs.rmSync(file, { force: true });
});

describe('R2 离机备份', () => {
  it('配置缺项时返回未知而不是假装已配置', () => {
    expect(r2BackupConfigFromEnv({ R2_ENDPOINT: 'https://storage.invalid' })).toBeNull();
  });

  it('远端拒绝时保留结构化错误码以区分权限与签名问题', async () => {
    const file = path.join(os.tmpdir(), `cds-r2-download-denied-${process.pid}.bin`);
    created.push(file);
    const fetchImpl = async (): Promise<Response> => new Response(
      '<Error><Code>AccessDenied</Code><Message>source address is not allowed</Message></Error>',
      { status: 403 },
    );
    await expect(downloadAndVerifyR2Backup({
      config: {
        endpoint: 'https://storage.invalid', bucket: 'backup', prefix: 'cds',
        accessKeyId: 'access-id', secretAccessKey: 'secret-key',
      },
      objectKey: 'cds/snapshot.bin',
      filePath: file,
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toThrow('AccessDenied: source address is not allowed');
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

  describe('内存对象上传（验收报告 / 审计日志）', () => {
    const config = {
      endpoint: 'https://storage.invalid', bucket: 'reports', prefix: 'cds',
      accessKeyId: 'access-id', secretAccessKey: 'secret-key',
    };
    const html = Buffer.from('<!doctype html><title>验收报告</title>'.repeat(40));
    const sha = crypto.createHash('sha256').update(html).digest('hex');

    // 模拟边缘节点：请求没声明 identity 时，文本对象按压缩后的长度回应。
    function edgeLikeFetch(seen: Array<{ method: string; headers: Headers }>) {
      return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        seen.push({ method: String(init?.method), headers });
        if (init?.method === 'PUT') return new Response('', { status: 200 });
        const identity = headers.get('accept-encoding') === 'identity';
        return new Response(null, {
          status: 200,
          headers: identity
            ? { 'content-length': String(html.byteLength), 'x-amz-meta-sha256': sha }
            : { 'content-length': '97', 'content-encoding': 'gzip', 'x-amz-meta-sha256': sha },
        });
      };
    }

    it('回读校验声明不压缩，文本对象的长度按原始字节比对', async () => {
      const seen: Array<{ method: string; headers: Headers }> = [];
      const out = await uploadAndVerifyR2Object({
        config, objectKey: 'cds-acceptance-reports/p/r.html', body: html,
        contentType: 'text/html; charset=utf-8', fetchImpl: edgeLikeFetch(seen) as typeof fetch,
      });
      expect(out).toEqual({ objectKey: 'cds-acceptance-reports/p/r.html', bytes: html.byteLength, sha256: sha });
      const head = seen.find((c) => c.method === 'HEAD');
      expect(head?.headers.get('accept-encoding')).toBe('identity');
      // 这个头不能进签名：边缘可能改写它，签进去会变成签名不匹配。
      expect(head?.headers.get('authorization')).not.toContain('accept-encoding');
    });

    it('长度与 checksum 分开报，读的人知道该去查传输层还是对象本身', async () => {
      const fetchImpl = async (_i: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'PUT') return new Response('', { status: 200 });
        return new Response(null, { status: 200, headers: { 'content-length': '97', 'content-encoding': 'gzip' } });
      };
      await expect(uploadAndVerifyR2Object({
        config, objectKey: 'k.html', body: html, fetchImpl: fetchImpl as typeof fetch,
      })).rejects.toThrow(`长度不一致：本地 ${html.byteLength} 字节，远端回应 97 字节（content-encoding=gzip）；远端没有返回 sha256 元数据`);
    });
  });
});
