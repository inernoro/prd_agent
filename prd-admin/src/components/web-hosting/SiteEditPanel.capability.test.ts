import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8');
const webPagesServiceSource = readFileSync(new URL('../../services/real/webPages.ts', import.meta.url), 'utf8');
const htmlPptServiceSource = readFileSync(new URL('../../services/real/mdToPptService.ts', import.meta.url), 'utf8');

describe('网页微调执行器事实接线', () => {
  it('展示实际执行归属和隔离边界，并保留未就绪原因', () => {
    expect(source).toContain('执行器与限制');
    expect(source).toContain('<details className="group');
    expect(source).toContain("activeRuntime.executionOwner === 'cds-remote-agent'");
    expect(source).toContain("activeRuntime.isolationMode === 'session-container'");
    expect(source).toContain("item.reason || '未启用'");
  });

  it('只有已启用执行器可以进入选择框', () => {
    expect(source).toContain('const enabledRuntimes = capabilities.filter((item) => item.enabled)');
    expect(source).toContain('{enabledRuntimes.map((item) => (');
  });

  it('只提交知识身份并由服务端校验正文和容量', () => {
    expect(source).not.toContain('getDocumentContent');
    expect(source).not.toContain('.slice(0, 20_000)');
    expect(source).toContain('entryId: entry.id');
    expect(source).toContain('storeId: entry.storeId');
  });

  it('网页生成、网页修改和 HTML PPT 都先预检并携带服务端内容哈希', () => {
    expect(webPagesServiceSource).toContain('resolveDesignKnowledgeReferences(input.knowledgeReferences)');
    expect(webPagesServiceSource).toContain('resolveDesignKnowledgeReferences(knowledgeReferences)');
    expect(webPagesServiceSource.match(/entryId, storeId, contentHash/g)?.length).toBeGreaterThanOrEqual(2);
    expect(htmlPptServiceSource.match(/resolveMdToPptKnowledgeReferences/g)?.length).toBeGreaterThanOrEqual(4);
    expect(htmlPptServiceSource).toContain("'/api/md-to-ppt/knowledge-references/resolve'");
    expect(htmlPptServiceSource.match(/entryId, storeId, contentHash/g)?.length).toBeGreaterThanOrEqual(3);
    expect(htmlPptServiceSource).not.toContain('content: item.content');
  });

  it('在开始前明示首版自包含输入边界', () => {
    expect(source).toContain('首版仅支持声明式自包含 HTML，含脚本、外链或 ZIP 资源会在任务创建前提示。');
  });

  it('版本操作具有明确文字和不小于 44px 的点击热区', () => {
    expect(source).toContain('aria-label="刷新版本记录"');
    expect(source).toContain('aria-label="预览这个版本"');
    expect(source).toContain('aria-label="把这个版本重新发布为最新版"');
    expect(source).toContain('确认并发布');
    expect(source).toContain('回退');
    expect(source).toContain('aria-label="拒绝这个草稿"');
    expect(source).toContain('确认拒绝这个草稿');
    expect(source.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it('拒绝草稿走独立端点、保留可选原因并明确线上无变化', () => {
    expect(webPagesServiceSource).toContain('api.webPages.rejectRevision(siteId, revisionId)');
    expect(webPagesServiceSource).toContain("body: { reason: reason?.trim() || null }");
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('maxLength={500}');
    expect(source).toContain('拒绝后该草稿不能再发布，但版本记录会保留');
    expect(source).toContain("item.status === 'rejected'");
    expect(source).toContain('拒绝原因：{item.rejectionReason}');
  });

  it('从卡片进入版本记录时会把历史区滚入视野', () => {
    expect(source).toContain("focusSection?: 'compose' | 'history'");
    expect(source).toContain("focusSection === 'history' ? historyRef.current : composeRef.current");
    expect(source).toContain("scrollIntoView({ block: 'start', behavior: 'smooth' })");
  });

  it('长时间远程微调时每秒更新可见时长', () => {
    expect(source).toContain('window.setInterval');
    expect(source).toContain('runningGenerationActivity(phase, elapsedSeconds)');
    expect(source).toContain("generating ? '任务运行中'");
    expect(source).toContain('animate-pulse');
    expect(source).toContain('aria-valuenow={generating ? undefined : progress}');
  });

  it('把生成过程拆成可感知阶段，并向辅助技术播报动态进度', () => {
    expect(source).toContain('GENERATION_STAGES');
    expect(source).toContain('AI 正在生成隔离草稿');
    expect(source).toContain('aria-label="AI 修改进度"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="progressbar"');
    expect(source).toContain("aria-valuetext={generating ? '任务正在执行' : `${progress}%`}");
    expect(source).toContain('className="sr-only">{phase}</span>');
    expect(source).toContain('<p aria-hidden="true"');
    expect(source).toContain('motion-reduce:transition-none');
  });

  it('等待期只展示结构进度与安全占位，验证完成后才展示真实页面', () => {
    expect(source).toContain('data-testid="safe-preview-placeholder"');
    expect(source).toContain('{generating && !previewHtml && (');
    expect(source).toContain('正在验证页面结构');
    expect(source).toContain('验证完成后显示真实页面');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('motion-reduce:animate-none');
    expect(source).toContain('{previewHtml ? (');
    expect(source).toContain('srcDoc={previewHtml}');
  });

  it('明确表达草稿到发布的版本心智，并区分预览中的真实版本', () => {
    expect(source).toContain('aria-label="版本发布流程"');
    expect(source).toContain("['1', '生成草稿', '线上不变']");
    expect(source).toContain("['2', '人工预览', '确认效果']");
    expect(source).toContain("['3', '发布上线', '保留历史']");
    expect(source).toContain('previewedRevision ? revisionLabel(previewedRevision)');
    expect(source).toContain('访客当前看到的线上内容');
    expect(source).toContain('仅你可见，尚未影响线上页面');
    expect(source).toContain('回退会复制所选历史内容并发布为新版本，不会删除任何记录。');
  });

  it('错误不只发瞬时提示，还保留就地恢复动作与线上安全结论', () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('retryRecovery');
    expect(source).toContain('按原要求重试');
    expect(source).toContain('调整要求或切换执行器');
    expect(source).toContain('adjustFailedGeneration');
    expect(source).toContain('请移除脚本、外链、表单或动态嵌入');
    expect(source).toContain('当前线上版本仍然有效，可直接重试发布。');
    expect(source).toContain('当前线上版本没有变化，可再次尝试。');
  });

  it('远程会话失败后等待运行环境真实恢复再允许重试', () => {
    expect(source).toContain('runtimeRecoveryGate');
    expect(source).toContain("runtime?.isolationMode !== 'session-container'");
    expect(source).toContain('timer = window.setTimeout(inspect, 2000)');
    expect(source).toContain('正在回收运行环境，已检查');
    expect(source).toContain('runtimeRecoveryGate !== null');
    expect(source).toContain("className={runtimeRecoveryGate ? 'animate-spin' : ''}");
    expect(source).toContain('运行环境已回收，可以按原要求重试。');
  });

  it('并发版本冲突提供刷新记录和按原要求另存草稿两条恢复路径', () => {
    expect(source).toContain("result.error?.code === 'REVISION_CONFLICT'");
    expect(source).toContain('刷新版本记录');
    expect(source).toContain('按原要求另存新草稿');
    expect(source).toContain("recoverFromVersionConflict('refresh')");
    expect(source).toContain("recoverFromVersionConflict('regenerate')");
  });

  it('版本卡首屏说明改动摘要，技术标识默认折叠', () => {
    expect(source).toContain("? '初始版本'");
    expect(source).toContain("? 'AI 修改'");
    expect(source).toContain("? '回退复制'");
    expect(source).toContain('revisionChangeSummary(item, rollbackTargetRevision)');
    expect(source).toContain('{changeSummary}');
    expect(source).toContain('<summary className="min-h-11 cursor-pointer py-3');
    expect(source).not.toContain('<summary className="inline-flex');
    expect(source).toContain('技术信息');
    expect(source).not.toContain('来源动作：{sourceAction} · 来源版本：{sourceVersion}');
    expect(source).toContain('revisions.find((candidate) => candidate.id === item.parentRevisionId)');
    expect(source).toContain('item.rollbackTargetRevisionId');
    expect(source).toContain('回退目标：${revisionLabel(rollbackTargetRevision)}');
  });

  it('回退先进入可聚焦确认态并说明目标、线上影响和可恢复性', () => {
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain('确认回退到 {revisionLabel(pendingRollback)}');
    expect(source).toContain('确认后访客看到的线上页面会立即替换为该版本内容');
    expect(source).toContain('系统会复制内容并创建一个可恢复的新版本');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('确认回退');
    expect(source).toContain('cancelRollback');
  });

  it('回退使用持久幂等键，失败重试复用同一键', () => {
    expect(webPagesServiceSource).toContain("headers: { 'Idempotency-Key': idempotencyKey }");
    expect(source).toContain('const idempotencyKey = createRevisionMutationIdempotencyKey()');
    expect(source).toContain('idempotencyKey,');
    expect(source).toContain('rollback(revisionId, recoveryNotice.idempotencyKey)');
  });

  it('确认拒绝或回退后把焦点恢复到触发按钮或版本记录区', () => {
    expect(source).toContain('restoreRevisionMutationFocus(');
    expect(source).toContain('rollbackReturnFocusRef.current,');
    expect(source).toContain('rejectReturnFocusRef.current,');
    expect(source.match(/historyRef\.current,/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('tabIndex={-1}');
  });

  it('HTML PPT 在 convert 前持久确认正文和大纲绑定', () => {
    expect(htmlPptServiceSource).toContain('/confirm`');
    expect(htmlPptServiceSource).toContain('content: options.content');
    expect(htmlPptServiceSource).toContain('outlinePages: options.outlinePages');
    const confirmation = htmlPptServiceSource.indexOf('const confirmation = await fetch');
    const convert = htmlPptServiceSource.indexOf("fetch('/api/md-to-ppt/convert'");
    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(convert).toBeGreaterThan(confirmation);
  });

  it('修改要求有真实标签，知识选择向辅助技术暴露选中状态', () => {
    expect(source).toContain('htmlFor={`site-edit-instruction-${site.id}`}');
    expect(source).toContain('id={`site-edit-instruction-${site.id}`}');
    expect(source).toContain('aria-pressed={selected}');
  });
});
