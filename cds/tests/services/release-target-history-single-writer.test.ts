/**
 * 「防再修一边」守卫：发布目标的落库只能有一个收敛点。
 *
 * 事故值：留痕写在 PATCH 路由里。当前有四个入口会落一次发布目标 ——
 * 创建 / 本机生产创建 / 更新 / 归档 —— 只在其中一个记录，另外三个的改动
 * 在历史里彻底消失；更糟的是第五个入口迟早会加，加的人根本不知道要补留痕。
 *
 * 行为用例测不到这一层：漏一个入口不会红，只会让那条路径静默不记。
 * 所以用源码扫描把「不许绕过 recordReleaseTargetUpsert」钉死。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relativePath), 'utf8');
}

/** 递归收集 src 下的 .ts，用于全量扫描（新增文件也逃不掉）。 */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, acc);
    else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('发布目标落库只有一个收敛点', () => {
  it('发布路由不许直接调 stateService.upsertReleaseTarget', () => {
    const source = read('src/routes/releases.ts');
    expect(source).not.toContain('stateService.upsertReleaseTarget(');
    // 反向断言：四个入口确实都走了收敛点（创建 / 本机生产 / 更新 / 归档）。
    const recorded = source.split('recordReleaseTargetUpsert(').length - 1;
    // 四个调用点：创建 / 本机生产创建 / 更新 / 归档。少于 4 说明某个入口又绕过去了。
    expect(recorded).toBeGreaterThanOrEqual(4);
  });

  it('全仓只有 state 定义处与收敛点会调用 upsertReleaseTarget', () => {
    const allowed = new Set([
      // 方法定义本身
      path.join(CDS_ROOT, 'src/services/state.ts'),
      // 唯一收敛点
      path.join(CDS_ROOT, 'src/services/release-target-history.ts'),
    ]);
    const offenders = collectSourceFiles(path.join(CDS_ROOT, 'src'))
      .filter((file) => !allowed.has(file))
      .filter((file) => /\.upsertReleaseTarget\(/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.relative(CDS_ROOT, f))).toEqual([]);
  });
});
