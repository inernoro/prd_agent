/**
 * Codex review（PR #1532）第九轮的服务端两条。第一条是**开不了机**级别的：
 *
 * 预览实例启动会清洗父实例密钥。R2 四件套里只有两把命中「看着像密钥」的模式，
 * 另外两个（ENDPOINT / BUCKET）留了下来，于是子实例被清洗成「四缺二」——
 * 那正是本 PR 第一轮加的那个「配一半就抛」判据要拦的形态，结果 StateService
 * 一构造就炸，子实例根本起不来（实测预览 /healthz 503）。
 *
 * 根因不在那个抛错（凭据不全必须拒绝，这条是对的），在于**清洗把一组凭据拆散了**。
 *
 * 第二条是删除路径的持久顺序：先删对象再 save()，而 save() 是写后即返回的。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubParentSecretsFromEnv } from '../../src/services/preview-instance.js';
import { reportObjectStoreFromEnv } from '../../src/services/report-object-store.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

/** 父实例配全了 R2 的那种 env，外加预览实例标记。 */
function parentEnvInPreview(): NodeJS.ProcessEnv {
  return {
    CDS_PREVIEW_INSTANCE: '1',
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_BUCKET: 'cds-backups',
    R2_ACCESS_KEY_ID: 'parent-ak',
    R2_SECRET_ACCESS_KEY: 'parent-sk',
    CDS_REPORTS_R2_BUCKET: 'cds-reports',
    CDS_REPORTS_R2_PREFIX: 'cds-acceptance-reports',
  } as NodeJS.ProcessEnv;
}

describe('预览实例清洗：成组的凭据要么整组留、要么整组删', () => {
  it('清洗之后 R2 四件套一个不剩，不会留下「四缺二」', () => {
    const env = parentEnvInPreview();
    scrubParentSecretsFromEnv(env);
    for (const k of [
      'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
      'CDS_REPORTS_R2_BUCKET', 'CDS_REPORTS_R2_PREFIX',
    ]) {
      expect(env[k], `${k} 被留了下来，子实例会被清洗成半套凭据`).toBeUndefined();
    }
  });

  it('清洗后的 env 解析为「有意只用本地」，而不是抛错', () => {
    // 这一条就是子实例开不了机的那个判据本身：present === 0 → null，不抛。
    const env = parentEnvInPreview();
    scrubParentSecretsFromEnv(env);
    expect(() => reportObjectStoreFromEnv(env as Record<string, string | undefined>)).not.toThrow();
    expect(reportObjectStoreFromEnv(env as Record<string, string | undefined>)).toBeNull();
  });

  it('端到端：清洗后的 env 下 StateService 构造得出来（这就是「能不能开机」）', () => {
    const env = parentEnvInPreview();
    scrubParentSecretsFromEnv(env);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-boot-'));
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith('R2_') || k.startsWith('CDS_REPORTS_R2_')) delete process.env[k];
      Object.assign(process.env, env);
      expect(() => new StateService(path.join(dir, 'state.json'))).not.toThrow();
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('真正配了一半的部署仍然照抛（别为了开机把判据放松掉）', () => {
    // 修法是补全清洗，不是放松判据——这条反向断言钉住这一点。
    expect(() => reportObjectStoreFromEnv({
      R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com', R2_BUCKET: 'b',
    })).toThrow(/只配了一半/);
  });

  it('非预览实例一个都不清洗（父实例自己要用这些值）', () => {
    const env = { ...parentEnvInPreview(), CDS_PREVIEW_INSTANCE: '0' } as NodeJS.ProcessEnv;
    expect(scrubParentSecretsFromEnv(env)).toEqual([]);
    expect(env.R2_ENDPOINT).toBeTruthy();
    expect(env.R2_ACCESS_KEY_ID).toBeTruthy();
  });
});

describe('删报告：先落元数据，再删远端对象', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('remove 在 save 之后才被调用', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-del-order-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    const order: string[] = [];
    const store = new Map<string, string>();
    (svc as unknown as { reportObjects: unknown }).reportObjects = {
      isConfigured: () => true,
      put: async (m: { id: string; format: string }, c: string) => {
        const key = `k/${m.id}.${m.format}`;
        store.set(key, c);
        return key;
      },
      get: async (key: string) => store.get(key) ?? null,
      remove: async (key: string) => { order.push(`remove:${key}`); store.delete(key); },
    };
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 待删', kind: '验收', format: 'md', content: '正文',
    } as never);
    const origSave = (svc as unknown as { save: () => void }).save.bind(svc);
    (svc as unknown as { save: () => void }).save = () => { order.push('save'); origSave(); };

    expect(svc.deleteAcceptanceReport(meta.id)).toBe(true);
    // 允许 remove 还没跑完（它是 fire-and-forget），但一旦跑了，必须排在 save 之后。
    await new Promise((r) => setTimeout(r, 0));
    expect(order[0], `实际顺序：${order.join(' -> ')}`).toBe('save');
    expect(order).toContain(`remove:${meta.objectKey}`);
    expect(svc.getAcceptanceReport(meta.id)).toBeUndefined();
  });
});
