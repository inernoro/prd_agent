/**
 * Codex review（PR #1532）第二十四轮的 P1：报告正文的对象存储在进程启动时就把凭据
 * 冻住了。
 *
 * 离机备份设置面板（`POST /cds-system/offsite-backup`）写完 .cds.env 之后会把新值灌回
 * `process.env` 并回 `appliedWithoutRestart: true`，可 `StateService.reportObjects` 是字段
 * 初始化时建的。于是：
 *   - 原本没配对象存储的实例，热配完仍然 isConfigured()=false，新报告继续只写本地盘，
 *     容器一重建又变回那本点开全是 404 的幽灵台账——正是本 PR 要消灭的那件事；
 *   - 轮换凭据之后，读写继续拿已经作废的那把打，直到有人重启。
 *
 * 判据：不传 config 建的 store 必须跟着当前环境变量走。传了 config（含 null）的仍然钉死，
 * 测试与调用方靠那条注入。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createReportObjectStore, reportObjectStoreFromEnv,
  type ReportObjectStoreConfig,
} from '../../src/services/report-object-store.js';

const KEYS = [
  'R2_ENDPOINT', 'R2_BUCKET', 'CDS_REPORTS_R2_BUCKET',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CDS_REPORTS_R2_PREFIX',
] as const;

const saved = new Map<string, string | undefined>();
function setEnv(patch: Record<string, string | undefined>): void {
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function clearAll(): void {
  setEnv(Object.fromEntries(KEYS.map((k) => [k, undefined])));
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

function configure(suffix: string): void {
  setEnv({
    R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
    R2_BUCKET: `bucket-${suffix}`,
    CDS_REPORTS_R2_BUCKET: undefined,
    R2_ACCESS_KEY_ID: `ak-${suffix}`,
    R2_SECRET_ACCESS_KEY: `sk-${suffix}`,
    CDS_REPORTS_R2_PREFIX: undefined,
  });
}

describe('报告对象存储必须跟着热改后的凭据走', () => {
  it('启动时没配、之后热配上——store 立刻认，不必重启', async () => {
    clearAll();
    const seen: ReportObjectStoreConfig[] = [];
    const store = createReportObjectStore(undefined, {
      upload: async ({ config }) => { seen.push(config as ReportObjectStoreConfig); },
    });

    // 前置断言：这一刻确实是「没配」，否则下面那句翻转测不到东西。
    expect(store.isConfigured()).toBe(false);
    expect(await store.put({ id: 'r1', format: 'md' }, '正文')).toBeNull();

    configure('new');

    expect(store.isConfigured()).toBe(true);
    const key = await store.put({ id: 'r1', format: 'md' }, '正文');
    expect(key).toBe('cds-acceptance-reports/reports/_unassigned/r1.md');
    expect(seen).toHaveLength(1);
    expect(seen[0].bucket).toBe('bucket-new');
  });

  it('轮换凭据后，下一次读写用的是新的那把', async () => {
    configure('old');
    const seen: ReportObjectStoreConfig[] = [];
    const store = createReportObjectStore(undefined, {
      upload: async ({ config }) => { seen.push(config as ReportObjectStoreConfig); },
    });

    await store.put({ id: 'r1', format: 'md' }, '正文');
    expect(seen[0].accessKeyId).toBe('ak-old');

    configure('rotated');
    await store.put({ id: 'r2', format: 'md' }, '正文');
    expect(seen[1].accessKeyId).toBe('ak-rotated');
    expect(seen[1].secretAccessKey).toBe('sk-rotated');
  });

  it('取回与删除也走当前凭据，不只是写入那一条路', async () => {
    clearAll();
    const reads: ReportObjectStoreConfig[] = [];
    const removes: ReportObjectStoreConfig[] = [];
    const store = createReportObjectStore(undefined, {
      fetchObject: async ({ config }) => {
        reads.push(config as ReportObjectStoreConfig);
        return Buffer.from('正文', 'utf-8');
      },
      remove: async ({ config }) => { removes.push(config as ReportObjectStoreConfig); },
    });

    expect(await store.get('k')).toBeNull();
    await store.remove('k');
    expect(reads).toHaveLength(0);
    expect(removes).toHaveLength(0);

    configure('hot');
    expect(await store.get('k')).toBe('正文');
    await store.remove('k');
    expect(reads[0].bucket).toBe('bucket-hot');
    expect(removes[0].bucket).toBe('bucket-hot');
  });

  it('显式传了 config 的仍然钉死：注入不受环境变量影响', async () => {
    const pinned: ReportObjectStoreConfig = {
      endpoint: 'https://acc.r2.cloudflarestorage.com',
      bucket: 'pinned',
      accessKeyId: 'ak-pinned',
      secretAccessKey: 'sk-pinned',
      prefix: 'p',
    };
    const seen: ReportObjectStoreConfig[] = [];
    const store = createReportObjectStore(pinned, {
      upload: async ({ config }) => { seen.push(config as ReportObjectStoreConfig); },
    });

    configure('ignored');
    await store.put({ id: 'r1', format: 'md' }, '正文');
    expect(seen[0].bucket).toBe('pinned');

    // 显式 null 同样钉死，不会因为环境里有凭据就自己活过来。
    const off = createReportObjectStore(null);
    expect(off.isConfigured()).toBe(false);
  });

  it('凭据配一半照旧抛：开机时炸的那条 fail-fast 没有因为改成重解析而丢掉', () => {
    clearAll();
    setEnv({ R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', R2_BUCKET: 'b' });
    expect(() => createReportObjectStore()).toThrow(/只配了一半/);

    // 已经建好的 store 在运行时被改成「四缺二」也必须炸，不许静默退回本地盘。
    clearAll();
    const store = createReportObjectStore();
    expect(store.isConfigured()).toBe(false);
    setEnv({ R2_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', R2_BUCKET: 'b' });
    expect(() => store.isConfigured()).toThrow(/只配了一半/);
  });

  it('reportObjectStoreFromEnv 默认就读 process.env（重解析依赖这一点）', () => {
    configure('sanity');
    const config = reportObjectStoreFromEnv();
    expect(config?.bucket).toBe('bucket-sanity');
  });
});
