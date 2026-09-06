import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8');

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

  it('在开始前明示首版自包含输入边界', () => {
    expect(source).toContain('首版仅支持声明式自包含 HTML，含脚本、外链或 ZIP 资源会在任务创建前提示。');
  });

  it('版本操作具有明确文字和不小于 44px 的点击热区', () => {
    expect(source).toContain('aria-label="刷新版本记录"');
    expect(source).toContain('aria-label="预览这个版本"');
    expect(source).toContain('aria-label="把这个版本重新发布为最新版"');
    expect(source).toContain('确认并发布');
    expect(source).toContain('回退');
    expect(source.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it('从卡片进入版本记录时会把历史区滚入视野', () => {
    expect(source).toContain("focusSection?: 'compose' | 'history'");
    expect(source).toContain("focusSection === 'history' ? historyRef.current : composeRef.current");
    expect(source).toContain("scrollIntoView({ block: 'start', behavior: 'smooth' })");
  });

  it('长时间远程微调时每秒更新可见时长', () => {
    expect(source).toContain('window.setInterval');
    expect(source).toContain('{progress}% · {elapsedSeconds} 秒');
  });

  it('把生成过程拆成可感知阶段，并向辅助技术播报动态进度', () => {
    expect(source).toContain('GENERATION_STAGES');
    expect(source).toContain('AI 正在生成隔离草稿');
    expect(source).toContain('aria-label="AI 修改进度"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('role="progressbar"');
    expect(source).toContain('aria-valuenow={progress}');
    expect(source).toContain('motion-reduce:transition-none');
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
    expect(source).toContain('当前线上版本仍然有效，可直接重试发布。');
    expect(source).toContain('当前线上版本没有变化，可再次尝试。');
  });

  it('并发版本冲突提供刷新记录和按原要求另存草稿两条恢复路径', () => {
    expect(source).toContain("result.error?.code === 'REVISION_CONFLICT'");
    expect(source).toContain('刷新版本记录');
    expect(source).toContain('按原要求另存新草稿');
    expect(source).toContain("recoverFromVersionConflict('refresh')");
    expect(source).toContain("recoverFromVersionConflict('regenerate')");
  });

  it('版本卡说明来源动作和父版本，首个版本明确标为初始版本', () => {
    expect(source).toContain("? '初始版本'");
    expect(source).toContain("? 'AI 修改'");
    expect(source).toContain("? '回退复制'");
    expect(source).toContain('来源动作：{sourceAction} · 来源版本：{sourceVersion}');
    expect(source).toContain('revisions.find((candidate) => candidate.id === item.parentRevisionId)');
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

  it('修改要求有真实标签，知识选择向辅助技术暴露选中状态', () => {
    expect(source).toContain('htmlFor={`site-edit-instruction-${site.id}`}');
    expect(source).toContain('id={`site-edit-instruction-${site.id}`}');
    expect(source).toContain('aria-pressed={selected}');
  });
});
