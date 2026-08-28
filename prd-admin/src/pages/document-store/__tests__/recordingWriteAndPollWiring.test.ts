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

  /*
   * 重新拉笔记也要刷令牌：整理重跑、丢弃草稿之后服务端那份已经换了新时刻，
   * 令牌不跟着走，用户下一次断网校对就带着过期基线，重连时被判成「云端有更新」——
   * 一条假的冲突横幅。删掉这一行不会有任何测试变红，所以要这条守卫
   * （Codex 第十八轮 P2）。
   */
  /*
   * 三条「认笔记」的门都守同一件事：await 回来时用户可能已经切到 B，
   * 这时候还去改这一屏的共享状态（令牌 / 待同步 / 冲突横幅）就是把 A 的结果写进 B。
   * 删掉任何一道门都不会有测试变红——切条目要真人操作才能撞上。
   */
  it('在线保存回来后先认笔记，再动这一屏的共享状态', () => {
    const fn = source.slice(source.indexOf('const onSaveNote = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [enqueueWrite'));
    expect(body.length).toBeGreaterThan(400);
    const gate = body.indexOf('noteIdRef.current !== savingNoteId');
    expect(gate).toBeGreaterThan(0);
    // 令牌与三处清场都必须排在这道门之后
    for (const after of ['noteRevisionRef.current = res.data.updatedAt', 'setFlushConflict(null)']) {
      expect(body.indexOf(after)).toBeGreaterThan(gate);
    }
  });

  it('用户明说覆盖之后也刷令牌', () => {
    const fn = source.slice(source.indexOf('const overwriteWithOfflineDraft = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [enqueueWrite'));
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('noteRevisionRef.current = res.data.updatedAt');
  });

  it('重新拉回笔记之后也刷令牌', () => {
    const body = source.slice(source.indexOf('const reloadNote = useCallback'));
    const scope = body.slice(0, body.indexOf('}, [entryId]);'));
    expect(scope.length).toBeGreaterThan(200);
    expect(scope).toMatch(/noteRevisionRef\.current = noteEntryRes\.data\.updatedAt/);
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

/*
 * 第十二轮三条 P1，都是「A 的正文落到 B 头上 / 草稿与屏幕不一致」这一族：
 * 界面照常渲染、测试照常绿，只有真人切换录音或断网重开才会撞上。
 */
describe('异步完成认笔记', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('reloadNote 回来时先认「还在不在当初那条笔记上」', () => {
    // 认「切走了就不落地」这件事，不认它 return 的是 void 还是 false
    expect(source).toMatch(/if \(noteIdRef\.current !== noteId\) return( false)?;/);
    expect(source).toContain("cur.kind === 'ready' && cur.noteId === noteId");
  });

  it('在线保存落地时认这次保存写的那条笔记', () => {
    expect(source).toContain('const savingNoteId = state.noteId;');
    expect(source).toContain("prev.noteId === savingNoteId");
  });
});

describe('离线草稿与屏幕一致', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('接回队列时把草稿正文也装回编辑器', () => {
    const restore = source.slice(source.indexOf('const restored = loadOfflineEdit('));
    expect(restore.slice(0, 700)).toContain('noteMd: restored.content');
  });

  it('丢弃草稿是「先装上远端正文，装上了才删」，不是发出去就不管', () => {
    const discard = source.slice(source.indexOf('if (!noteIdForFlush) return;'));
    const block = discard.slice(0, 1600);
    // 必须等它回来并看结果——fire-and-forget 会在拉取失败时把草稿删了却留着旧内容在屏上
    expect(block).toContain('const installed = await reloadNote();');
    expect(block).toContain('if (!installed)');
    // 清草稿必须排在装上之后
    expect(block.indexOf('const installed = await reloadNote();'))
      .toBeLessThan(block.indexOf('clearOfflineEdit(noteIdForFlush, ownerId);'));
    expect(block).not.toContain('void reloadNote();');
  });

  it('reloadNote 汇报正文到底装上了没有，不是只返回 void', () => {
    expect(source).toContain('const reloadNote = useCallback(async (): Promise<boolean> => {');
    expect(source).toContain("return contentRes.success && typeof contentRes.data?.content === 'string';");
  });
});

describe('发起整理也要认笔记', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('两个请求回来后先认「还是当初那条录音吗」，不是就丢弃', () => {
    expect(source).toContain('const launchedForEntryId = entryId;');
    expect(source).toContain('if (entryIdRef.current !== launchedForEntryId) return;');
    const launch = source.slice(source.indexOf('const launchedForEntryId = entryId;'));
    // 认人必须排在 setRunning 之前
    expect(launch.indexOf('if (entryIdRef.current !== launchedForEntryId) return;'))
      .toBeLessThan(launch.indexOf('setRunning({ runId: res.data.runId'));
  });
});

