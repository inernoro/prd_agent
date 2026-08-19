import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

import {
  createCdsSystemOffsiteBackupRouter,
  normalizeOffsiteInput,
  describeOffsiteBackup,
  maskAccessKeyId,
} from '../../src/routes/cds-system-offsite-backup.js';

/**
 * 离机备份配置入口。
 *
 * 背景：这四个变量此前只能在宿主上手改 `.cds.env` 再重启，没有任何入口，也从不校验。
 * 结果是 2026-08-18 每一轮备份都「导出成功 → 上传 401 → 连本地那份一起删」，
 * 本地周期备份停了半天；而用户那边的记忆是「上次录入过一次，后来失效了」——
 * 没有录入界面、没有当场校验，这种事必然重演。
 *
 * 所以这一组用例守的核心只有一条：**没通过实测的凭据，绝不许落进 `.cds.env`**。
 */
describe('输入归一化', () => {
  it('bucketName 也认——面板复制出来的是 R2_BUCKET_NAME，代码读的是 R2_BUCKET', () => {
    // 就这一个字母之差，足以让人「录入了一次」却整条不生效。
    const r = normalizeOffsiteInput({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucketName: 'am-west',
      accessKeyId: 'k',
      secretAccessKey: 's',
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.bucket).toBe('am-west');
  });

  it('endpoint 末尾斜杠、prefix 首尾斜杠都归一化掉', () => {
    const r = normalizeOffsiteInput({
      endpoint: 'https://acct.r2.cloudflarestorage.com//',
      bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', prefix: '/x/y/',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
      expect(r.value.prefix).toBe('x/y');
    }
  });

  it('缺哪几项要点名，不能只说一句「配置不完整」', () => {
    const r = normalizeOffsiteInput({ endpoint: 'https://x', bucket: 'b' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(['accessKeyId', 'secretAccessKey']);
  });
});

describe('对外描述只进不出', () => {
  it('access key 只回尾四位，secret 一个字符都不回', () => {
    expect(maskAccessKeyId('36a2137b240045aeb82e5e7ef06c5009')).toBe('****5009');
    const s = describeOffsiteBackup({
      R2_ENDPOINT: 'https://x', R2_BUCKET: 'b',
      R2_ACCESS_KEY_ID: 'abcdefgh', R2_SECRET_ACCESS_KEY: 'topsecret',
    });
    expect(JSON.stringify(s)).not.toContain('topsecret');
    expect(JSON.stringify(s)).not.toContain('abcdefgh');
    expect(s.configured).toBe(true);
  });

  it('配了一半：configured 为 false 且点名缺哪几个', () => {
    const s = describeOffsiteBackup({ R2_ENDPOINT: 'https://x', R2_BUCKET: 'b' });
    expect(s.configured).toBe(false);
    expect(s.missing).toEqual(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
  });
});

/** 起一个真 express + 真 HTTP，跑完整的 PUT 流程。 */
async function withServer(
  opts: { verifyOk: boolean; verifyError?: string },
  run: (base: string, ctx: { envFile: string; env: NodeJS.ProcessEnv }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-offsite-'));
  const envFile = path.join(dir, '.cds.env');
  fs.writeFileSync(envFile, 'export CDS_EXISTING="keep-me"\n');
  const env: NodeJS.ProcessEnv = {};
  const app = express();
  app.use(express.json());
  app.use('/api', createCdsSystemOffsiteBackupRouter({
    envFilePath: () => envFile,
    env,
    verify: (async () => {
      if (!opts.verifyOk) throw new Error(opts.verifyError || '离机备份上传失败（HTTP 401，Unauthorized）');
      return { objectKey: 'cds-infra-backups/_preflight-check.bin', sha256: 'x', bytes: 1 };
    }) as never,
  }));
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { envFile, env });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const GOOD = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'am-west',
  accessKeyId: 'AKIDEXAMPLE1234',
  secretAccessKey: 'shhhh-this-is-the-secret',
};

describe('保存离机备份配置', () => {
  it('实测不通过：400、不落盘、process.env 不动', async () => {
    // 这是整组用例的核心。上一次「录入过但其实不通」能一直没人发现，
    // 就是因为写入这一步从不校验。
    await withServer({ verifyOk: false }, async (base, ctx) => {
      const resp = await fetch(`${base}/api/cds-system/offsite-backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(GOOD),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: string; message: string };
      expect(body.error).toBe('verification-failed');
      expect(body.message).toContain('401');

      const written = fs.readFileSync(ctx.envFile, 'utf8');
      expect(written, '没通过实测的凭据绝不许落进 .cds.env').not.toContain('R2_ACCESS_KEY_ID');
      expect(written).not.toContain(GOOD.secretAccessKey);
      expect(ctx.env.R2_BUCKET).toBeUndefined();
    });
  });

  it('实测通过：落盘 + 热生效，且不动文件里原有的行', async () => {
    await withServer({ verifyOk: true }, async (base, ctx) => {
      const resp = await fetch(`${base}/api/cds-system/offsite-backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(GOOD),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { saved: boolean; verified: boolean; appliedWithoutRestart: boolean };
      expect(body.saved).toBe(true);
      expect(body.verified).toBe(true);
      expect(body.appliedWithoutRestart).toBe(true);

      const written = fs.readFileSync(ctx.envFile, 'utf8');
      expect(written).toContain('R2_BUCKET');
      expect(written).toContain(GOOD.secretAccessKey);
      expect(written, '不能把 .cds.env 里别的行冲掉').toContain('CDS_EXISTING');

      // 热生效：不写回 process.env 的话要等重启，中间那段窗口谁都说不清。
      expect(ctx.env.R2_BUCKET).toBe('am-west');
      expect(ctx.env.R2_ENDPOINT).toBe(GOOD.endpoint);
    });
  });

  it('响应里不回显 secret', async () => {
    await withServer({ verifyOk: true }, async (base) => {
      const resp = await fetch(`${base}/api/cds-system/offsite-backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(GOOD),
      });
      expect(await resp.text()).not.toContain(GOOD.secretAccessKey);
    });
  });

  it('配了一半：400 且点名缺哪几项，不落盘', async () => {
    await withServer({ verifyOk: true }, async (base, ctx) => {
      const resp = await fetch(`${base}/api/cds-system/offsite-backup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: GOOD.endpoint, bucket: GOOD.bucket }),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json() as { missing: string[] };
      expect(body.missing).toEqual(['accessKeyId', 'secretAccessKey']);
      expect(fs.readFileSync(ctx.envFile, 'utf8')).not.toContain('R2_BUCKET');
    });
  });
});

describe('重测当前配置', () => {
  it('没配过：400 说清没配，而不是假装测过了', async () => {
    await withServer({ verifyOk: true }, async (base) => {
      const resp = await fetch(`${base}/api/cds-system/offsite-backup/test`, { method: 'POST' });
      expect(resp.status).toBe(400);
      expect((await resp.json() as { error: string }).error).toBe('not-configured');
    });
  });

  it('配了但打不通：502 带原因', async () => {
    await withServer({ verifyOk: false, verifyError: '离机备份上传失败（HTTP 403，Forbidden）' },
      async (base, ctx) => {
        Object.assign(ctx.env, {
          R2_ENDPOINT: GOOD.endpoint, R2_BUCKET: GOOD.bucket,
          R2_ACCESS_KEY_ID: GOOD.accessKeyId, R2_SECRET_ACCESS_KEY: GOOD.secretAccessKey,
        });
        const resp = await fetch(`${base}/api/cds-system/offsite-backup/test`, { method: 'POST' });
        expect(resp.status).toBe(502);
        expect((await resp.json() as { message: string }).message).toContain('403');
      });
  });
});

/** 接线守卫：路由写好没挂上，表现和「一切正常」一模一样。 */
describe('路由真的挂在 server 上', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/server.ts'), 'utf8');

  it('createCdsSystemOffsiteBackupRouter 被 app.use 了', () => {
    expect(SRC).toContain("app.use('/api', createCdsSystemOffsiteBackupRouter());");
  });

  it('三条路由都有中文 label（CDS 规则 0.1，缺了面板上只显示裸 URL）', () => {
    for (const label of [
      "'GET /cds-system/offsite-backup'",
      "'PUT /cds-system/offsite-backup'",
      "'POST /cds-system/offsite-backup/test'",
    ]) {
      expect(SRC).toContain(label);
    }
  });
});
