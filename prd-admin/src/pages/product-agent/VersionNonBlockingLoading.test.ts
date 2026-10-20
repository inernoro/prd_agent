import { describe, expect, it } from 'vitest';
import versions from './VersionWorkflowTab.tsx?raw';
import workflow from './ReleaseWorkflowDetail.tsx?raw';
import picker from './ReleasePlanPicker.tsx?raw';

describe('version pages show content without waiting for every dependency', () => {
  it('mounts formal and internal tables during loading and loads requirement names independently', () => {
    expect(versions).toContain('void getOverviewReleases().then(');
    expect(versions).toContain('onItems: (items) =>');
    expect(versions).toContain('mergeVersionListSnapshot(previous, items)');
    expect(versions).toContain('loadedScope.current !== scope');
    expect(versions).toContain('记录尚未完整读取');
    expect(versions).not.toContain('listLoading\n        ? <MapSectionLoader');
  });

  it('keeps the formal form mounted and isolates plan progress and retry inside its picker', () => {
    expect(workflow).not.toContain('plansLoading ? <MapSectionLoader');
    expect(workflow).toContain("key={issued?.release.id ?? 'new'}");
    expect(workflow).toContain('if (loading && !isNew)');
    expect(workflow).toContain('planLoading={!issued && plansLoading}');
    expect(workflow).toContain('if (loadError || loading || !productId');
    expect(picker).toContain('重试方案加载');
    expect(picker).toContain('方案仍在加载，可先填写其他字段');
  });

  it('mounts the internal form before the member directory finishes', () => {
    expect(versions).not.toContain('if (!members) return');
    expect(versions).toContain('members={members ?? []}');
    expect(versions).toContain('memberNotice={memberNotice}');
    expect(versions).toContain('正在加载可选成员，可以先填写基础信息');
  });
});
