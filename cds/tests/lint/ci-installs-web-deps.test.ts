/**
 * ci-installs-web-deps.test.ts —— CI 必须装 cds/web 依赖。
 *
 * 背景（2026-07-29 本 PR 真实踩到）：tests/web/release-center-render-smoke.test.ts
 * 直接 import 前端组件做渲染冒烟，react 由 vitest.config.ts 别名到
 * cds/web/node_modules。本地两处依赖都在，跑得通；CI 的 cds 作业只在 cds/ 跑
 * `pnpm install`，别名解析不到就静默不加，测试文件以
 * `Failed to load url react` 整体加载失败。
 *
 * 这条守卫防的是「修复方式选错」：把渲染冒烟改成条件跳过，CI 会变绿，
 * 而那个绿灯什么都没证明——比没有测试更糟（见
 * .claude/rules/predicate-and-wiring-discipline.md 形状 4b）。所以把
 * 「CI 真的装了前端依赖」钉成断言：删掉安装步骤，这里立刻红。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const WORKFLOWS = [
  { file: '.github/workflows/ci.yml', job: 'cds-build', name: 'CDS Build & Test' },
  { file: '.github/workflows/cds.yml', job: 'build-and-test', name: 'Build & Test' },
];

function read(rel: string): string {
  return fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');
}

/**
 * 只取这一个作业的 YAML 块。ci.yml 里 admin / desktop 等作业也有 `pnpm test`，
 * 全文 indexOf 会取到别人的那一条，顺序断言就成了错判。
 */
function jobBlock(yaml: string, job: string): string {
  const start = yaml.indexOf(`\n  ${job}:`);
  if (start < 0) throw new Error(`未找到作业 ${job}`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('CI 跑 cds 测试前必须装 cds/web 依赖', () => {
  it.each(WORKFLOWS)('$file 的「$name」作业装了前端依赖', ({ file, job }) => {
    // 认脚本名而不是认某一种命令写法：换成 pnpm --dir web / cd web && pnpm i
    // 都行，只要仍然经过这个统一入口。
    expect(jobBlock(read(file), job)).toContain('pnpm run install:web');
  });

  it('install:web 脚本存在，且装的是 cds/web', () => {
    const pkg = JSON.parse(read('cds/package.json')) as { scripts?: Record<string, string> };
    const script = pkg.scripts?.['install:web'];
    expect(script).toBeTruthy();
    expect(script).toContain('web');
  });

  it('安装步骤排在跑测试之前（顺序错了等于没装）', () => {
    for (const { file, job } of WORKFLOWS) {
      const block = jobBlock(read(file), job);
      const install = block.indexOf('pnpm run install:web');
      const test = block.indexOf('pnpm test');
      expect(install, file).toBeGreaterThan(-1);
      expect(test, file).toBeGreaterThan(-1);
      expect(install, file).toBeLessThan(test);
    }
  });

  it('缓存键带上 web 的 lockfile，否则前端依赖变了还命中旧 store', () => {
    for (const { file } of WORKFLOWS) {
      expect(read(file), file).toContain("cds/web/pnpm-lock.yaml");
    }
  });
});

describe('渲染冒烟没有被改成「装不上就跳过」', () => {
  it('测试文件里没有条件 skip', () => {
    const smoke = fs.readFileSync(
      path.resolve(here, '../web/release-center-render-smoke.test.ts'),
      'utf8',
    );
    // describe.skipIf / it.skipIf / 手写 if (!react) return 都算把绿灯换成空跑。
    expect(smoke).not.toMatch(/\.skipIf\(/);
    expect(smoke).not.toMatch(/describe\.skip\b/);
    expect(smoke).not.toMatch(/it\.skip\b/);
  });
});
