import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「防再修一边」守卫：发布日志的**有界追加**与**截断标记推导**各只许有一份。
 *
 * 事故值：本仓库已经为「判定散成两份」付过四次学费 —— 发布步骤判定曾有三份拷贝、
 * 终态判定在 release-service 与 deploy-drain 各写一份、模型解析在 gateway 里跑了两遍
 * 把用户选的模型覆盖掉、发布事件类型差点长出第二张告警表。
 *
 * 发布日志天生有第二个消费方：`src/infra/state-store/mongo-split-store.ts` 的
 * `compactReleaseRuns` 会在 global 文档超字节上限时再 slice 一次日志。它是应急压缩，
 * 不是常规上限，可以保留；但它**绝不许自己写 firstEventSeq** —— 那会写回一份
 * 「声称有、其实已丢」的截断标记，续传客户端据此以为收全了。
 * 保证它安全的机制是：读侧一律走 resolveReleaseFirstEventSeq 从 logs[0].seq 推导，
 * 落库字段只做空日志兜底。本套件把这两条同时焊死。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const LOG_BUFFER_SSOT = 'src/services/release-log-buffer.ts';

/**
 * 允许再 slice 一次发布日志的例外，且必须写明理由。
 * 名单只能缩短不能加长：新增一处就是又长出一个各自漂移的上限。
 */
const KNOWN_RELEASE_LOG_COMPACTORS = new Map<string, string>([
  [
    'src/infra/state-store/mongo-split-store.ts',
    'compactGlobalRestToFit 的应急字节压缩：global 文档写不进去时逐档降级，不是常规上限',
  ],
]);

/**
 * 扫描前先剥注释：本文件与 types.ts 的注释里就写着「从 logs[0].seq 推导」这类字样，
 * 不剥的话守卫会被自己的说明文字绊倒，而真正的第二份实现反而淹没在噪音里。
 */
function readCode(file: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const root = path.join(CDS_ROOT, relativeDir);
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(path.relative(CDS_ROOT, full).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

describe('发布日志判定源守卫', () => {
  const sourceFiles = [
    ...walk('src', ['.ts']),
    ...walk('web/src', ['.ts', '.tsx']),
  ];

  it('SSOT 文件存在且导出三件套', () => {
    const text = fs.readFileSync(path.join(CDS_ROOT, LOG_BUFFER_SSOT), 'utf8');
    for (const symbol of [
      'export function appendBoundedReleaseLog',
      'export function resolveReleaseFirstEventSeq',
      'export function buildReleaseLogSnapshot',
      'export const RELEASE_MAX_LOGS',
    ]) {
      expect(text, `${LOG_BUFFER_SSOT} 缺少 ${symbol}`).toContain(symbol);
    }
  });

  it('往发布 run 的 logs 里 push 只许发生在 SSOT 里', () => {
    const offenders = sourceFiles.filter((file) => {
      if (file === LOG_BUFFER_SSOT) return false;
      return readCode(file).includes('run.logs.push(');
    });
    expect(
      offenders,
      '发布日志的追加必须走 appendBoundedReleaseLog（它同时维持上限与截断标记），'
        + '别处直接 push 等于把上限绕过去：\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('从 logs[0].seq 推导截断标记只许发生在 SSOT 里', () => {
    const offenders = sourceFiles.filter((file) => {
      if (file === LOG_BUFFER_SSOT) return false;
      const text = readCode(file);
      return text.includes('logs[0]?.seq') || text.includes('logs[0].seq');
    });
    expect(
      offenders,
      '截断标记只有 resolveReleaseFirstEventSeq 一处推导，别处再算一遍必然漂移：\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('再 slice 一次发布日志的地方只有登记在册的应急压缩', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (file === LOG_BUFFER_SSOT || KNOWN_RELEASE_LOG_COMPACTORS.has(file)) continue;
      const text = readCode(file);
      // 只盯发布域：同一文件里既出现 ReleaseRun 又对 logs 做尾部截断。
      if (!text.includes('ReleaseRun')) continue;
      if (/logs\s*(\|\|\s*\[\])?\s*\)?\.slice\(-/.test(text)) offenders.push(file);
    }
    expect(
      offenders,
      '发布日志的条数上限只在 release-log-buffer.ts；确需再截一次的必须登记进 '
        + 'KNOWN_RELEASE_LOG_COMPACTORS 并写清理由：\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('应急压缩不许自己写 firstEventSeq，否则会写回一个撒谎的截断标记', () => {
    for (const [file, reason] of KNOWN_RELEASE_LOG_COMPACTORS) {
      const text = readCode(file);
      const compactor = text.split('function compactReleaseRuns')[1]?.split('\nfunction ')[0] ?? '';
      expect(compactor, `${file}（${reason}）里找不到 compactReleaseRuns，守卫已失效`).not.toBe('');
      expect(
        compactor.includes('firstEventSeq'),
        `${file} 的应急压缩截了日志却自己写 firstEventSeq，会造出「声称有、其实已丢」的标记`,
      ).toBe(false);
    }
  });

  it('release-service 不再自带终态表，只从 release-retention 转发', () => {
    const code = readCode('src/services/release-service.ts');
    // 表搬去 release-retention 是因为 state 层做保留策略要判「谁还在途」，
    // 而 state 不能反向依赖 release-service（会成环）。谁把它抄回来就又是两份。
    expect(code).not.toContain('RELEASE_STATUS_TERMINAL');
    expect(code).toContain("} from './release-retention.js';");
    expect(code).toContain('export { isReleaseRunInFlight, isReleaseRunTerminal }');
  });

  it('state 层的保留策略走 release-retention 的纯函数，不自己判终态', () => {
    const code = readCode('src/services/state.ts');
    expect(code).toContain('selectReleaseRunsToPrune');
    expect(code).toContain('selectReleasePreflightsToPrune');
    // 直接在 state 里手写状态字面量 = 又长出一张终态表。
    expect(code).not.toContain("run.status === 'success'");
  });
});
