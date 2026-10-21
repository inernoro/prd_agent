import { describe, expect, it } from 'vitest';
import versions from './VersionWorkflowTab.tsx?raw';
import workflow from './ReleaseWorkflowDetail.tsx?raw';
import picker from './ReleasePlanPicker.tsx?raw';
import client from '@/services/real/productAgent.ts?raw';
import copyActions from './VersionCopyActions.tsx?raw';

describe('version pages show content without waiting for every dependency', () => {
  it('reads each tab globally and keeps tables silent and existing records during refresh', () => {
    expect(versions).toContain('await getWorkflowInitiations()');
    expect(versions).toContain('await getWorkflowReleases()');
    expect(versions).toContain('new Map(Object.entries(result.data.requirementNames))');
    expect(versions).not.toContain('loadProductVersionList');
    expect(versions).not.toContain('setInitiations([])');
    expect(versions).not.toContain('setReleases([])');
    expect(versions).not.toContain('正在补充版本记录');
    expect(versions).not.toContain('记录尚未完整读取');
    expect(versions).toContain('items.length === 0 && !pending');
    expect(versions).toContain('requestSequence.current === sequence');
    expect(versions).not.toContain('listLoading\n        ? <MapSectionLoader');
  });

  it('includes legacy records in the primary tables without extra history entry points', () => {
    expect(versions).not.toContain('查看旧登记记录');
    expect(versions).not.toContain('查看历史存档');
    expect(versions).not.toContain('setArchive');
    expect(versions).toContain('...record, legacyRegistration');
    expect(versions).toContain('onOpenLegacy(item.legacyRegistration)');
    expect(versions).toContain('!item.legacyRegistration && item.createdBy === currentUserId');
    expect(versions).toContain('if (!result.success)');
    expect(versions).toContain('版本记录读取失败，请重试');
    expect(client).toContain('/api/product/overview/initiations?workflow=true');
    expect(client).toContain('/api/product/overview/releases?workflow=true');
    expect(copyActions).toContain('legacy ? getLegacyVersionCopyTemplate(id)');
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

  it('mounts the internal form without loading a removed approver directory', () => {
    expect(versions).not.toContain('if (!members) return');
    expect(versions).not.toContain('listProductMembers(');
    expect(versions).not.toContain('memberNotice=');
    expect(versions).not.toContain('正在加载可选成员，可以先填写基础信息');
  });
});
