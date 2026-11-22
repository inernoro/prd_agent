import assert from 'node:assert/strict';
import { FIXTURE_PROJECT_ID, isEventStream, resolveFixture } from './fixtures/mobile-layout-fixtures.mjs';

export async function verifyEngineeringPlanningApproval(browser, base) {
  const origin = new URL(base).origin;
  assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), '合成验收仅使用本机');
  const projectId = FIXTURE_PROJECT_ID;
  const boardPath = `/api/projects/${projectId}/planning`;
  const commandPath = `${boardPath}/commands`;
  const apiPath = url => new URL(url).pathname.replace(/^\/_cds/, '');
  const reviewer = { kind: 'human', id: 'fixture-owner', label: '合成验收账号' };
  const author = { kind: 'agent', id: 'fixture-planner', label: '合成规划技能' };
  const draft = { title: '合成独立落地计划', summary: '分阶段核对合成工作流的完成结果。' };
  const source = { type: 'test', ref: 'fixture-plan-without-decision' };
  const createdAt = '2026-11-20T01:00:00Z';
  const acceptedAt = '2026-11-20T02:00:00Z';
  const proposal = {
    id: 'fixture-independent-plan-proposal', projectId, draft, source, author,
    kind: 'plan', status: 'pending', version: 1, createdAt, updatedAt: createdAt,
  };
  const plan = {
    ...draft, id: 'fixture-independent-plan', projectId, source, steps: [],
    version: 1, createdAt: acceptedAt, updatedAt: acceptedAt,
  };
  const finishedPlan = {
    ...plan, id: 'fixture-completed-independent-plan', title: '合成已完成独立计划', createdAt, updatedAt: createdAt,
    steps: [{ id: 'fixture-completed-step', kind: 'task', title: '核对合成结果', status: 'done' }],
  };
  const acceptedProposal = {
    ...proposal, status: 'accepted', version: 2, updatedAt: acceptedAt, handledBy: reviewer,
    result: { kind: 'plan', id: plan.id },
  };
  let accepted = false;
  let writes = 0;
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  try {
    await context.route('**/*', async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin) return route.abort();
      const pathname = apiPath(request.url());
      if (!pathname.startsWith('/api/')) return route.continue();
      if (isEventStream(pathname) || pathname === '/api/activity-stream') {
        return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      }
      if (pathname === '/api/auth/status') return route.fulfill({ json: {
        authenticated: true, enabled: true, mode: 'basic',
        user: { ...reviewer, name: reviewer.label, isSystemOwner: true },
      } });
      if (pathname === boardPath && request.method() === 'GET') return route.fulfill({ json: {
        ...resolveFixture(boardPath), permissions: ['read', 'write', 'approve'],
        proposals: [accepted ? acceptedProposal : proposal], plans: accepted ? [plan, finishedPlan] : [finishedPlan],
      } });
      if (pathname === commandPath && request.method() === 'POST') {
        writes++;
        const input = request.postDataJSON();
        if (accepted || input.type !== 'proposal.accept' || input.proposalId !== proposal.id || !input.requestId) {
          return route.fulfill({ status: 400, json: { error: 'unexpected_fixture_command' } });
        }
        accepted = true;
        return route.fulfill({ status: 201, json: { projectId, result: acceptedProposal, reused: false } });
      }
      return route.fulfill({ json: resolveFixture(pathname) ?? {} });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(`${origin}/project-list`);
    await page.getByRole('link', { name: '工程规划', exact: true }).click();
    const pending = page.getByRole('region', { name: '待你确认', exact: true });
    const heading = pending.getByRole('heading', { name: draft.title, exact: true });
    await heading.waitFor();
    const [receipt, board] = await Promise.all([
      page.waitForResponse(response => apiPath(response.url()) === commandPath && response.request().method() === 'POST'),
      page.waitForResponse(response => apiPath(response.url()) === boardPath && response.request().method() === 'GET'),
      pending.getByRole('button', { name: '采纳为落地计划', exact: true }).click(),
    ]);
    assert.equal(receipt.status(), 201);
    assert.deepEqual((await receipt.json()).result.result, { kind: 'plan', id: plan.id });
    assert.deepEqual((await board.json()).plans, [plan, finishedPlan], '确认后刷新看板并取回新计划');
    const notice = page.getByRole('status').filter({ hasText: '提案已确认' });
    await notice.waitFor();
    await heading.waitFor({ state: 'hidden' });
    const moving = page.getByRole('region', { name: '推进中', exact: true });
    const openPlan = moving.getByRole('button', { name: draft.title, exact: true });
    assert(await openPlan.isVisible(), '确认后「推进中」缺少未关联决策的落地计划');
    await openPlan.click();
    const detail = page.getByRole('dialog', { name: draft.title, exact: true });
    const checkOriginalContent = async () => {
      await detail.getByRole('heading', { name: draft.title, exact: true }).waitFor();
      await detail.getByText(draft.summary, { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('item'), plan.id);
    };
    await checkOriginalContent();
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    await notice.getByRole('button', { name: '查看落地计划', exact: true }).click();
    await checkOriginalContent();
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    await detail.waitFor({ state: 'hidden' });
    const done = page.getByRole('region', { name: '已完结', exact: true });
    assert(await done.getByRole('button', { name: finishedPlan.title, exact: true }).isVisible());
    assert.equal(await moving.getByRole('button', { name: finishedPlan.title, exact: true }).count(), 0);
    assert.equal(writes, 1, '打开已确认计划只读取详情');
    return { confirmedProposal: true, visibleInProgress: true, boardAndNoticeOpenOriginalContent: true, completedInDone: true };
  } finally {
    await context.close();
  }
}
