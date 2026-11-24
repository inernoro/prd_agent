/**
 * 离机备份（R2）配置入口 —— 系统级。
 *
 * ## 为什么要有这个路由
 *
 * 离机备份的四个变量此前**只能在宿主上手改 `.cds.env` 再重启**。没有任何入口意味着：
 * 谁改的、改成了什么、到底通不通，全都不可见。2026-08-18 的实际后果是每一轮备份都
 * 「导出成功 → 校验通过 → 上传 401 → 连本地那份一起删」，本地周期备份整整停了半天，
 * 而唯一的线索是事件流里一行 401。用户那边的记忆是「上次录入过一次，后来失效了」——
 * 没有录入界面、没有当场校验，这种事必然会重演。
 *
 * ## 这个路由的三条设计约束
 *
 * 1. **先验证，再落盘**。PUT 进来的凭据要先对 R2 真跑一次「上传 + HEAD 校验」，
 *    走的就是周期备份用的同一个函数（`uploadAndVerifyR2Backup`）。跑不通就 400 退回，
 *    绝不写进 `.cds.env`——半通不通的配置比没有配置更糟，它会让你以为已经有离机副本了。
 * 2. **热生效，不必重启**。落盘之后同步写回 `process.env`，下一轮备份立刻用新值。
 *    只落盘不热更的话，「我明明存了」和「它还在用旧值」之间会有一段谁都说不清的窗口。
 * 3. **密钥只进不出**。GET 永远不返回 secret，access key 只回尾四位。
 *
 * 对齐 `.claude/rules/minimal-user-input.md`：填完密钥必须能当场测一次、看得到系统
 * 配成了什么、失败要给得出下一步。
 */
import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateEnvFile, defaultEnvFilePath } from '../services/env-file.js';
import { r2BackupConfigFromEnv, uploadAndVerifyR2Backup } from '../services/infra-backup-r2.js';

/** `.cds.env` 里这四个键构成一份完整的离机配置，缺一不可。 */
export const R2_ENV_KEYS = [
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
] as const;

export interface OffsiteBackupInput {
  endpoint?: unknown;
  bucket?: unknown;
  accessKeyId?: unknown;
  secretAccessKey?: unknown;
  prefix?: unknown;
}

export interface NormalizedOffsiteInput {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
}

/**
 * 归一化并挑出缺的字段。
 *
 * `bucket` 额外认 `bucketName`：Cloudflare 面板复制出来的那份清单里写的是
 * `R2_BUCKET_NAME`，而代码读的是 `R2_BUCKET`。这一个字母之差足以让人「录入了一次」
 * 却整条不生效，所以在入口就把两种写法都收下，而不是让下一个人再踩一遍。
 */
export function normalizeOffsiteInput(
  body: OffsiteBackupInput & { bucketName?: unknown },
): { ok: true; value: NormalizedOffsiteInput } | { ok: false; missing: string[] } {
  const str = (v: unknown): string => String(v ?? '').trim();
  const value: NormalizedOffsiteInput = {
    endpoint: str(body.endpoint).replace(/\/+$/, ''),
    bucket: str(body.bucket) || str(body.bucketName),
    accessKeyId: str(body.accessKeyId),
    secretAccessKey: str(body.secretAccessKey),
  };
  const prefix = str(body.prefix).replace(/^\/+|\/+$/g, '');
  if (prefix) value.prefix = prefix;

  const missing: string[] = [];
  if (!value.endpoint) missing.push('endpoint');
  if (!value.bucket) missing.push('bucket');
  if (!value.accessKeyId) missing.push('accessKeyId');
  if (!value.secretAccessKey) missing.push('secretAccessKey');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value };
}

/** access key 只回尾四位；secret 一个字符都不回。 */
export function maskAccessKeyId(value: string): string {
  const v = String(value || '');
  if (!v) return '';
  return v.length <= 4 ? '****' : `****${v.slice(-4)}`;
}

export interface OffsiteBackupStatus {
  configured: boolean;
  endpoint: string | null;
  bucket: string | null;
  prefix: string | null;
  accessKeyIdMasked: string | null;
  /** 缺哪几个键——「没配」和「配了一半」要分得开。 */
  missing: string[];
}

export function describeOffsiteBackup(
  env: Record<string, string | undefined> = process.env,
): OffsiteBackupStatus {
  const config = r2BackupConfigFromEnv(env);
  const missing = R2_ENV_KEYS.filter((k) => !String(env[k] || '').trim());
  return {
    configured: config !== null,
    endpoint: config?.endpoint ?? (String(env.R2_ENDPOINT || '').trim() || null),
    bucket: config?.bucket ?? (String(env.R2_BUCKET || '').trim() || null),
    prefix: config?.prefix ?? null,
    accessKeyIdMasked: maskAccessKeyId(String(env.R2_ACCESS_KEY_ID || '').trim()) || null,
    missing,
  };
}

