/**
 * 三条「删掉不会红」的接线（predicate-and-wiring-discipline 形状 2），都是 Codex 第八轮
 * 抓出来的真缺陷。它们的共同点是：改坏之后界面照常渲染、全量测试照常绿，
 * 只有真人用起来才会发现（内容被盖、接口连发、按钮名不副实）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

describe('离线补传的写序', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const flush = source.slice(
    source.indexOf('/** 恢复联网就把队列补传上去'),
    source.indexOf('/** 冲突时用户明说「用我的版本」'),
  );

  it('补传是一整段进写链，读版本不许留在链外', () => {
    expect(flush).toContain('enqueueWrite(async () => {');
    const chainStart = flush.indexOf('enqueueWrite(async () => {');
    const readRemote = flush.indexOf('getDocumentEntry(noteIdForFlush)');
    expect(readRemote).toBeGreaterThan(chainStart);
    // 链外再读一次版本 = 那段异步窗口又开回来了
    expect(flush.slice(0, chainStart)).not.toContain('getDocumentEntry');
  });

  it('排到队时会重新确认这份草稿还没被在线保存作废', () => {
    expect(flush).toContain("pendingRef.current?.savedAt !== queued!.savedAt");
  });
});

describe('整理进度轮询', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('依赖的是 runId，不是每次响应都新建的 running 对象', () => {
    expect(source).toContain('}, [runningRunId]);');
    // 依赖对象的话，每收到一次进度就重建 effect 并立刻再发一次请求
    expect(source).not.toContain('}, [running]);');
  });

  it('进度没变就返回同一个对象，不制造无意义的新引用', () => {
    expect(source).toContain('percent === prev.percent ? prev :');
  });
});

describe('空态的「自定义」', () => {
  it('落到整理面板的自定义输入框，不是「按当前这种再跑一次」', () => {
    const karaoke = read('components/doc-browser/TranscriptKaraoke.tsx');
    expect(karaoke).toContain('setCustomRequestedAt(Date.now())');
    expect(karaoke).toContain('customRequestedAt={customRequestedAt}');
    // 这颗按钮不许再直接接 onRestyle
    expect(karaoke).not.toContain('onClick={onRestyle}\n');

    const panel = read('components/doc-browser/OrganizeStylePanel.tsx');
    expect(panel).toContain('customRequestedAt');
    expect(panel).toContain('if (customRequestedAt) setCustomOpen(true);');
  });
});

/*
 * 第九轮的三条同样是「删掉不会红」的接线：版本令牌不刷新只会表现为「偶尔多问一次冲突」，
 * 去重不同步只会表现为「偶尔多跑一条 run」，登出不清场则永远不会有任何报错。
 */
describe('离线草稿的版本令牌', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('用单独的令牌，不借用「这份整理生成于」那个展示值', () => {
    expect(source).toContain('noteRevisionRef');
    // 只看入队那一段：state.generatedAt 本身照常给面板做展示，不该被这条守卫误伤
    const queued = source.slice(source.indexOf('const queued: QueuedOfflineEdit = {'));
    const block = queued.slice(0, queued.indexOf('};'));
    expect(block).toContain('noteRevisionRef.current');
    expect(block).not.toContain('state.generatedAt');
  });

  it('在线保存成功后刷新令牌，否则自己上一次保存会被当成别人改的', () => {
    expect(source).toContain('if (res.data?.updatedAt) noteRevisionRef.current = res.data.updatedAt;');
  });
});

describe('发起整理的去重', () => {
  it('同步置位，不等两个请求回来', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    expect(source).toContain('running || launchingRef.current) return;');
    expect(source).toContain('launchingRef.current = true;');
    expect(source).toContain('launchingRef.current = false;');
  });
});

describe('登出清掉离线草稿', () => {
  it('authStore 的 logout 真的调了清场', () => {
    const source = read('stores/authStore.ts');
    expect(source).toContain('clearAllOfflineEdits()');
  });
});

/*
 * 上一轮为「轮询停不下来」加的终态清定时器，自己带出了一个回归：重新发起之后没人
 * 把观察器重起，页面永远停在旧的失败说明上（Codex 第十轮 P1）。这条钉住重启这一环。
 */
describe('处理页重新发起', () => {
  const source = read('pages/document-store/RecordingProcessingPage.tsx');

  it('重发成功后重起观察器，并撤掉旧的失败说明', () => {
    expect(source).toContain('setWatchEpoch(v => v + 1)');
    expect(source).toContain('}, [entryId, watchEpoch]);');
    const restart = source.slice(source.indexOf('onStart={entryId ?'));
    const block = restart.slice(0, restart.indexOf('} : undefined}'));
    expect(block).toContain('setFailure(null)');
    expect(block).toContain('setWatchEpoch');
  });

  it('重试按钮连点两下不并发建两条 run', () => {
    expect(source).toContain('if (restartingRef.current) return;');
    expect(source).toContain('restartingRef.current = true;');
  });
});

/*
 * 第十一轮两条：都是「写错数据」型，且都在已有代码里补齐，不新增任何面。
 */
describe('版本查不到时不写', () => {
  it('查询失败即放弃这一次补传，不落到无条件覆盖', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    const flush = source.slice(
      source.indexOf('/** 恢复联网就把队列补传上去'),
      source.indexOf('/** 冲突时用户明说「用我的版本」'),
    );
    expect(flush).toContain('if (!remote.success) return skipped;');
    // 「查到了且变过」不能再是唯一的拦截条件
    expect(flush).not.toContain('if (remote.success && hasRemoteChangedSince');
  });
});

describe('说话人草稿按行清空', () => {
  const source = read('components/doc-browser/TranscriptKaraoke.tsx');

  it('开始编辑另一行时清掉上一行填过的名字', () => {
    const open = source.slice(source.indexOf('if (documentMode && onSaveNote) {'));
    expect(open.slice(0, 400)).toContain("setAssignSpeakerDraft('')");
  });

  it('取消编辑时也清掉', () => {
    expect(source).toContain("onClick={() => { setEditingIndex(null); setAssignSpeakerDraft(''); }}");
  });
});

