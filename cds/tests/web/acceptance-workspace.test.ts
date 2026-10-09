import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acceptanceReportLink, acceptanceTaskLink, acceptanceView, archiveAcceptanceReport, bindAcceptanceReport,
  claimAcceptanceTask, createAcceptanceTask, heartbeatAcceptanceTask, onlineEvidenceUrl,
  latestAcceptanceTemplates, publishAcceptanceTemplate, submitAcceptanceResult,
} from '../../web/src/lib/acceptance-api';
import type { AcceptanceReportDraft, AcceptanceTask, AcceptanceTemplate } from '../../web/src/lib/acceptance-api';
import { AcceptanceTemplateEditor, newAcceptanceCase } from '../../web/src/pages/reports/AcceptanceTemplateEditor';
import { AcceptanceResultEditor, acceptanceSubmissionProblem, initialAcceptanceSubmission, preparedAcceptanceSubmission } from '../../web/src/pages/reports/AcceptanceResultEditor';
import { AcceptanceNavigation, AcceptanceSummaryCard } from '../../web/src/pages/reports/AcceptanceWorkspace';
import { AcceptanceChecklist } from '../../web/src/pages/reports/AcceptanceChecklist';

const testCase = {
  ...newAcceptanceCase(0), title: '默认模型文字生图', module: '视觉创作', owner: '视觉负责人',
  breadcrumb: ['首页', '视觉创作'], entryPath: '/visual-agent',
  steps: [{ id: 'step-1', action: '保持默认模型，输入白桃生成', expected: '可下载的1024×1024图片' }],
  assertions: [{ id: 'assert-1', description: '图片可下载、可解码且尺寸正确' }], cleanupInstructions: '删除本轮资源并回读无残留',
};
const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(createElement(StaticRouter, { location: '/reports' }, element));
const pageSource = readFileSync(resolve(__dirname, '../../web/src/pages/ReportsPage.tsx'), 'utf8');
const workspaceSource = readFileSync(resolve(__dirname, '../../web/src/pages/reports/AcceptanceWorkspace.tsx'), 'utf8');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('结构化清单和逐项回填，非 JSON 粘贴框', () => {
  it('人和 Agent 使用同一张评分表，执行细节折叠且不派生第二套用例', () => {
    const detailedCase = { ...testCase, steps: [...testCase.steps, { id: 'step-2', action: '下载图片并解码', expected: '宽高均为1024' }], assertions: [...testCase.assertions, { id: 'assert-2', description: '删除资源后回读无残留' }] };
    const html = render(createElement(AcceptanceChecklist, { cases: [detailedCase] }));
    for (const label of ['编号', '重要功能', '怎么验／通过标准', '本轮结果', '证据', detailedCase.caseId, detailedCase.title, '下载图片并解码', '宽高均为1024', detailedCase.assertions[0].description]) expect(html).toContain(label);
    expect(html).toContain('模板，尚未执行');
    expect(html).toMatch(/<details[^>]*><summary/);
    expect(html).not.toMatch(/<details[^>]*\bopen/);
    expect(html).toContain('另 1 步，展开查看');
    expect(html).toContain('另 1 项标准，展开查看');
    expect(html.split('下载图片并解码')).toHaveLength(2);
    expect(html.split('删除资源后回读无残留')).toHaveLength(2);
    expect(workspaceSource.includes('<AcceptanceChecklist cases={template.cases}')).toBe(true);
    expect(workspaceSource.includes('<AcceptanceChecklist cases={task.cases}')).toBe(true);
  });

  it('评分表直接回读服务端结果、保留 flaky，并链接到原任务的原编号', () => {
    const draft = initialAcceptanceSubmission(testCase);
    const saved = { ...draft, caseId: testCase.caseId, status: 'pass' as const, actual: '可下载解码，1024×1024', evidence: [{ kind: 'image' as const, url: 'https://cdn.example.test/peach.png', caption: '本轮白桃产物' }], flaky: true, submittedAt: '2026-10-09T00:00:00Z', attempts: [] };
    const html = render(createElement(AcceptanceChecklist, { cases: [testCase], results: { [testCase.caseId]: saved }, projectId: 'p', taskId: 'original-task' }));
    expect(html).toContain('通过'); expect(html).toContain('不稳定'); expect(html).toContain(saved.actual);
    expect(html).toContain('href="https://cdn.example.test/peach.png"');
    expect(html).toContain(`href="${acceptanceTaskLink('p', 'original-task', testCase.caseId).replaceAll('&', '&amp;')}"`);
    const missing = render(createElement(AcceptanceChecklist, { cases: [testCase], results: {} }));
    expect(missing).toContain('未执行'); expect(missing).toContain('未提供证据'); expect(missing).not.toContain('模板，尚未执行');
  });
  it('v1/v2 历史按身份去重且始终选择 v2，不依赖服务端返回顺序', () => {
    const v1: AcceptanceTemplate = { id: 'tpl1', projectId: 'p', title: '旧标准', description: '', version: 1, cases: [testCase], createdAt: '2026-10-01T00:00:00Z' };
    const v2 = { ...v1, version: 2, title: '新标准' };
    const another = { ...v1, id: 'tpl2' };
    for (const versions of [[v1, another, v2], [v2, another, v1]]) {
      const latest = latestAcceptanceTemplates(versions);
      expect(latest).toHaveLength(2);
      expect(latest.find((template) => template.id === 'tpl1')).toBe(v2);
      expect(new Set(latest.map((template) => template.id)).size).toBe(2);
    }
    expect(workspaceSource).toContain('const latestTemplates = latestAcceptanceTemplates(nextTemplates)');
    expect(workspaceSource).toContain('setTemplates(latestTemplates)');
    expect(workspaceSource).toContain('templateVersion: selectedTemplate?.version');
  });
  it('编辑器真实渲染功能字段、重复步骤和通过断言', () => {
    const html = render(createElement(AcceptanceTemplateEditor, { busy: false, onCancel: () => {}, onPublish: async () => {} }));
    for (const label of ['重要功能', '用例编号 caseId', '所属模块', '负责人', '业务面包屑', '前置条件', '固定输入', '添加输入', '添加步骤', '添加断言', '清理操作与回读标准', '发布清单版本']) expect(html).toContain(label);
    expect(html).not.toContain('粘贴 JSON');
    expect(html).toContain('value="production"');
  });

  it('保存结果时缺断言、线上证据或清理回读不能宣称通过', () => {
    const draft = initialAcceptanceSubmission(testCase);
    draft.status = 'pass'; draft.actual = '图片生成成功';
    expect(acceptanceSubmissionProblem(testCase, draft)).toContain('逐条');
    draft.assertions = [{ id: 'assert-1', passed: true, actual: '可下载解码，1024×1024' }];
    expect(acceptanceSubmissionProblem(testCase, draft)).toContain('缺少证据');
    draft.evidence = [{ kind: 'image', url: 'https://evidence.example.test/peach.png', caption: '生成产物与尺寸' }];
    expect(acceptanceSubmissionProblem(testCase, draft)).toContain('清理');
    draft.cleanup = { status: 'pass', details: '回读资源为空' };
    expect(acceptanceSubmissionProblem(testCase, draft)).toBeUndefined();
  });

  it('本机与可执行链接不作为证据，既有结果可恢复逐项断言', () => {
    for (const url of ['file:///tmp/evidence.png', '/tmp/evidence.png', 'javascript:alert(1)', 'data:image/png,x', 'http://localhost:5173/image', 'https://user:secret@example.test/image']) expect(onlineEvidenceUrl(url)).toBeUndefined();
    expect(onlineEvidenceUrl('https://cdn.example.test/image.png')).toBe('https://cdn.example.test/image.png');
    const result = { ...initialAcceptanceSubmission(testCase), caseId: testCase.caseId, attempts: [], flaky: false, submittedAt: '2026-10-02T00:00:00Z' };
    result.assertions = [{ id: 'assert-1', passed: true, actual: '产物已解码' }];
    expect(initialAcceptanceSubmission(testCase, result).assertions[0]).toEqual(result.assertions[0]);
    const html = render(createElement(AcceptanceResultEditor, { testCase, result, writable: false, busy: false, onSave: async () => {} }));
    expect(html).toContain('只读查看'); expect(html).toContain('产物已解码'); expect(html).toContain('线上证据');
  });

  it('阻塞或未执行不强迫伪造断言，但必须说明未清理原因', () => {
    const draft = initialAcceptanceSubmission(testCase);
    draft.status = 'blocked'; draft.actual = '模型额度不可用，尚未发起任务';
    expect(acceptanceSubmissionProblem(testCase, draft)).toContain('未执行或未清理');
    draft.cleanup.details = '尚未创建测试资源，无资源可清理';
    expect(acceptanceSubmissionProblem(testCase, draft)).toBeUndefined();
    expect(preparedAcceptanceSubmission(draft).assertions).toEqual([]);
    draft.assertions[0].actual = '调用因额度阻塞，断言未执行';
    expect(preparedAcceptanceSubmission(draft).assertions).toHaveLength(1);
  });

  it('清理字段一旦声称已执行就须有实际说明；无清理模板也不能带清理失败判通过', () => {
    const noCleanupCase = { ...testCase, cleanup: 'none' as const, evidenceRequired: false };
    const draft = initialAcceptanceSubmission(noCleanupCase);
    draft.actual = '流程被依赖阻塞'; draft.cleanup = { status: 'fail', details: '' };
    expect(acceptanceSubmissionProblem(noCleanupCase, draft)).toContain('清理实际结果');
    draft.status = 'pass'; draft.assertions = [{ id: 'assert-1', passed: true, actual: '已回读' }]; draft.cleanup.details = '资源清理失败';
    expect(acceptanceSubmissionProblem(noCleanupCase, draft)).toContain('清理未通过');
  });
});

