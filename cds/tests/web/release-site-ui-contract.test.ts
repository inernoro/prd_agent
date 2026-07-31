import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReleaseHealthcheckUrl,
  normalizeProductionOrigin,
} from '../../web/src/lib/releaseCenter.js';

/**
 * 发布中心 v2 把 1600 行单文件拆成了 pages/release-center/ 下的一组组件，
 * 所以这里扫的是「入口页 + 整个 release-center 目录」而不是单个文件——
 * 只盯入口页的话，任何一段文案搬进子组件都会让本用例静默变绿（假通过）。
 */
const releaseCenterDir = path.resolve(process.cwd(), '../cds/web/src/pages/release-center');
const releaseCenterFiles = [
  path.resolve(process.cwd(), '../cds/web/src/pages/ReleaseCenterPage.tsx'),
  ...fs.readdirSync(releaseCenterDir)
    .filter((name) => name.endsWith('.tsx') || name.endsWith('.ts'))
    .map((name) => path.join(releaseCenterDir, name)),
];
const releaseCenterSource = releaseCenterFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const releaseCenterEntrySource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/ReleaseCenterPage.tsx'),
  'utf8',
);

const branchListSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchListPage.tsx'),
  'utf8',
);

const releaseCenterLibSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/lib/releaseCenter.ts'),
  'utf8',
);

function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    literals.push(match[2]);
  }
  return literals;
}

