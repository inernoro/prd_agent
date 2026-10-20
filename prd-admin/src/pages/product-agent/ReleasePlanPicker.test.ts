import { describe, expect, it } from 'vitest';
import type { ProductInitiation } from './types';
import { filterReleasePlans } from './releasePlanOptions';
import picker from './ReleasePlanPicker.tsx?raw';
import workflow from './ReleaseWorkflowDetail.tsx?raw';
import versions from './VersionWorkflowTab.tsx?raw';

const plan = (id: string, productId: string, versionType: string, status = 'approved') => ({ id, productId, versionType, status, tCode: 'T1.2.3', planName: id } as ProductInitiation);

describe('正式申领按方案选择应用', () => {
  const plans = [plan('a', 'app-a', 'minor'), plan('b', 'app-b', 'major'), plan('c', 'app-a', 'minor', 'draft')];
  it('全域方案包含各应用，应用与级别筛选均可清空', () => {
    expect(filterReleasePlans(plans, '', '').map((item) => item.id)).toEqual(['a', 'b']);
    expect(filterReleasePlans(plans, 'app-a', '').map((item) => item.id)).toEqual(['a']);
    expect(filterReleasePlans(plans, '', 'major').map((item) => item.id)).toEqual(['b']);
    expect(filterReleasePlans(plans, 'app-a', 'major')).toEqual([]);
  });
  it('只选择已通过且有 T 号的方案', () => {
    expect(filterReleasePlans([...plans, { ...plans[0], id: 'no-code', tCode: '' }], '', '').map((item) => item.id)).toEqual(['a', 'b']);
  });
  it('直接打开正式申领，不先打开产品选择弹框，筛选只用于找方案', () => {
    expect(versions).toContain("dialog && dialog !== 'release' && !actionProductId");
    expect(versions).toContain('productId="" applicationProducts={products}');
    expect(picker).toContain('搜索方案名称或 T 号');
    expect(picker).toContain('按应用筛选方案');
    expect(picker).toContain('按版本级别筛选方案');
  });
  it('由方案产品 ID 回填并校验提交归属，手工 T 号保留表单内应用选择', () => {
    expect(workflow).toContain("changeApplication(source?.productId ?? '')");
    expect(workflow).toContain('selectedInitiation?.productId !== productId');
    expect(workflow).toContain('手工 T 号请选择所属应用');
    expect(workflow).toContain("if (!productId) { setLoading(false); return; }");
    expect(workflow).toContain('sequence !== loadSequence.current');
    expect(workflow).toContain('setManifest([]); setBaselineManifest([]); setPreviousReleaseId(null)');
    expect(workflow).toContain('matches.length === 1');
  });
});