describe('验收中心接线和结论语义', () => {
  it('现有 reports shell 内导航四视图且 report 深链仍优先', () => {
    const html = render(createElement(AcceptanceNavigation, { view: 'templates', onChange: () => {} }));
    for (const label of ['测试清单', '执行任务', '历史矩阵', '验收报告']) expect(html).toContain(label);
    expect(pageSource).toContain('<AcceptanceNavigation'); expect(pageSource).toContain('<AcceptanceWorkspace');
    expect(pageSource).toContain('getReport(reportParam)');
    expect(pageSource).toContain('centerView === \'reports\' && state.status === \'ok\' && selected');
    expect(acceptanceView('tasks', 'report-1')).toBe('reports');
    expect(acceptanceView('tasks')).toBe('tasks');
    expect(acceptanceView('unknown')).toBe('reports');
  });

  it('深链携带项目/任务/case，矩阵格子直达实际执行项', () => {
    const taskLink = new URL(acceptanceTaskLink('p', 'task/1', 'VIS-001'), 'https://cds.example.test');
    expect(taskLink.pathname).toBe('/reports'); expect(taskLink.searchParams.get('case')).toBe('VIS-001');
    expect(taskLink.searchParams.get('task')).toBe('task/1');
    const reportLink = new URL(acceptanceReportLink('p', 'r1'), 'https://cds.example.test');
    expect(reportLink.searchParams.get('report')).toBe('r1');
    expect(workspaceSource).toContain('acceptanceTaskLink(projectId, task.id, row.caseId)');
    expect(workspaceSource).toContain('key={`${row.templateId}:${row.caseId}`}');
    expect(workspaceSource).toContain('cell?.applicable');
    expect(workspaceSource).toContain('不在本轮范围'); expect(workspaceSource).toContain('max-w-full overflow-x-auto');
  });

  it('执行结束不冒充业务通过，服务端 summary 不由前端计算', () => {
    const task = { title: '第二轮巡检', status: 'completed', environment: 'production', templateVersion: 1,
      summary: { planned: 4, executed: 3, pass: 2, fail: 1, blocked: 0, notRun: 1, flaky: 1, gate: 'fail' } } as AcceptanceTask;
    const html = render(createElement(AcceptanceSummaryCard, { task }));
    expect(html).toContain('执行结束'); expect(html).toContain('业务门禁：未通过'); expect(html).toContain('未执行 1');
    expect(html).toContain('报告未完成'); expect(html).toContain('不替代线上报告归档与 verify-open');
  });

  it('租约仅内存，心跳和离开时释放，归档失败保留已创建ID重试bind', () => {
    expect(workspaceSource).not.toMatch(/(?:localStorage|sessionStorage)\./);
    expect(workspaceSource).toContain('heartbeatAcceptanceTask(lease.taskId, lease.token)');
    expect(workspaceSource).toContain('releaseAcceptanceTask(lease.taskId, lease.token)');
    expect(workspaceSource).toContain('pendingReportId || task.report?.id');
    expect(workspaceSource).toContain('线上打开待验证');
  });
});