describe('冲突覆盖也要认笔记', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('PUT 回来后先认笔记，切走了就不动这一屏的状态', () => {
    const block = source.slice(source.indexOf('const overwriteWithOfflineDraft'));
    const body = block.slice(0, block.indexOf('}, [enqueueWrite'));
    expect(body).toContain('const overwritingNoteId = noteIdForFlush;');
    expect(body).toContain('if (noteIdRef.current !== overwritingNoteId) return;');
    // 认人必须排在几处状态清理之前
    expect(body.indexOf('if (noteIdRef.current !== overwritingNoteId) return;'))
      .toBeLessThan(body.indexOf('setPendingEdits(null);'));
    // 本机草稿按写入的那条笔记清，与现在停在哪一屏无关
    expect(body.indexOf('clearOfflineEdit(overwritingNoteId, ownerId);'))
      .toBeLessThan(body.indexOf('if (noteIdRef.current !== overwritingNoteId) return;'));
    expect(body).toContain("prev.noteId === overwritingNoteId");
  });
});

describe('发起整理的前置查询失败时不许退回全量重转', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('查失败当场停下，不把失败当成「没有可复用的转录」', () => {
    const launch = source.slice(source.indexOf('const launchedForEntryId = entryId;'));
    const body = launch.slice(0, launch.indexOf('launchingRef.current = false;'));
    expect(body).toContain('if (!prior.success) {');
    // 只有查成功才允许取 id，再据此决定走 restyle 还是全量
    expect(body).toContain('const priorRunId = prior.data?.id ?? \'\';');
    expect(body).not.toContain("prior.success ? (prior.data?.id ?? '') : ''");
    expect(body.indexOf('if (!prior.success) {')).toBeLessThan(body.indexOf('transcribeEntry(entryId, style)'));
  });

  it('默认整理方式用共享常量，不就地写死', () => {
    expect(source).toContain('onPickOrganizeStyle(state.styleKey || DEFAULT_ORGANIZE_STYLE_KEY)');
    expect(source).not.toContain("state.styleKey || 'general'");
  });
});

describe('库归属以条目为准', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('加载时用条目自己的 storeId 取库，不用路由参数', () => {
    expect(source).toContain('const owningStoreId = entry.storeId || storeId;');
    expect(source).toContain('getDocumentStoreReal(owningStoreId)');
  });

  it('侧栏与导航都读真实归属库', () => {
    expect(source).toContain("const activeStoreId = state.kind === 'ready' ? state.storeId : (storeId ?? '');");
    expect(source).toContain('listDocumentEntriesReal(activeStoreId)');
    expect(source).toContain('`/document-store/${activeStoreId}/recording/${item.id}`');
    expect(source).toContain('`/document-store?store=${activeStoreId}&record=1`');
  });
});

/*
 * 停止看护（stalled / 查不到 / 权限没了）与走到终态是两条不同的分支，但都必须
 * 把这条 run 从进度位上摘掉。退役那一路漏摘的话，状态卡照旧按「处理中」渲染，
 * 进度冻在最后一个百分比，把同一时刻刚设出来的失败卡与重试按钮压住不显示——
 * 界面上是一条永远走不完的进度，用户连重试入口都看不见（Codex 第十九轮 P1）。
 */
describe('停止看护时把进度位一起腾出来', () => {
  const source = read('pages/document-store/DocumentStorePage.tsx');

  it('退役分支与终态分支都清 activeTranscribeRun', () => {
    const retire = source.indexOf("if (decision.kind === 'retire-watcher')");
    expect(retire).toBeGreaterThan(0);
    const branch = source.slice(retire, source.indexOf('const observedRun = decision.run;', retire));
    expect(branch.length).toBeGreaterThan(400);
    expect(branch).toMatch(/setActiveTranscribeRun\(current => \(current\?\.id === runId \? null : current\)\)/);
  });
});

/*
 * 处理页两秒一发地问「这条转录跑到哪了」。查询慢于间隔时两发会重叠：后发的那份是终态、
 * 清掉了定时器，先发的那份随后落地又把 run 写回在途——此后再没有下一次轮询，
 * 这一屏永远停在一个走不完的进度上。判据认「回来时只认最新那一发」这件事本身。
 */
describe('处理页的轮询丢弃过期回包', () => {
  const source = read('pages/document-store/RecordingProcessingPage.tsx');

  it('每一发带序号，回来时先认序号再动状态', () => {
    const fn = source.slice(source.indexOf('const tick = async () => {'));
    const body = fn.slice(0, fn.indexOf('void tick();'));
    expect(body.length).toBeGreaterThan(200);
    const stamp = body.indexOf('++seq');
    const gate = body.indexOf('!== seq');
    const write = body.indexOf('setRun(');
    expect(stamp).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(stamp);
    expect(write).toBeGreaterThan(gate);
  });
});
