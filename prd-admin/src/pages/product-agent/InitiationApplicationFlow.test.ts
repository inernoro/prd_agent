import { describe, expect, it } from 'vitest';
import versions from './VersionWorkflowTab.tsx?raw';

const application = versions.slice(versions.indexOf('function InitiationApplication('), versions.indexOf('function InitiationTable('));

describe('内部版本在申领表单内选择应用', () => {
  it('直接进入完整申领表单，前置选择弹框只用于未调整的临时优化', () => {
    expect(versions).toContain("dialog === 'temporary' && !actionProductId");
    expect(versions).toContain("dialog === 'initiation' && <InitiationApplication productId={actionProductId} applicationProducts={products}");
    expect(versions).not.toContain("dialog === 'initiation' && actionProductId &&");
    expect(versions).toContain('setActionProductId(productId)');
    expect(application).toContain('useState(productId)');
    expect(application).toContain('seed?.linkedProductId ?? productId');
    expect(application).toContain('<Field label="所属应用 *" full>');
    expect(application).not.toContain('setProductId(');
  });

  it('切换应用不按产品重新挂载表单，保留已填资料并更新成员目录', () => {
    expect(application).toContain("key={seed?.id ?? 'new'}");
    expect(application).not.toContain('key={productId}');
    expect(application).toContain('if (!item) onApplicationProductChange?.(linkedProductId)');
    expect(application).toContain('onApplicationProductChange={applicationProducts ? setApplicationProductId : undefined}');
    expect(application).toContain('listProductMembers(memberProductId)');
    expect(application).toContain('return () => { active = false; }');
  });

  it('未选应用不请求空产品目录，也不能继续申领', () => {
    expect(application).toContain('if (!memberProductId) { setMembers([]); return; }');
    expect(application).toContain("if (!linkedProductId.trim()) return setMessage('请选择所属应用')");
    expect(application).toContain('disabled={busy || !linkedProductId.trim()}');
  });

  it('新建接口归属与所选应用一致，已有记录和重试仍使用原更新路径', () => {
    expect(application).toContain('createInitiation(applicationProducts ? linkedProductId : productId, payload)');
    expect(application).toContain('linkedProductId,');
    expect(application).toContain('await updateInitiation(item.id, payload)');
    expect(application).toContain('seed?.productId ?? applicationProductId');
    expect(application).toContain('canUseProduct || Boolean(applicationProducts && !item)');
    expect(application).toContain('availableProducts.filter((product) => product.id === productId)');
  });

  it('复用已有授权目录及企微应用回填，不为新入口再读一份目录', () => {
    expect(application).toContain('if (applicationProducts) return;');
    expect(application).toContain('applicationProducts ?? catalogProducts');
    expect(application).toContain('parsed.matchedApplicationId && availableProducts.some');
    expect(application).toContain('setLinkedProductId(parsed.matchedApplicationId)');
  });

  it('选择评审方案先清空旧应用，仅接受服务端唯一识别且当前可选的结果', () => {
    const choose = application.slice(application.indexOf('const chooseReviewSource ='), application.indexOf('const basePayload'));
    expect(application).toContain('onChange={(event) => chooseReviewSource(event.target.value)}');
    expect(choose.indexOf("setLinkedProductId('')")).toBeLessThan(choose.indexOf('parseProductVersionMessage('));
    expect(choose).toContain("parseProductVersionMessage('internal', `产品立项方案名称：${source.title}`)");
    expect(choose).toContain('response.data.result.matchedApplicationId');
    expect(choose).toContain('productOptionsRef.current.some((option) => option.id === applicationId)');
    expect(choose).not.toContain('productMatches');
    expect(choose).not.toContain('setLinkedProductId(productId)');
  });

  it('快速换方案或退出表单后，旧请求不再回填或结束新请求的识别状态', () => {
    expect(application).toContain('const sequence = ++reviewApplicationSequence.current');
    expect(application).toContain('if (sequence !== reviewApplicationSequence.current) return;');
    expect(application).toContain('if (!response.success) {');
    expect(application).not.toContain('planNameRef.current !== entered');
    expect(application).toContain('if (sequence === reviewApplicationSequence.current) setReviewApplicationMatching(false)');
    expect(application).toContain('useEffect(() => () => { reviewApplicationSequence.current += 1; }, [])');
  });

  it('手选应用、编辑标题或重新粘贴会取消当前方案的自动回填，保留人工操作', () => {
    expect(application).toContain('onChange={(id) => { cancelReviewApplicationLookup(); setLinkedProductId(id); }}');
    expect(application).toContain('onChange={(e) => { cancelReviewApplicationLookup(); planNameDraft.setManual(e.target.value); }}');
    expect(application).toMatch(/const applyParsedMessage = [\s\S]*?=> \{\s+cancelReviewApplicationLookup\(\);/);
    expect(application).toContain('reviewApplicationSequence.current += 1;');
  });

  it('识别失败留空且提示手选，等待状态不阻止手动选择', () => {
    expect(application).toContain('暂时无法识别方案所属应用，请手动选择所属应用后继续。');
    expect(application).toContain('正在识别方案所属应用，也可手动选择。');
    expect(application).not.toContain('disabled={reviewApplicationMatching}');
  });
});