describe('真实 API 指令契约', () => {
  function capture(response: unknown = { task: { id: 'task1' }, template: { id: 'template1' }, report: { id: 'report1' }, leaseToken: 'test-lease' }) {
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('发布 revision 带乐观锁且不双重 JSON 编码；生产创建没有发布前置', async () => {
    const fetchMock = capture();
    await publishAcceptanceTemplate({ projectId: 'p', title: '核心功能', description: '', cases: [testCase], templateId: 'template1', expectedVersion: 2 });
    const publication = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(publication.expectedVersion).toBe(2); expect(publication.cases[0].steps[0].action).toContain('白桃');
    await createAcceptanceTask({ projectId: 'p', templateId: 'template1', environment: 'production' });
    const taskBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(taskBody).toEqual({ projectId: 'p', templateId: 'template1', environment: 'production' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/acceptance/tasks');
  });

  it('领取、心跳、逐项结果通过真实 POST 且携带租约与幂等submission', async () => {
    const fetchMock = capture();
    await claimAcceptanceTask('task1', '巡检 Agent'); await heartbeatAcceptanceTask('task1', 'test-lease');
    await submitAcceptanceResult('task1', 'VIS-001', { ...initialAcceptanceSubmission(testCase), leaseToken: 'test-lease', submissionId: 'submission-1' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/api/acceptance/tasks/task1/claim', '/api/acceptance/tasks/task1/heartbeat', '/api/acceptance/tasks/task1/results/VIS-001']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ leaseToken: 'test-lease' });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string).submissionId).toBe('submission-1');
    expect(fetchMock.mock.calls.every((call) => call[1].method === 'POST')).toBe(true);
  });

  it('同一模板的 v1/v2 只选最高版本，创建任务明确绑定 v2 快照', async () => {
    const fetchMock = capture();
    const v1: AcceptanceTemplate = { id: 'tpl1', projectId: 'p', title: '核心功能', description: '', version: 1, cases: [testCase], createdAt: '2026-10-01T00:00:00Z' };
    const selected = latestAcceptanceTemplates([v1, { ...v1, version: 2 }]).find((template) => template.id === 'tpl1')!;
    await createAcceptanceTask({ projectId: 'p', templateId: selected.id, templateVersion: selected.version, environment: 'production' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ projectId: 'p', templateId: 'tpl1', templateVersion: 2, environment: 'production' });
  });

  it('报告走既有归档准入、携带来源，随后bind，不宣称verify通过', async () => {
    const fetchMock = capture();
    const draft: AcceptanceReportDraft = { title: '功能验收：本轮', format: 'md', content: '# 本轮结果', sourceId: 'task1', verdict: 'fail', defectCounts: { p0: 1, p1: 0 }, evidence: [], verification: 'pending' };
    const report = await archiveAcceptanceReport('p', draft); await bindAcceptanceReport('task1', report.id);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/reports');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ sourceId: 'task1', projectId: 'p', folderPath: '核心功能巡检', verdict: 'fail', format: 'md' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ reportId: 'report1' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/acceptance/tasks/task1/bind-report');
  });
});
