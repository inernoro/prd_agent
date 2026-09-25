import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDesignArtifactLaunchPath,
  consumeLaunchRequest,
  parseDesignArtifactLaunch,
  readLaunchRequest,
  stashLaunchRequest,
} from '@/lib/designArtifactLaunch';
import { activatePptSessionContext, resolvePptSessionContext } from '../sessionContext';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');

function tabStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

/** 网页工作台点「去 PPT 智能体生成」：同一个标签页里存草稿、跳转。 */
function handOff(storage: ReturnType<typeof tabStorage>) {
  const handoffId = stashLaunchRequest('给客户讲清三季度的变化', storage, () => 'handoff00001');
  const path = buildDesignArtifactLaunchPath({
    target: 'html-ppt', sourceStoreId: 'store-a', sourceEntryId: 'entry-a', sourceTitle: '三季度复盘', handoffId,
  });
  return { key: 'navigation-a', search: path.slice(path.indexOf('?')) };
}

/** 页面挂载时怎么得到输入框初值：与 MdToPptAgentPage 同一个读法。 */
function initialInput(location: { key: string; search: string }, storage: ReturnType<typeof tabStorage>) {
  const context = resolvePptSessionContext(location, storage);
  const draft = context.launch?.handoffId ? readLaunchRequest(context.launch.handoffId, storage) : null;
  return { context, draft, input: draft?.status === 'ready' ? draft.text : '' };
}

describe('网页 PPT 交接的要求草稿：发出去之前一直在', () => {
  it('知识已带入、还没发送时刷新，要求仍预填在输入框里', () => {
    const storage = tabStorage();
    const location = handOff(storage);
    const first = initialInput(location, storage);
    expect(first.input).toBe('给客户讲清三季度的变化');

    // 知识带入完成：页面把 launchImported=true 落进会话；此时用户还没点发送。
    activatePptSessionContext(first.context, storage);
    storage.setItem(first.context.sessionKey, JSON.stringify({ messages: [], launchImported: true }));

    // 刷新（同一个 history entry）或从别处返回。
    const reloaded = initialInput(location, storage);
    expect(reloaded.context.id).toBe(first.context.id);
    expect(reloaded.input).toBe('给客户讲清三季度的变化');
  });

  it('发送之后标记已用：再刷新不回填，也不误报「没带过来」', () => {
    const storage = tabStorage();
    const location = handOff(storage);
    const { context } = initialInput(location, storage);
    consumeLaunchRequest(context.launch!.handoffId!, storage);
    const after = initialInput(location, storage);
    expect(after.input).toBe('');
    expect(after.draft).toEqual({ status: 'consumed' });
  });

  it('换了标签页打开（读不到草稿）时明确标成 missing，页面据此提示重新输入', () => {
    const location = handOff(tabStorage());
    const otherTab = initialInput(location, tabStorage());
    expect(parseDesignArtifactLaunch(location.search)?.handoffId).toBe('handoff00001');
    expect(otherTab.draft).toEqual({ status: 'missing' });
    expect(otherTab.input).toBe('');
  });

  it('页面接线：初值只看交接草稿、不看 launchImported；发送通过拦截后才标记已用；读不到有提示', () => {
    expect(source).toContain('readLaunchRequest(context.launch.handoffId, sessionStorageOrNull())');
    expect(source).toContain("useState(() => (handoffDraft?.status === 'ready' ? handoffDraft.text : ''))");
    const handler = source.slice(source.indexOf('const handleSend ='), source.indexOf('const handlePublish ='));
    const guard = handler.indexOf('if (!text || isProcessing || launchImportBlocked) return;');
    const consume = handler.indexOf('consumeLaunchRequest(context.launch.handoffId');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(consume).toBeGreaterThan(guard);
    expect(source).toContain('data-testid="launch-request-lost"');
    expect(source).toContain("handoffDraft?.status === 'missing'");
  });
});
