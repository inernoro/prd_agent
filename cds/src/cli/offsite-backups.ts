import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  r2BackupConfigFromEnv,
  listR2Backups,
  downloadAndVerifyR2Backup,
  type RemoteBackupEntry,
} from '../services/infra-backup-r2.js';

/**
 * 离机备份的「看得见 / 取得回」两条命令。
 *
 *   pnpm offsite:list                       列出桶里所有备份对象
 *   pnpm offsite:list --grep prd-agent      只看某个项目
 *   pnpm offsite:list --before 2026-08-15   标出这个时间点之前的（删库前的候选）
 *   pnpm offsite:fetch <objectKey> <本地路径>  取回一份（下载后校验 size + sha256）
 *
 * 存在的理由：同机保留策略每产一份新备份就删一份旧的，而离机侧一份都不删——
 * 被吃掉的历史档案很可能还在桶里，但此前没有任何入口能看见。取回来之后接
 * `pnpm inspect:archive <文件>` 判断里面到底有没有业务数据。
 *
 * 凭据从 `.cds.env` / 环境变量读，命令行不接收也不打印任何密钥。
 */

function flag(name: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? String(process.argv[at + 1] || '').trim() : '';
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * 排序与「删库前/后」的划线都在这里做，好让它能被测试直接驱动——
 * 判断哪一份是删库前的档案是这个工具唯一真正重要的输出。
 */
export function partitionByCutoff(
  entries: readonly RemoteBackupEntry[],
  cutoffIso: string,
): { before: RemoteBackupEntry[]; after: RemoteBackupEntry[] } {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) throw new Error(`--before 不是合法时间：${cutoffIso}`);
  const before: RemoteBackupEntry[] = [];
  const after: RemoteBackupEntry[] = [];
  for (const e of entries) {
    const at = Date.parse(e.lastModified);
    // 时间戳解析不出来时归到 after：宁可让它落在「不是候选」那一侧，
    // 也不要把一份来历不明的档案标成「删库前的救命备份」。
    if (Number.isFinite(at) && at < cutoff) before.push(e);
    else after.push(e);
  }
  return { before, after };
}

export function sortByTime(entries: readonly RemoteBackupEntry[]): RemoteBackupEntry[] {
  return [...entries].sort((a, b) => Date.parse(a.lastModified) - Date.parse(b.lastModified));
}

async function runList(): Promise<void> {
  const config = r2BackupConfigFromEnv();
  if (!config) throw new Error('缺少完整 R2 环境配置（R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）');
  const prefixOverride = flag('--prefix');
  const grep = flag('--grep');
  const before = flag('--before');

  const all = await listR2Backups({
    config,
    ...(prefixOverride ? { prefix: prefixOverride } : {}),
  });
  const matched = sortByTime(grep ? all.filter((e) => e.key.includes(grep)) : all);

  process.stdout.write(`桶 ${config.bucket} / prefix ${prefixOverride || config.prefix || '(整桶)'}：共 ${all.length} 个对象`);
  process.stdout.write(grep ? `，匹配 "${grep}" 的 ${matched.length} 个\n\n` : '\n\n');

  const mark = before ? partitionByCutoff(matched, before) : null;
  const beforeKeys = new Set((mark?.before ?? []).map((e) => e.key));
  for (const e of matched) {
    const tag = mark ? (beforeKeys.has(e.key) ? ' <= 早于分界点' : '') : '';
    process.stdout.write(`${e.lastModified}  ${fmtBytes(e.bytes).padStart(10)}  ${e.key}${tag}\n`);
  }

  if (mark) {
    process.stdout.write(`\n早于 ${before} 的: ${mark.before.length} 份；之后的: ${mark.after.length} 份\n`);
    if (mark.before.length === 0) {
      process.stdout.write('桶里没有早于该时间点的备份。这个方向到此为止，另找恢复源。\n');
      process.exitCode = 1;
    } else {
      const newest = mark.before[mark.before.length - 1];
      process.stdout.write(`最接近分界点的一份: ${newest.key}\n`);
      process.stdout.write(`取回并体检: pnpm offsite:fetch ${newest.key} ./restore-candidate.archive.gz && pnpm inspect:archive ./restore-candidate.archive.gz\n`);
    }
  }
}

async function runFetch(): Promise<void> {
  const config = r2BackupConfigFromEnv();
  if (!config) throw new Error('缺少完整 R2 环境配置');
  const objectKey = process.argv[3];
  const dest = process.argv[4];
  if (!objectKey || !dest) throw new Error('用法: offsite-backups fetch <objectKey> <本地路径>');

  const r = await downloadAndVerifyR2Backup({ config, objectKey, filePath: path.resolve(dest) });
  // 下载函数内部已经比对过远端元数据的 size + sha256，对不上会抛，不会留下半截文件。
  process.stdout.write(`已取回 ${r.objectKey}\n  ${path.resolve(dest)}\n  ${fmtBytes(r.bytes)}  sha256 ${r.sha256}\n`);
  process.stdout.write(`下一步体检: pnpm inspect:archive ${path.resolve(dest)}\n`);
}

export async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === 'list') return runList();
  if (mode === 'fetch') return runFetch();
  process.stderr.write('用法: offsite-backups list [--prefix p] [--grep s] [--before ISO时间]\n');
  process.stderr.write('      offsite-backups fetch <objectKey> <本地路径>\n');
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