export interface CdsSystemOffsiteBackupDeps {
  /** 覆盖 `.cds.env` 路径，测试用。 */
  envFilePath?: () => string;
  /** 注入 process.env 的替身，测试用。 */
  env?: NodeJS.ProcessEnv;
  /** 探针实现，测试用。 */
  verify?: typeof uploadAndVerifyR2Backup;
}

/**
 * 用一个几十字节的探针对象跑一次真实的「上传 + HEAD 校验」。
 *
 * 刻意复用周期备份那条函数而不是另写一版握手：**验证走的路径必须和真正备份走的
 * 是同一条**，否则「测试通过、备份仍失败」照样会发生（判据与被判对象不是一回事，
 * 见 predicate-and-wiring-discipline 形状 8）。
 */
async function probeOffsite(
  value: NormalizedOffsiteInput,
  verify: typeof uploadAndVerifyR2Backup,
): Promise<{ ok: true; objectKey: string } | { ok: false; message: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-r2-probe-'));
  const filePath = path.join(dir, 'preflight.bin');
  try {
    fs.writeFileSync(filePath, `cds-offsite-preflight\n`);
    const config = {
      endpoint: value.endpoint,
      bucket: value.bucket,
      accessKeyId: value.accessKeyId,
      secretAccessKey: value.secretAccessKey,
      prefix: value.prefix || 'cds-infra-backups',
    };
    const result = await verify({ config, filePath, fileName: '_preflight-check.bin' });
    return { ok: true, objectKey: result.objectKey };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function createCdsSystemOffsiteBackupRouter(
  deps: CdsSystemOffsiteBackupDeps = {},
): Router {
  const router = Router();
  const envOf = (): NodeJS.ProcessEnv => deps.env ?? process.env;
  const envFile = deps.envFilePath ?? defaultEnvFilePath;
  const verify = deps.verify ?? uploadAndVerifyR2Backup;

  router.get('/cds-system/offsite-backup', (_req, res) => {
    res.json(describeOffsiteBackup(envOf() as Record<string, string | undefined>));
  });

  router.put('/cds-system/offsite-backup', async (req, res) => {
    const parsed = normalizeOffsiteInput((req.body || {}) as OffsiteBackupInput);
    if (!parsed.ok) {
      res.status(400).json({
        error: 'incomplete',
        message: `离机备份配置缺少：${parsed.missing.join('、')}。`
          + '四项齐全才会生效，不接受只配一半——半通不通的配置会让人以为已经有离机副本。',
        missing: parsed.missing,
      });
      return;
    }

    const probe = await probeOffsite(parsed.value, verify);
    if (!probe.ok) {
      // 通不过就原样退回失败原因，并且**不落盘**。上一次「录入过但其实不通」
      // 之所以能一直没人发现，就是因为写入这一步从不校验。
      res.status(400).json({
        error: 'verification-failed',
        message: `凭据没通过实测，未保存：${probe.message}`,
        hint: '常见原因：access key 已轮换或被删、bucket 名写错、endpoint 少了账号 ID 那一段。',
      });
      return;
    }

    const updates: Record<string, string | null> = {
      R2_ENDPOINT: parsed.value.endpoint,
      R2_BUCKET: parsed.value.bucket,
      R2_ACCESS_KEY_ID: parsed.value.accessKeyId,
      R2_SECRET_ACCESS_KEY: parsed.value.secretAccessKey,
    };
    if (parsed.value.prefix) updates.R2_PREFIX = parsed.value.prefix;

    try {
      updateEnvFile(envFile(), updates);
    } catch (err) {
      res.status(500).json({
        error: 'persist-failed',
        message: `凭据实测通过，但写入 .cds.env 失败：${(err as Error).message}`,
      });
      return;
    }

    // 热生效：不写回 process.env 的话，要等下一次重启才用上新值，
    // 而这中间「我明明存了」和「它还在用旧值」谁都说不清。
    const target = envOf();
    for (const [k, v] of Object.entries(updates)) {
      if (v !== null) target[k] = v;
    }

    res.json({
      saved: true,
      verified: true,
      probeObjectKey: probe.objectKey,
      appliedWithoutRestart: true,
      status: describeOffsiteBackup(target as Record<string, string | undefined>),
      message: '离机备份配置已实测通过并保存，下一轮备份立即生效（无需重启）',
    });
  });

  /** 重测当前生效的配置——排障时先问一句「现在这套还通不通」。 */
  router.post('/cds-system/offsite-backup/test', async (_req, res) => {
    const config = r2BackupConfigFromEnv(envOf() as Record<string, string | undefined>);
    if (!config) {
      res.status(400).json({
        error: 'not-configured',
        message: '当前没有完整的离机备份配置',
        status: describeOffsiteBackup(envOf() as Record<string, string | undefined>),
      });
      return;
    }
    const probe = await probeOffsite({ ...config }, verify);
    if (!probe.ok) {
      res.status(502).json({ ok: false, message: probe.message });
      return;
    }
    res.json({ ok: true, probeObjectKey: probe.objectKey, message: '当前离机备份配置实测可用' });
  });

  return router;
}
