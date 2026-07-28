import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 「防再修一边」守卫。
 *
 * 事故值：同一套「一次发布分成哪几步」的判定曾经有三份拷贝 —— 后端 release-service 拼
 * emitLog 的 phase 字面量、ReleaseCenterPage 与 BranchListPage 各写一份从日志反推步骤条的
 * 逻辑（含三份 releaseScriptPhase 与五处本仓库脚本名字面量）。三份各自漂移的结果是
 * ReleasePlan.steps 定义了却端到端零消费，而 CDS 这个通用产品里长着 './fast.sh' /
 * './exec_dep.sh'。本套件靠源码扫描保证判定源不再分裂。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relative: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relative), 'utf8');
}

function walk(relativeDir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const root = path.join(CDS_ROOT, relativeDir);
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
        out.push(path.relative(CDS_ROOT, full));
      }
    }
  }
  return out;
}

/**
 * 尚未迁到共享 lib 的前端文件。
 *
 * BranchListPage 属于另一条工作流，本轮不动它；列在这里是为了让守卫**现在就生效**
 * （任何新文件再抄一份判定立刻红），同时把这笔欠款显式记账。清掉之后从本表删除即可，
 * 守卫只做子集断言，不会因为少一条而变红。
 */
const PENDING_MIGRATION = ['web/src/pages/BranchListPage.tsx'];

describe('发布步骤判定只有一个源', () => {
  it('releaseScriptPhase 在后端只有 release-steps.ts 一处定义', () => {
    const definitions = walk('src', ['.ts'])
      .filter((file) => /function releaseScriptPhase\b/.test(read(file)));

    expect(definitions).toEqual(['src/services/release-steps.ts']);
  });

  it('拆步判定（isDefaultScriptChain / planDeployPhases）也只在 release-steps.ts 定义', () => {
    const definitions = walk('src', ['.ts'])
      .filter((file) => /function (?:isDefaultScriptChain|planDeployPhases)\b/.test(read(file)));

    expect([...new Set(definitions)]).toEqual(['src/services/release-steps.ts']);
  });

  it('前端页面除待迁移文件外不得自建步骤推断，统一走 lib/releaseSteps.ts', () => {
    const definitions = walk('web/src', ['.ts', '.tsx'])
      .filter((file) => /function (?:releaseScriptPhase|releaseSteps|releaseStepsForRun|releaseCurrentStepLabel)\b/.test(read(file)))
      .filter((file) => !PENDING_MIGRATION.includes(file));

    expect(definitions).toEqual([]);
    expect(read('web/src/lib/releaseSteps.ts')).toContain('export function resolveReleaseSteps(');
  });

  it('执行器与步骤表共用 planDeployPhases，不各拆各的', () => {
    const service = read('src/services/release-service.ts');

    // runDeployCommand 按它迭代执行；buildReleaseRunProgress 按它展开步骤表。
    expect(service).toContain("from './release-steps.js'");
    expect(service).toMatch(/for \(const phase of planDeployPhases\(/);
    // 本文件不许再出现第二份判定。
    expect(service).not.toMatch(/function releaseScriptPhase\b/);
    expect(service).not.toMatch(/function isDefaultScriptChain\b/);
  });
});

describe('CDS 通用产品里不许长本仓库的脚本名', () => {
  it('发布中心页面没有任何仓库脚本名字面量', () => {
    const source = read('web/src/pages/ReleaseCenterPage.tsx');

    // 事故值：DEFAULT_DEPLOY_COMMAND / SCRIPT_LABELS / 步骤标签 / 过滤条件共五处写死。
    expect(source).not.toContain('fast.sh');
    expect(source).not.toContain('exec_dep.sh');
  });

  it('发布中心不再从日志 phase 反推步骤，改读结构化字段', () => {
    const source = read('web/src/pages/ReleaseCenterPage.tsx');

    expect(source).toContain('resolveReleaseSteps(');
    expect(source).not.toMatch(/phaseSet/);
    expect(source).not.toMatch(/reverse\(\)\.find\(\(log\)/);
  });

  it('共享渲染源本身不含仓库脚本名，退化骨架也是通用文案', () => {
    const source = read('web/src/lib/releaseSteps.ts');
    const skeletonLabels = source.match(/label: '[^']+'/g) || [];

    expect(skeletonLabels.length).toBeGreaterThan(0);
    expect(skeletonLabels.join('|')).not.toMatch(/\.sh/);
  });
});
