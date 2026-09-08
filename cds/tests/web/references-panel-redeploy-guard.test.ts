/**
 * 源码守卫：引用分区切换目标后让新值进容器，必须走单服务重新部署（重建容器），
 * 不能走分支 restart（docker restart 保留旧环境变量，切了等于没切；Codex P1，2026-09-02）。
 * 这条接线删掉不会有任何编译或行为测试变红，所以在这里钉住。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PANEL = path.resolve(__dirname, '../../web/src/components/branch/ReferencesPanel.tsx');

describe('引用分区：切换后走重新部署而不是原地重启', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  it('生效动作调用单服务部署接口', () => {
    expect(src).toContain('/deploy/${encodeURIComponent(profileId)}');
    expect(src).toContain("from '@/lib/sse'");
  });
  it('不再调用分支级 restart，也不再传 profileIds', () => {
    expect(src).not.toMatch(/\/restart[`'"]/);
    expect(src).not.toContain('profileIds');
  });
  it('部署期间有持续变化的进度文字，不是静止的等待', () => {
    expect(src).toContain('references-redeploy-progress');
    expect(src).toContain('sseEventText(event, data)');
  });
});
