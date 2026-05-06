import { describe, it, expect } from 'vitest';
import { analyzeChangeImpact } from '../../src/services/change-impact-analyzer.js';

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

  it('纯文档/changelogs → 全部 irrelevant', () => {
    const r = analyzeChangeImpact([
      'README.md',
      'CHANGELOG.md',
      'doc/design.foo.md',
      'changelogs/2026-05-06_x.md',
      '.claude/rules/x.md',
    ]);
    expect(r.needsRestart).toBe(false);
    expect(r.hotReloadablePaths).toHaveLength(0);
    expect(r.irrelevantPaths).toHaveLength(5);
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
