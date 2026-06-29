import { describe, it, expect } from 'vitest';
import { analyzeChangeImpact, isWebOnlyChange } from '../../src/services/change-impact-analyzer.js';

describe('analyzeChangeImpact', () => {
  it('全部应用代码 → 热重载', () => {
    const r = analyzeChangeImpact([
      'cds/src/routes/branches.ts',
      'cds/src/services/foo.ts',
      'cds/web/src/pages/BranchListPage.tsx',
    ]);
    expect(r.needsRestart).toBe(false);
    expect(r.hotReloadablePaths.length).toBe(3);
    expect(r.restartTriggers).toHaveLength(0);
  });

  it('package.json 变更 → 必须重启', () => {
    const r = analyzeChangeImpact(['cds/package.json', 'cds/src/foo.ts']);
    expect(r.needsRestart).toBe(true);
    expect(r.restartTriggers[0].reason).toMatch(/依赖清单/);
  });

  it('lockfile 变更 → 必须重启', () => {
    const r = analyzeChangeImpact(['cds/pnpm-lock.yaml']);
    expect(r.needsRestart).toBe(true);
    expect(r.restartTriggers[0].reason).toMatch(/lockfile/);
  });

  it('Dockerfile / compose / .env → 必须重启', () => {
    expect(analyzeChangeImpact(['cds/Dockerfile']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['docker-compose.dev.yml']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['cds/.cds.env']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['prd-api/appsettings.json']).needsRestart).toBe(true); // unknown 文件保守
  });

  it('tsconfig / vite.config 变更 → 必须重启', () => {
    expect(analyzeChangeImpact(['cds/tsconfig.json']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['cds/web/tsconfig.json']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['cds/web/vite.config.ts']).needsRestart).toBe(true);
  });

  it('CDS 关键 schema 文件 → 必须重启', () => {
    expect(analyzeChangeImpact(['cds/src/server.ts']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['cds/src/index.ts']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['cds/src/types.ts']).needsRestart).toBe(true);
    expect(analyzeChangeImpact(['cds/src/config.ts']).needsRestart).toBe(true);
  });

  it('systemd unit 变更 → 必须重启', () => {
    expect(analyzeChangeImpact(['cds/systemd/cds-master.service']).needsRestart).toBe(true);
  });

  it('纯文档/changelogs/验证脚本/测试 → 全部 irrelevant', () => {
    const r = analyzeChangeImpact([
      'README.md',
      'CHANGELOG.md',
      'doc/design.foo.md',
      'changelogs/2026-05-06_x.md',
      '.claude/rules/x.md',
      'scripts/smoke-cds-agent-one-cycle.sh',
      'scripts/audit-cds-agent-goal.sh',
      'scripts/doctor-cds-agent-runtime.sh',
      'scripts/preflight-cds-agent-cds-self-update.sh',
      'scripts/verify-cds-agent-r0-after-self-update.sh',
      'scripts/index-cds-agent-cycle-evidence.sh',
      'cds/tests/services/github-webhook-dispatcher.test.ts',
      'prd-admin/src/pages/cds-agent/__tests__/cdsAgentReadiness.test.ts',
      'e2e/specs/cds-branch-runtime-visual.spec.ts',
    ]);
    expect(r.needsRestart).toBe(false);
    expect(r.hotReloadablePaths).toHaveLength(0);
    expect(r.irrelevantPaths).toHaveLength(14);
  });

  it('未知普通脚本仍保守判定为重启', () => {
    const r = analyzeChangeImpact(['scripts/deploy-production.sh']);
    expect(r.needsRestart).toBe(true);
    expect(r.restartTriggers[0].reason).toMatch(/未知改动/);
  });

  it('混合改动:应用代码 + 文档 → 仍是热重载', () => {
    const r = analyzeChangeImpact([
      'cds/src/services/foo.ts',
      'README.md',
      'doc/x.md',
    ]);
    expect(r.needsRestart).toBe(false);
    expect(r.hotReloadablePaths).toHaveLength(1);
    expect(r.irrelevantPaths).toHaveLength(2);
  });

  it('未知文件类型 → 保守判定为重启', () => {
    const r = analyzeChangeImpact(['some/unknown.bin']);
    expect(r.needsRestart).toBe(true);
    expect(r.restartTriggers[0].reason).toMatch(/未知改动/);
  });

  it('空 diff → 视为无变更(不需要重启)', () => {
    const r = analyzeChangeImpact([]);
    expect(r.needsRestart).toBe(false);
    expect(r.hotReloadablePaths).toHaveLength(0);
  });
});

describe('isWebOnlyChange (Phase A 零停机前端更新判定)', () => {
  it('纯前端文件改动 → web-only', () => {
    const paths = [
      'cds/web/src/pages/BranchListPage.tsx',
      'cds/web/src/components/CapacityFullDialog.tsx',
      'cds/web/src/index.css',
    ];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(true);
  });

  it('混合前端 + 后端 → false(必须 esbuild + 重启)', () => {
    const paths = [
      'cds/web/src/pages/BranchListPage.tsx',
      'cds/src/routes/branches.ts',
    ];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(false);
  });

  it('纯后端改动 → false(没有 web 文件)', () => {
    const paths = ['cds/src/routes/branches.ts'];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(false);
  });

  it('cds/web/package.json 改动 → false(needsRestart 命中 lockfile/依赖)', () => {
    const paths = ['cds/web/package.json'];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(false);
  });

  it('cds/web/vite.config.ts 改动 → false(needsRestart 命中 vite 配置)', () => {
    const paths = ['cds/web/vite.config.ts', 'cds/web/src/main.tsx'];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(false);
  });

  it('纯文档 → false(doc-only 路径处理,不走 web build)', () => {
    const paths = ['README.md', 'doc/x.md'];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(false);
  });

  it('前端 + 文档混合 → true(文档随便改不影响)', () => {
    const paths = [
      'cds/web/src/App.tsx',
      'doc/plan.cds.legacy-feature-rollup.md',
      'changelogs/2026-05-08_x.md',
    ];
    expect(isWebOnlyChange(analyzeChangeImpact(paths), paths)).toBe(true);
  });

  it('空 diff → false(走 doc-only 或冷路径兜底)', () => {
    expect(isWebOnlyChange(analyzeChangeImpact([]), [])).toBe(false);
  });
});
