import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「防再修一边」守卫：回滚可达范围 N 只能有一个判定源。
 *
 * 事故值：这个 20 原本是 routes/releases.ts 里的裸字面量 `successfulRuns.slice(0, 20)`，
 * 只有一个消费方所以没人觉得有问题。阶段三接连长出第二、第三个消费方 ——
 * run 保留策略（KEEP_SUCCESSFUL_RELEASE_RUNS）与远端产物回收（保留最近 N 份）。
 * 三处各写一个 20 的后果是**产物回收会把 UI 上还能选的版本的现场删掉**，而且这种
 * 错位只有用户点了回滚才会暴露。本仓库前几轮 review 反复栽在同一判定分裂成多份上，
 * 故这里用源码扫描把它焊死。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relative), 'utf8');
}

function walk(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const stack = [path.join(CDS_ROOT, relativeDir)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(full);
        continue;
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path.relative(CDS_ROOT, full));
    }
  }
  return out;
}

/**
 * 尚未改读常量的存量文件。
 *
 * 验收轮已把 routes/releases.ts 的版本下拉改成读 KEEP_SUCCESSFUL_RELEASE_RUNS，
 * 这张表因此清空。**保留这张空表是有意的**：谁要新增一处裸截断，得显式往这里加一行
 * 并写明原因，而不是顺手把断言注释掉。
 */
const PENDING_MIGRATION: string[] = [];

describe('回滚可达范围只有一个判定源', () => {
  it('KEEP_SUCCESSFUL_RELEASE_RUNS 只在 release-retention.ts 定义一次', () => {
    const definitions = walk('src', ['.ts'])
      .filter((file) => /export const KEEP_SUCCESSFUL_RELEASE_RUNS\b/.test(read(file)));

    expect(definitions).toEqual(['src/services/release-retention.ts']);
  });

  it('产物回收的 N 是转发而不是第二个字面量', () => {
    const source = read('src/services/release-artifact-retention.ts');

    expect(source).toMatch(/export const RELEASE_ARTIFACT_KEEP_RECENT = KEEP_SUCCESSFUL_RELEASE_RUNS;/);
    // 兜底默认值也必须读常量，不许写成 `input.keepRecent ?? 20`。
    expect(source).not.toMatch(/keepRecent\s*\?\?\s*\d+/);
  });

  it('除存量待迁文件外，没人再对成功 run 列表做裸数字截断', () => {
    const offenders = walk('src', ['.ts'])
      .filter((file) => /successfulRuns[\s\S]{0,80}?\.slice\(\s*0\s*,\s*\d/.test(read(file)))
      .filter((file) => !PENDING_MIGRATION.includes(file));

    expect(offenders).toEqual([]);
  });
});

/** 只扫代码：注释里为了说明事故写法会原样出现被禁的字面量。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('远端产物判定不许分裂', () => {
  it('产物目录形状与自动恢复剥壳只在 release-artifact-retention.ts 定义', () => {
    const shape = walk('src', ['.ts'])
      .filter((file) => /RELEASE_ARTIFACT_ID_PATTERN\s*=/.test(read(file)));
    const strip = walk('src', ['.ts'])
      .filter((file) => /function stripAutoRestoreSuffix\b/.test(read(file)));

    expect(shape).toEqual(['src/services/release-artifact-retention.ts']);
    expect(strip).toEqual(['src/services/release-artifact-retention.ts']);
  });

  it('自动恢复后缀字面量不在别处重写——漂移判定与回收保护必须同源', () => {
    // 事故值：漏剥后缀 → 一次正常自动恢复被报成生产漂移；某一处漏了保护 →
    // 线上正在服务的自动恢复目录被当成陌生残留删掉。两件事必须共用同一个后缀常量。
    const offenders = walk('src', ['.ts'])
      .filter((file) => file !== 'src/services/release-artifact-retention.ts')
      .filter((file) => read(file).includes("'-auto-restore'"));

    expect(offenders).toEqual([]);
  });

  it('删除命令的生成只在纯函数侧，服务层不自己拼 rm', () => {
    const service = read('src/services/release-service.ts');

    expect(service).toContain('buildReleaseReclaimCommand(');
    // 必须剥注释再扫：解释「为什么不能在这里拼 shell」的注释会原样写出 rm -rf，
    // 不剥的话守卫被自己的说明文字触发（本 PR 已栽三次同款）。
    const code = stripComments(service);
    // 服务层拼 shell 就等于绕开形状校验与远端路径复算，两条安全边界一起失效。
    expect(code).not.toMatch(/rm -rf/);
    expect(code).not.toMatch(/worktree remove/);
  });
});