describe('release site publishing UI contract', () => {
  it('keeps the release center in site publishing language', () => {
    expect(releaseCenterSource).toContain('站点发布');
    expect(releaseCenterSource).toContain('还没有站点发布目标');
    // v2 起「添加站点发布」改叫「添加环境」：左栏是环境列表，不是目标列表。
    expect(releaseCenterSource).toContain('添加环境');
    expect(releaseCenterSource).toContain('选择服务器');
    expect(releaseCenterSource).toContain('生产域名');
    expect(releaseCenterSource).toContain('远端项目仓库');
    expect(releaseCenterSource).toContain('CDS 动态 Compose 发布');
    expect(releaseCenterSource).toContain('CDS 动态静态站发布');
    expect(releaseCenterSource).toContain('项目现有脚本');
    expect(releaseCenterSource).toContain('项目身份');
    expect(releaseCenterSource).toContain('已归档发布目标');
    expect(releaseCenterSource).toContain('健康检查');
    expect(releaseCenterSource).toContain('发布记录');
    expect(releaseCenterSource).toContain('响应时间');
    expect(releaseCenterSource).toContain('最近检查');
    expect(releaseCenterSource).toContain('回滚策略');
    expect(releaseCenterSource).toContain('选择目标版本');
    expect(releaseCenterSource).toContain('确认回滚');
    expect(releaseCenterSource).toContain('重试发布');
    expect(releaseCenterSource).toContain('calc(100vw - 32px)');
  });

  it('keeps raw SSH target terminology out of visible release center copy', () => {
    const text = stringLiterals(releaseCenterSource).join('\n');
    expect(text).not.toContain('SSH Target');
    expect(text).not.toContain('App Path');
    expect(text).not.toContain('Deploy Command');
    expect(text).not.toContain('Health URL');
    expect(text).not.toContain('ReleaseRun');
  });

  it('keeps manual generated release defaults scoped to the selected project draft', () => {
    expect(releaseCenterSource).toContain('releaseModeDefinitions(discovery, draft)');
    expect(releaseCenterSource).toContain('composeProject: draft.composeProject');
    expect(releaseCenterSource).toContain('publicDirectory: draft.publicDirectory');
    expect(releaseCenterSource).not.toContain("composeProject: 'cds-production'");
    expect(releaseCenterSource).not.toContain("publicDirectory: '/opt/site-web'");
  });

  it('clears a hidden script rollback command when the selected strategy is generated', () => {
    expect(releaseCenterSource).toContain(
      "rollbackCommand: draft.strategyMode === 'existing-script' ? draft.rollbackCommand.trim() : ''",
    );
  });

  it('keeps branch release confirmation in user-facing site language', () => {
    expect(branchListSource).toContain('从已验收预览分支发布到站点。');
    expect(branchListSource).toContain('发布站点');
    expect(branchListSource).toContain('发布确认');
    expect(branchListSource).toContain('发布目标');
    expect(branchListSource).toContain('服务器');
    expect(branchListSource).toContain('目录');
    expect(branchListSource).toContain('执行计划');
    expect(branchListSource).toContain('动态执行');
    expect(branchListSource).toContain('原子切换');
    expect(branchListSource).toContain('发布脚本可执行');
    expect(branchListSource).toContain('上线地址');
    expect(branchListSource).toContain('开始发布');
    expect(branchListSource).toContain('等待发布日志');
    expect(branchListSource).toContain('calc(100vw - 32px)');
  });

  it('keeps the default release center entry clean while retaining project scoping', () => {
    expect(releaseCenterLibSource).toContain("DEFAULT_RELEASE_CENTER_PROJECT_ID = 'prd-agent'");
    expect(releaseCenterLibSource).toContain("return '/release-center'");
    expect(releaseCenterLibSource).toContain('release-center?project=');
    expect(releaseCenterSource).toContain('initialReleaseCenterProject(');
    expect(releaseCenterSource).toContain('rememberReleaseCenterProject(');
    expect(branchListSource).toContain('releaseCenterHref(branch.projectId)');
    expect(branchListSource).not.toContain('/release-center?project=${encodeURIComponent(branch.projectId)}');
  });

  it('normalizes pasted production URLs before appending the health path', () => {
    expect(normalizeProductionOrigin('https://www.a.example.test/admin?tab=1'))
      .toBe('https://www.a.example.test');
    expect(normalizeProductionOrigin('www.a.example.test/admin'))
      .toBe('https://www.a.example.test');
    expect(buildReleaseHealthcheckUrl('https://www.a.example.test/admin', '/api/health'))
      .toBe('https://www.a.example.test/api/health');
    expect(buildReleaseHealthcheckUrl(
      'https://www.a.example.test/admin',
      '/api/health',
      'https://health.example.test/ready',
    )).toBe('https://health.example.test/ready');
  });

  it('shows release run progress as business steps, not raw logs only', () => {
    // 两个发布界面（发布中心、分支侧向导）的步骤条都由后端 run.progress 驱动：
    // 不再从日志 phase 反推，也不再有「执行本机生产发布」这种按命令特判出的标签。
    //
    // 本用例此前断言的是**旧实现**——要求 BranchListPage 里出现
    // `执行 ${scriptOne.replace` 与 `releaseScriptPhase(scriptOne)`，也就是
    // 逐字要求那份带 './fast.sh' 兜底的拷贝存在。测试写成这样，等于把 bug 焊死：
    // 谁去掉硬编码谁的 CI 就红。改成断言「走共享判定源」。
    expect(releaseCenterSource).toContain('resolveReleaseSteps(');
    expect(releaseCenterSource).toContain('第 {progress.currentIndex}/{progress.total} 步');
    expect(releaseCenterSource).not.toContain("phaseSet.has('deploy')");

    expect(branchListSource).toContain('resolveReleaseSteps(');
    expect(branchListSource).toContain('ReleaseRunStepList');
    // 「第 N/M 步 · 标题」也要在分支侧出现，两个界面对同一次发布说同一句话。
    expect(branchListSource).toContain('releaseCurrentStepText(');
    expect(branchListSource).not.toContain('releaseStepsForRun(');

    // 步骤标题的实际文案落在共享渲染源的退化骨架与后端计划模板里。
    const stepsLib = fs.readFileSync(
      path.resolve(process.cwd(), '../cds/web/src/lib/releaseSteps.ts'),
      'utf8',
    );
    for (const label of ['连接服务器', '进入站点目录', '执行发布命令', '检查上线地址', '标记完成']) {
      expect(stepsLib).toContain(label);
    }
  });

  it('splits the branch release dialog into wizard stages so live status is never buried', () => {
    // 分阶段派生:一旦 run 存在就进入「发布」阶段,前序配置/预检收起,状态区不再被长滚动挤到底部。
    expect(branchListSource).toContain("stage: 'config' | 'preflight' | 'releasing'");
    expect(branchListSource).toContain('ReleaseWizardRail');
    expect(branchListSource).toContain('ReleaseStageSummary');
    expect(branchListSource).toContain('选择站点');
    // 长脚本收进「查看脚本」折叠 + 自身横向滚动框,不再平铺撑破弹窗。
    expect(branchListSource).toContain('查看脚本');
    expect(branchListSource).toContain("check.id === 'deploy-command'");
    // 主操作固定在底部 sticky footer,发布中/发布后始终可见。
    expect(branchListSource).toContain('sticky bottom-0');
  });

  it('keeps raw SSH target terminology out of visible branch release copy', () => {
    const text = stringLiterals(branchListSource).join('\n');
    expect(text).not.toContain('SSH target');
    expect(text).not.toContain('SSH Target');
    expect(branchListSource).not.toMatch(/>\s*ReleaseRun\s*</);
    expect(branchListSource).not.toMatch(/['"`]ReleaseRun['"`]/);
  });
});
