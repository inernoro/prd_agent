import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { inspectMongoArchive, summarizeArchive } from '../services/infra-archive-inspect.js';

/**
 * 备份归档体检 CLI —— 在宿主机上一条命令跑完，不需要 docker，不需要 mongo，只读。
 *
 *   pnpm inspect:archive /root/inernoro/cds-backups/prd-agent
 *   pnpm inspect:archive /path/to/one.archive.gz
 *
 * 给目录就扫目录下所有 *.archive.gz，按文件名排序逐个体检并给出汇总建议。
 * 全程只读：不连数据库、不启容器、不改任何文件。
 */

const DEFAULT_EXPECT = new URL('../../config/prdagent-expected-collections.json', import.meta.url);

function arg(name: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? String(process.argv[at + 1] || '').trim() : '';
}

async function loadExpected(): Promise<string[]> {
  const override = arg('--expect-file');
  const src = override ? new URL(`file://${path.resolve(override)}`) : DEFAULT_EXPECT;
  const cfg = JSON.parse(await fs.promises.readFile(src, 'utf8')) as { collections?: unknown };
  const names = Array.isArray(cfg.collections) ? cfg.collections.filter((x): x is string => typeof x === 'string') : [];
  if (names.length === 0) throw new Error('候选集合清单为空，无法判断归档里有没有业务数据');
  return names;
}

async function resolveTargets(input: string): Promise<string[]> {
  const stat = await fs.promises.stat(input);
  if (!stat.isDirectory()) return [input];
  const entries = await fs.promises.readdir(input);
  return entries
    .filter((f) => f.endsWith('.archive.gz'))
    .sort()
    .map((f) => path.join(input, f));
}

export async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target.startsWith('--')) {
    process.stderr.write('用法: inspect-backup-archive <备份目录或单个 .archive.gz> [--expect-file <清单.json>]\n');
    process.exitCode = 2;
    return;
  }

  const expectCollections = await loadExpected();
  const files = await resolveTargets(target);
  if (files.length === 0) {
    process.stdout.write(`${target} 下没有 *.archive.gz\n`);
    return;
  }

  process.stdout.write(`候选集合 ${expectCollections.length} 个；待检归档 ${files.length} 份\n\n`);

  let newestUsable = '';
  for (const file of files) {
    const r = await inspectMongoArchive({ filePath: file, expectCollections });
    const s = summarizeArchive(r);
    // 文件名按 UTC 时间戳排序，所以最后一个 has-data 就是最新可用点。
    if (s.verdict === 'has-data') newestUsable = file;

    const top = Object.entries(r.hits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([n, c]) => `${n}(${c})`)
      .join(' ');
    process.stdout.write(`${path.basename(file)}\n`);
    process.stdout.write(`  判定 ${s.verdict} — ${s.text}\n`);
    process.stdout.write(`  压缩 ${(r.compressedBytes / 1048576).toFixed(2)} MB  sha256 ${r.sha256.slice(0, 16)}…\n`);
    if (top) process.stdout.write(`  命中最多的集合: ${top}\n`);
    process.stdout.write('\n');
  }

  if (newestUsable) {
    process.stdout.write(`最新一份含业务数据的归档: ${path.basename(newestUsable)}\n`);
    // 说清这条结论的边界。把「有数据」讲成「能恢复」正是这套备份此前的老毛病。
    process.stdout.write('注意: 这只证明文件完整且含业务集合，**不证明它能被 mongorestore 成功恢复**。\n');
    process.stdout.write('恢复前还需要: 恢复演练（起一次性容器实际 restore 一遍）+ 只恢复目标库（--nsInclude），\n');
    process.stdout.write('不要整实例 --drop，那会把同一个 mongo 上其它项目的库一起回退。\n');
  } else {
    process.stdout.write('没有任何一份归档含业务数据。不要用它们恢复，另找恢复源。\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
