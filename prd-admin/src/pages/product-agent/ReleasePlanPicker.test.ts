import { describe, expect, it } from 'vitest';
import type { ProductInitiation } from './types';
import { filterReleasePlans, releasePlanOption } from './releasePlanOptions';
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
  it('V显示T号及T中最终保存的名称，只检索T记录的业务资料', () => {
    const item = { ...plans[0], planName: 'T记录最终方案名', ownerName: '负责人', demandSource: '客户需求',
      reviewAttempts: [{ planFileName: 'Agent原始文件名' }] } as ProductInitiation;
    const option = releasePlanOption(item, '所属应用');
    expect(option).toMatchObject({ id: item.id, subLabel: 'T1.2.3', label: 'T记录最终方案名' });
    expect(option.searchExtra).toContain('负责人');
    expect(option.searchExtra).toContain('客户需求');
    expect(option.searchExtra).toContain('所属应用');
    expect(JSON.stringify(option)).not.toContain('Agent原始文件名');
    expect(filterReleasePlans([{ ...item, tCode: 'T待定' }, { ...item, tCode: '' }], '', '')).toEqual([]);
    expect(workflow).toContain("(id) => listInitiations(id, 'all')");
  });
  it('直接打开正式申领，方案区只保留搜索选择', () => {
    expect(versions).toContain("dialog === 'temporary' && !actionProductId");
    expect(versions).toContain('productId="" applicationProducts={products}');
    expect(picker).toContain('搜索方案名称或 T 号');
    expect(picker).not.toContain('按应用筛选方案');
    expect(picker).not.toContain('按版本级别筛选方案');
  });
  it('由方案产品 ID 回填并校验提交归属，不提供手工 T 号入口', () => {
    expect(workflow).toContain("changeApplication(source?.productId ?? '')");
    expect(workflow).toContain('selectedInitiation?.productId !== productId');
    expect(workflow).not.toContain('手工 T 号请选择所属应用');
    expect(workflow).not.toContain('manualTCode');
    expect(workflow).toContain("if (!productId) { setLoading(false); return; }");
    expect(workflow).toContain('sequence !== loadSequence.current');
    expect(workflow).toContain('setManifest([]); setBaselineManifest([]); setPreviousReleaseId(null)');
    expect(workflow).toContain('parsed.matchedInitiationId');
    expect(workflow).toContain('chooseInitiation(source.id, source)');
  });
});
