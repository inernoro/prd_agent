import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDesignArtifactLaunchPath, stashLaunchRequest } from '@/lib/designArtifactLaunch';
import {
  buildPptPublishRequest,
  markLaunchDraftSent,
  publishDestinationLabel,
  resolveLaunchDraft,
} from '../launchHandoff';
import { activatePptSessionContext, resolvePptSessionContext } from '../sessionContext';

function tabStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

/** 网页工作台点「去 PPT 智能体生成」：同一个标签页里存草稿、跳转。 */
function handOff(storage: ReturnType<typeof tabStorage>, destinationTeamId?: string) {
  const handoffId = stashLaunchRequest('给客户讲清三季度的变化', storage, () => 'handoff00001');
  const path = buildDesignArtifactLaunchPath({
    target: 'html-ppt',
    sourceStoreId: 'store-a',
    sourceEntryId: 'entry-a',
    sourceTitle: '三季度复盘',
    handoffId,
    destinationTeamId,
  });
  return { key: 'navigation-a', search: path.slice(path.indexOf('?')) };
}

/** 一次页面挂载（首开、刷新、返回都是这一步）。 */
function mount(location: { key: string; search: string }, storage: ReturnType<typeof tabStorage>) {
  const context = resolvePptSessionContext(location, storage);
  return { context, draft: resolveLaunchDraft(context.launch, storage) };
}

describe('网页 PPT 交接的要求草稿：发出去之前一直在', () => {
  it('知识已带入、还没发送时刷新，要求仍预填在输入框里', () => {
    const storage = tabStorage();
    const location = handOff(storage);
    const first = mount(location, storage);
    expect(first.draft).toEqual({ input: '给客户讲清三季度的变化', notice: null });

    // 知识带入完成：页面把 launchImported=true 落进会话；此时用户还没点发送。
    activatePptSessionContext(first.context, storage);
    storage.setItem(first.context.sessionKey, JSON.stringify({ messages: [], launchImported: true }));

    const reloaded = mount(location, storage);
    expect(reloaded.context.id).toBe(first.context.id);
    expect(reloaded.draft).toEqual({ input: '给客户讲清三季度的变化', notice: null });
  });

  it('发送之后再刷新：不回填，也不误报「没带过来」', () => {
    const storage = tabStorage();
    const location = handOff(storage);
    const { context } = mount(location, storage);
    markLaunchDraftSent(context.launch, storage);
    expect(mount(location, storage).draft).toEqual({ input: '', notice: null });
  });

  it('换了标签页打开（读不到草稿）时给出提示，输入框留空', () => {
    const location = handOff(tabStorage());
    expect(mount(location, tabStorage()).draft).toEqual({ input: '', notice: 'request-lost' });
  });

  it('普通进入（不是交接）既不预填也不提示', () => {
    expect(resolveLaunchDraft(null, tabStorage())).toEqual({ input: '', notice: null });
  });
});

describe('网页 PPT 的发布落点', () => {
  it('团队空间发起的交接，刷新后仍记得团队，发布请求带上 teamIds', () => {
    const storage = tabStorage();
    const location = handOff(storage, 'team-7f3a');
    const { context } = mount(location, storage);
    expect(context.launch?.destinationTeamId).toBe('team-7f3a');
    expect(buildPptPublishRequest({
      htmlContent: '<section>1</section>', title: '三季度复盘', runId: 'run-1',
      destinationTeamId: context.launch?.destinationTeamId,
    })).toEqual({ htmlContent: '<section>1</section>', title: '三季度复盘', runId: 'run-1', teamIds: ['team-7f3a'] });
  });

  it('个人空间发起时发布请求不带 teamIds', () => {
    const request = buildPptPublishRequest({ htmlContent: 'x', title: 't', runId: 'r', destinationTeamId: null });
    expect(request).not.toHaveProperty('teamIds');
  });

  it('发布前的落点说明：有团队名用团队名，拿不到退回编号，个人空间不显示', () => {
    expect(publishDestinationLabel('team-7f3a', '增长组')).toBe('发布到：增长组 空间');
    expect(publishDestinationLabel('team-7f3a-0000-1111', null)).toBe('发布到：团队空间（编号 team-7f3）');
    expect(publishDestinationLabel(undefined, '增长组')).toBeNull();
  });
});

/** 唯一一条接线守卫：页面确实用这几个判定函数，而不是自己另写一份。 */
describe('页面接线', () => {
  it('MdToPptAgentPage 调用交接判定函数', () => {
    const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
    for (const symbol of ['resolveLaunchDraft(', 'markLaunchDraftSent(', 'buildPptPublishRequest(', 'publishDestinationLabel(']) {
      expect(source, `页面没有调用 ${symbol}`).toContain(symbol);
    }
  });
});
