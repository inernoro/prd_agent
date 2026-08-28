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

  /*
   * 判据认「依赖里有 runId、没有 running 这个对象」，不逐字钉整个依赖数组：
   * 这个 effect 后来还要加别的依赖（比如判账号的 ownerId），钉死会让正确实现误红。
   */
  it('依赖的是 runId，不是每次响应都新建的 running 对象', () => {
    const at = source.indexOf('const tick = async () => {\n      const res = await getAgentRun(runningRunId);');
    expect(at, '找不到整理进度轮询').toBeGreaterThan(-1);
    const deps = source.slice(source.indexOf('}, [', at), source.indexOf(');', source.indexOf('}, [', at)) + 2);
    expect(deps).toContain('runningRunId');
    // 依赖对象的话，每收到一次进度就重建 effect 并立刻再发一次请求
    expect(deps).not.toMatch(/[[,]\s*running\s*[,\]]/);
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
  /*
   * 判据认「同步置位」这件事本身，不认锁长什么样：它从布尔换成「哪条录音 + 这一发」之后，
   * 原来那三条逐字断言全部误红，而行为一点没坏（对抗审查点名的形状 4a）。
   */
  it('置位发生在任何 await 之前，不等两个请求回来', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    const fn = source.slice(source.indexOf('const onPickOrganizeStyle = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [entryId, running]);'));
    expect(body.length).toBeGreaterThan(200);
    const guard = body.search(/if \([^)]*running[^)]*\) return;/);
    const acquire = body.search(/launching\w*Ref\.current = /);
    const firstAwait = body.indexOf('await ');
    expect(guard).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(guard);
    expect(firstAwait).toBeGreaterThan(acquire);
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

  /*
   * 认「置位发生在发请求之前」，不认锁长什么样：它从布尔换成「哪条录音 + 这一发」之后，
   * 逐字断言会全部误红而行为一点没坏（形状 4a，这类旧守卫这一轮已换掉多条）。
   */
  it('重试按钮连点两下不并发建两条 run', () => {
    const at = source.indexOf('onStart={entryId ? () => {');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 1200);
    const guard = body.search(/if \(restarting\w*Ref\.current/);
    const acquire = body.search(/restarting\w*Ref\.current = /);
    const request = body.indexOf('transcribeEntry(');
    expect(guard).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(guard);
    expect(request).toBeGreaterThan(acquire);
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
    // 断的是行为：查不到就走 skipped 那条出路、不落到覆盖写。逐字锁死写法的话，
    // 这一档一旦要多记一件事（比如「是不是该重试」）就会被自己的守卫拦住（形状 4a）。
    const at = flush.indexOf('if (!remote.success)');
    expect(at, '版本查不到没有单独一条出路').toBeGreaterThan(-1);
    const branch = flush.slice(at, at + 160);
    expect(branch).toContain('return skipped;');
    expect(branch).not.toContain('updateDocumentContent(');
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
    // 必须等它回来并看结果——fire-and-forget 会在拉取失败时把草稿删了却留着旧内容在屏上。
    // 判据不钉参数列表：这一路后来要传「丢弃本机草稿」的标志，钉死写法会让正确实现误红
    expect(block).toMatch(/const installed = await reloadNote\(/);
    expect(block).toContain('if (!installed)');
    // 清草稿必须排在装上之后
    expect(block.search(/const installed = await reloadNote\(/))
      .toBeLessThan(block.indexOf('clearOfflineEdit(noteIdForFlush, ownerId);'));
    expect(block).not.toContain('void reloadNote();');
  });

  it('reloadNote 汇报正文到底装上了没有，不是只返回 void', () => {
    // 只认「返回的是成败」，不认参数列表
    expect(source).toMatch(/const reloadNote = useCallback\(async \([^)]*\): Promise<boolean> => \{/);
    // 判据认「返回的就是那个『装上了没有』的判定」，不认它写成表达式还是变量
    expect(source).toMatch(/return (installed|contentRes\.success && typeof contentRes\.data\?\.content === 'string');/);
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
    const end = launch.indexOf('launchingEntryRef.current = null;');
    expect(end, '发起整理那段的终点找不到了，下面的作用域会退化成整份文件').toBeGreaterThan(0);
    const body = launch.slice(0, end);
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

  /*
   * 标题说的是两条分支，判据也必须真的看两条。此前切片在「终态分支开始」那一行截断，
   * 于是终态那一半根本不在被检查的范围里——把它的清理删掉，用例照样绿
   * （对抗审查 A1：守住一半，标题却写着两条）。
   */
  it('退役分支与终态分支都清 activeTranscribeRun', () => {
    const clear = /setActiveTranscribeRun\(current => \(current\?\.id === runId \? null : current\)\)/g;
    const retire = source.indexOf("if (decision.kind === 'retire-watcher')");
    const terminalHead = source.indexOf('const observedRun = decision.run;', retire);
    expect(retire).toBeGreaterThan(0);
    expect(terminalHead).toBeGreaterThan(retire);

    const retireBranch = source.slice(retire, terminalHead);
    expect(retireBranch.length).toBeGreaterThan(400);
    expect(retireBranch, '退役分支没清进度位').toMatch(clear);

    // 终态分支：从它开头到这一轮循环结束
    const terminalBranch = source.slice(terminalHead, source.indexOf('void loadEntries();', terminalHead) + 40);
    expect(terminalBranch.length).toBeGreaterThan(200);
    expect(terminalBranch, '终态分支没清进度位').toMatch(clear);
  });
});

/*
 * 处理页两秒一发地问「这条转录跑到哪了」。查询慢于间隔时两发会重叠：后发的那份是终态、
 * 清掉了定时器，先发的那份随后落地又把 run 写回在途——此后再没有下一次轮询，
 * 这一屏永远停在一个走不完的进度上。判据认「回来时只认最新那一发」这件事本身。
 */
describe('处理页的轮询丢弃过期回包', () => {
  const source = read('pages/document-store/RecordingProcessingPage.tsx');

  /*
   * 串行，不是定点发。两种坏法都栽过：定点发 + 不认回包 → 慢查询的旧回包把 run 写回在途、
   * 此后再无轮询；定点发 + 只认最新序号 → 每一发都慢于间隔时每一发都被丢弃，屏上什么都不更新。
   * 判据认「不存在按固定周期重复触发的定时器」+「下一发是在回包处理完之后才排的」。
   */
  it('轮询是串行的：一发回来了才排下一发', () => {
    const fn = source.slice(source.indexOf('const tick = async () => {'));
    const body = fn.slice(0, fn.indexOf('void tick();'));
    expect(body.length).toBeGreaterThan(200);
    // 周期性定时器一旦回来，重叠与饿死这两种形态就都回来了
    // 认调用形态（带括号），别把注释里提到它的那句话也算进来
    expect(source).not.toMatch(/setInterval\(/);
    // 每条走得通的分支都要么排下一发、要么明确收手
    expect(body).toContain('schedule();');
    expect(body.indexOf('schedule();')).toBeGreaterThan(body.indexOf('await getLatestAgentRun'));
  });
});

/*
 * 这两屏都是「同一条路由换参数」——React 复用组件、不重挂，所以凡是绑在条目上的
 * 状态都必须显式跟着 entryId 复位。漏掉的后果不是显示错一个数：
 * 音频地址漏了就是**这一屏在放上一条录音的声音**，锁漏了就是新那条上点整理静默无反应。
 */
describe('换条目时把绑在上一条身上的状态放掉', () => {
  it('处理页换条目先清空音频地址并停掉在放的那一条', () => {
    const source = read('pages/document-store/RecordingProcessingPage.tsx');
    const fn = source.slice(source.indexOf('const [audioUrl, setAudioUrl]'));
    const body = fn.slice(0, fn.indexOf('}, [entryId]);'));
    const clear = body.indexOf("setAudioUrl('')");
    const fetch_ = body.indexOf('getDocumentContent(');
    expect(clear).toBeGreaterThan(-1);
    // 清空必须排在取新地址之前，否则等于没清
    expect(fetch_).toBeGreaterThan(clear);
    expect(body).toContain('audioRef.current?.pause()');
  });

  it('处理页换条目把标题/库名/大小/日期一起清回加载态', () => {
    const source = read('pages/document-store/RecordingProcessingPage.tsx');
    // 从「取条目」那一句往回看：这一格之前必须已经把五格清掉
    const call = source.indexOf('await getDocumentEntry(');
    expect(call).toBeGreaterThan(-1);
    const head = source.slice(0, call);
    // 五格都要在发请求之前清掉，清在后面等于没清
    for (const reset of ["setTitle('')", "setStoreName('')", 'setSizeLabel(null)', 'setDateLabel(null)', 'setOwningStoreId(']) {
      expect(head).toContain(reset);
    }
  });

  it('处理页换条目把上一条的 run 与失败说明也清掉', () => {
    const source = read('pages/document-store/RecordingProcessingPage.tsx');
    const call = source.indexOf('await getLatestAgentRun(');
    expect(call).toBeGreaterThan(-1);
    const head = source.slice(0, call);
    expect(head).toContain('setRun(null)');
    expect(head).toContain('setFailure(null)');
  });

  /*
   * 「完成后通知我」的三格状态跟着录音走。不清的话：上一条处理过 → 这一条点通知当场
   * 弹一条假的「有新进展」；上一条通知过 → 这一条永远通知不了。
   */
  it('转录状态卡的通知追踪跟着录音条目复位', () => {
    const source = read('components/doc-browser/TranscribeStatusCard.tsx');
    const eff = source.slice(source.indexOf('notifiedRef.current = false;'));
    const scope = eff.slice(0, eff.indexOf('}, [') + 40);
    expect(scope).toContain('sawProcessingRef.current = false;');
    expect(scope).toContain("setNotifyState('idle')");
    expect(scope).toContain('[currentEntryId]');
  });

  it('结果页原文取失败不当成「没有原文」，并给得出重试', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    // 有笔记 id 却没取回正文 = 取失败，必须落到 error 而不是空串
    expect(source).toContain("if (noteId && !noteRes?.success) {");
    const err = source.slice(source.indexOf("{state.kind === 'error' && ("));
    expect(err.slice(0, 900)).toContain('setLoadTick(');
    // 重试要真的能让加载再跑一遍
    expect(source).toContain('[awaitNoteTick, entryId, loadTick, storeId]');
  });

  /*
   * 发起整理的锁认录音、也认这一发。全局布尔踩过两次、方向相反：不认录音会跨录音卡住；
   * 认录音但靠「换条目清零」补救，A 的 finally 后到会把 B 刚举起的锁清掉，B 再点一下
   * 就并发起第二条 restyle（两条都花钱、抢着覆盖同一篇笔记）。
   */
  it('结果页发起整理的锁认录音、也认这一发', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    // 锁里存的是「哪条录音」，不是一个布尔
    expect(source).toContain('const launchingEntryRef = useRef<string | null>(null);');
    expect(source).toContain('launchingEntryRef.current === entryId) return;');
    // 释放要先比这一发还是不是最新那发。断的是「比过之后才放」，不锁死写成一行还是一段
    const gate = source.indexOf('launchTokenRef.current === launchToken');
    expect(gate, '释放没有先认这一发').toBeGreaterThan(-1);
    const release = source.indexOf('launchingEntryRef.current = null', gate);
    expect(release).toBeGreaterThan(gate);
    expect(release - gate, '释放离那道门太远，中间夹了别的东西').toBeLessThan(200);
    // 不许再退回「换条目就清零」那种补救
    expect(source).not.toMatch(/launchingRef\.current = false/);
  });

  it('覆盖成功后先认队列里还是不是那一份，再清', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    const fn = source.slice(source.indexOf('const overwriteWithOfflineDraft = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [enqueueWrite'));
    const gate = body.indexOf("pendingRef.current?.savedAt !== queued!.savedAt");
    expect(gate).toBeGreaterThan(-1);
    // 这道门必须排在清草稿与替换正文之前
    expect(body.indexOf('clearOfflineEdit(')).toBeGreaterThan(gate);
    expect(body.indexOf('setPendingEdits(null)')).toBeGreaterThan(gate);
  });

  it('处理页换条目把时长也归零', () => {
    const source = read('pages/document-store/RecordingProcessingPage.tsx');
    const call = source.indexOf('await getDocumentEntry(');
    expect(source.slice(0, call)).toContain('setDurationSec(0)');
  });
});

/*
 * 「路由复用组件」这一族的收口：与其一格一格地补复位，不如让跟读组件按录音重挂。
 * 不重挂的话，A 在飞的问答流会把回答落成 B 的答案；A 那个还开着的编辑框一保存，
 * 走的是 B 的 onSaveNote、写进去的是 A 的草稿——直接改坏 B 的原文。
 */
describe('跟读组件按录音重挂', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('TranscriptKaraoke 带上认这条录音的 key', () => {
    const tag = source.slice(source.indexOf('<TranscriptKaraoke'));
    const props = tag.slice(0, tag.indexOf('/>'));
    expect(props).toMatch(/key=\{state\.noteId/);
  });
});

/*
 * 本机压着离线草稿时，重新拉回来的服务端正文不许盖掉屏幕上那份：盖掉之后草稿仍在队列里
 * 没补传，用户再改一句就是在服务端那份上重建整篇，几处离线校对永久消失且全程无提示。
 * 唯一的例外是用户自己点「丢弃」——那一路要的正是换成云端版本。
 */
describe('重新拉笔记不吞掉本机草稿', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('有可补传的本机草稿时正文让位给草稿', () => {
    expect(source).toContain('const keepLocalDraft = !discardLocalDraft && isFlushable(pendingRef.current, noteId, ownerId);');
    const setter = source.slice(source.indexOf('setState(cur => (cur.kind === \'ready\' && cur.noteId === noteId'));
    expect(setter.slice(0, 400)).toContain('keepLocalDraft');
  });

  it('只有用户点「丢弃」那一路才允许覆盖', () => {
    expect(source).toContain('await reloadNote(true)');
  });
});

/*
 * 冲突还没裁决时不许写。横幅正挂着说云端那份被改过（或没法确认），而屏幕上显示的是
 * 本机草稿；此时随手改一句走的是无条件整篇 PUT，同事那一版被静默盖掉、横幅自己消失。
 * decideOfflineFlush 那道门只拦自动补传，拦不到这条路（对抗审查 B1）。
 */
describe('冲突未裁决时不许写回', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('onSaveNote 第一件事就是看冲突，早于任何写', () => {
    const fn = source.slice(source.indexOf('const onSaveNote = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, [enqueueWrite'));
    const gate = body.indexOf('if (flushConflict)');
    expect(gate).toBeGreaterThan(-1);
    for (const write of ['saveOfflineEdit(', 'updateDocumentContent(']) {
      expect(body.indexOf(write)).toBeGreaterThan(gate);
    }
    // 拦下来要说清为什么，并把用户推回那两颗按钮
    expect(body.slice(gate, gate + 400)).toContain('toast.error(');
  });

  it('flushConflict 在依赖里，拦截判据不会读到过期值', () => {
    expect(source).toContain('}, [enqueueWrite, flushConflict, ownerId, state]);');
  });
});

/*
 * 后端写入时刻必须先截到毫秒，否则响应值与随后读回来的值永远对不上（BSON DateTime
 * 只有毫秒精度）。前端那侧另有按时刻比的判据兜底，两边都要在（对抗审查 C1）。
 */
describe('写回时刻与库的精度对齐', () => {
  it('EntryContentWriteService 的 now 是截过的', () => {
    // 这个文件在另一个模块里，用现成的 fs/path（本文件顶部已经引入）从仓库根找过去
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const source = fs.readFileSync(
      path.join(repoRoot, 'prd-api/src/PrdAgent.Api/Services/EntryContentWriteService.cs'),
      'utf-8',
    );
    expect(source).toContain('var now = TruncateToMilliseconds(DateTime.UtcNow);');
    expect(source).toContain('TicksPerMillisecond');
  });
});

/*
 * AI 不可用是「录音与原文都好」的另一件事，原文已经存在时这句话更成立。
 * 原来那条 `!noteEntryId` 让「已有原文 + 重新整理失败且失败码是 AI 不可用」这一档
 * 三块全灭：失败卡不出、横幅不出，而绿色的「全部完成」照常显示。
 */
describe('AI 不可用要说出来，且不同屏报「全部完成」', () => {
  const source = read('components/doc-browser/TranscribeStatusCard.tsx');

  it('横幅判据不再排除「已有原文」那一档', () => {
    // 只取这一条语句本身（到分号为止），别把下一行的 chips 判据也算进来
    const from = source.slice(source.indexOf('const aiDown = '));
    const stmt = from.slice(0, from.indexOf(';') + 1);
    expect(stmt).toContain('aiUnavailable');
    expect(stmt).not.toContain('noteEntryId');
  });

  it('横幅在时不报完成', () => {
    const from = source.slice(source.indexOf('const completionCopy = '));
    const stmt = from.slice(0, from.indexOf(';') + 1);
    expect(stmt).toContain('!aiDownVisible');
  });

  it('这张卡的时长也跟着录音归零', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{ setDurationSec\(0\); \}, \[currentEntryId\]\);/);
  });
});

describe('拉回来的正文与版本令牌绑在一起', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  /*
   * 条目查到了、正文这一发失败（或正文让位给了本机草稿），屏幕上还是旧文字，
   * 而令牌已经指向服务端的新版本——用户接着离线改这段旧文字，基线一比「一样」，
   * 补传就把刚整理出来的新内容整篇盖掉，全程没有冲突提示。
   */
  it('只有正文真的换上了才推进令牌', () => {
    expect(source).toContain("const installed = contentRes.success && typeof contentRes.data?.content === 'string' && !keepLocalDraft;");
    const from = source.slice(source.indexOf('if (installed && noteEntryRes.success'));
    expect(from.slice(0, 160)).toContain('noteRevisionRef.current = noteEntryRes.data.updatedAt;');
    // 返回值与令牌用的是同一个判据，不许再各算一套
    expect(source).toContain('return installed;');
  });
});

describe('衍生产物失败的「重试」不重跑 ASR', () => {
  const source = read('components/doc-browser/TranscribeStatusCard.tsx');

  it('原文已经在时，重试走整理那条路，而且卡上两处「重试」共用同一个判据', () => {
    // 判据只许有一份：抄成两份就会像 Codex 抓到的那样改一处漏一处（形状 3）
    const decisions = [...source.matchAll(/noteEntryId && onRestyle \? onRestyle : onStart/g)];
    expect(decisions, '「重试」重跑什么的判据不是唯一一份').toHaveLength(1);
    expect(source).toContain('const rerunAction = noteEntryId && onRestyle ? onRestyle : onStart;');
    // AI 不可用那张横幅上的重试也走它，不再直接调 onStart
    const banner = source.slice(source.indexOf('{aiDown && ('), source.indexOf('{completionCopy && ('));
    expect(banner).toContain('rerunAction()');
    expect(banner).not.toMatch(/onClick=\{\(\) => onStart\(\)\}/);
  });
});

describe('估算时间轴不给做不到的说话人入口', () => {
  const source = read('components/doc-browser/TranscriptKaraoke.tsx');

  it('这一档不渲染「手动标记说话人」，并说明原因', () => {
    expect(source).toContain('{onSaveNote && !estimated && (');
    expect(source).toContain('这份原文没有真实时间轴，暂时存不下说话人标注。');
  });
});

/*
 * 取证流水线要能在别人的机器上跑起来。此前两处把它绑死在我这台机器上：
 * 设计稿地址与文件名写死、浏览器可执行文件写死某个容器镜像的绝对路径。
 * 更糟的是取不到设计稿时不报错——照样切图、照样出分数，那是一批空白基准图
 * （「不会红的证据比没有证据更糟」，Codex 第三十轮 P2）。
 */
describe('设计稿取证脚本不绑死在一台机器上', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'e2e/design-fidelity/extract-design-boards.mjs'),
    'utf-8',
  );

  it('设计稿地址与画布清单可由环境变量给', () => {
    expect(source).toContain('process.env.DESIGN_BASE_URL');
    expect(source).toContain('process.env.DESIGN_PAGES');
  });

  it('浏览器让 Playwright 自己找，不写死容器里的绝对路径', () => {
    expect(source).not.toContain('/opt/pw-browsers/');
    expect(source).toContain('process.env.CHROMIUM_PATH');
  });

  it('取不到设计稿当场报错，不静默切出空白基准图', () => {
    const from = source.slice(source.indexOf('const response = await page.goto('));
    expect(from.slice(0, 600)).toContain('throw new Error(');
    expect(from.slice(0, 600)).toContain('response.ok()');
  });
});

/*
 * 「时长跟着录音归零」这一条在三屏各犯过一次。判据一次覆盖三处，
 * 免得下一个人又在第四处漏掉（约定见 doc/rule.prd-admin.recording-entry-scope.md）。
 */
describe('时长这一格三屏都跟着录音归零', () => {
  /*
   * 三处的写法不同（两处是独立 effect、一处清在加载 effect 的开头），所以判据分开写，
   * 但要求是同一条：**复位真的挂在「换录音」上，且发生在取新数据之前**。
   */
  it('结果页：独立 effect，依赖是 entryId', () => {
    const source = read('pages/document-store/RecordingResultPage.tsx');
    expect(source).toMatch(/useEffect\(\(\) => \{ setDurationSec\(0\); \}, \[entryId\]\);/);
  });

  it('转录状态卡：独立 effect，依赖是 currentEntryId', () => {
    const source = read('components/doc-browser/TranscribeStatusCard.tsx');
    expect(source).toMatch(/useEffect\(\(\) => \{ setDurationSec\(0\); \}, \[currentEntryId\]\);/);
  });

  it('处理页：清在取条目之前（清在后面等于没清）', () => {
    const source = read('pages/document-store/RecordingProcessingPage.tsx');
    const reset = source.indexOf('setDurationSec(0)');
    const fetch_ = source.indexOf('await getDocumentEntry(');
    expect(reset).toBeGreaterThan(-1);
    expect(fetch_).toBeGreaterThan(reset);
  });
});

describe('在途状态的两处判据用同一条', () => {
  const source = read('pages/document-store/DocumentStorePage.tsx');

  /*
   * 「这条录音已经有内嵌进度卡了」与「真的渲染那张卡」必须同一条判据。不一致时，
   * 横幅按前者把它过滤掉、渲染按后者拒掉它——两处都看不到这条录音在跑。
   */
  it('横幅拿到的 currentRunHasInlineCard 也认 sourceEntryId', () => {
    const at = source.indexOf('currentRunHasInlineCard:');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 200)).toContain('sourceEntryId === selectedEntryId');
  });
});

describe('整理完成后正文没取回来要说出来', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('done 分支读 reloadNote 的返回值，并在真失败时报错', () => {
    const at = source.indexOf("if (run.status === 'done')");
    expect(at).toBeGreaterThan(-1);
    const branch = source.slice(at, source.indexOf("} else if (run.status === 'failed'", at));
    expect(branch).toContain('const installed = await reloadNoteRef.current();');
    expect(branch).toContain('if (!installed');
    expect(branch).toContain('toast.error(');
    // 「本机草稿有意让位」不算失败，不能在那一档也报错
    expect(branch).toContain('isFlushable(pendingRef.current');
  });
});

/*
 * 「等笔记出现」这个轮询：查询失败 ≠ 没有在途转录。合成一个布尔的话，一次网络抖动
 * 就把定时器永久清掉，笔记随后发布也不会自动装上，用户只能手动刷新。
 */
describe('等笔记的轮询区分「查不到」与「确认没有」', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const fn = source.slice(source.indexOf("const runRes = await getLatestAgentRun(entryId, 'transcribe');"));
  const body = fn.slice(0, fn.indexOf('void tick();'));

  it('这条轮询也是串行的：一轮回来了才排下一轮', () => {
    // 这一条要连 schedule 的定义一起看，所以从整个 effect 截，而不是从 tick 内部截
    const effect = source.slice(source.indexOf('if (!entryId || !noteMissing) return;'), source.indexOf('}, [entryId, noteMissing]);'));
    expect(effect).not.toMatch(/window\.setInterval\(/);
    expect(effect).toContain('window.setTimeout(() => { void tick(); }, 3000)');
    expect(effect).toContain('window.clearTimeout(timer)');
  });

  it('查询失败照常等下一轮，永久失败那一档才收手', () => {
    const at = body.indexOf('if (!runRes.success) {');
    expect(at, '查询失败没有单独一条出路').toBeGreaterThan(-1);
    // 只截「查询失败」这一个分支：截到下一档会把别的出路也算进来
    const branch = body.slice(at, body.indexOf('if (!isTranscriptionInflight', at));
    // 串行之后「收手」= 不排下一轮。抖动必须排，永久失败必须不排
    expect(branch).toMatch(/if \(!isPermanentLookupFailure\(runRes\.error\?\.code\)\) schedule\(\);/);
  });

  it('收手分两档：done 先看一眼笔记，failed/cancelled 才是真的没戏', () => {
    // 「不在途」不等于「没东西可取」：done 也不在途，但笔记多半已经发布了
    expect(body).toContain('const inflight = isTranscriptionInflight(status);');
    expect(body).toContain('const succeeded = isTranscriptionSucceeded(status);');
    const stop = body.indexOf('if (!inflight && !succeeded) return;');
    expect(stop, '没有把 done 与 failed 分开').toBeGreaterThan(-1);
    // 取条目那一发必须在这道门之后：门写反了就会对 failed 也去白取一次
    expect(body.indexOf('await getDocumentEntry(entryId)')).toBeGreaterThan(stop);
  });

  it('done 之后笔记还没读到时给几轮宽限，但不无限等', () => {
    expect(body).toContain('doneGrace += 1;');
    expect(body).toContain('if (doneGrace > MAX_DONE_GRACE) return;');
  });

  it('次数上限仍在，不会无限等下去', () => {
    expect(body).toContain('attempts >= MAX_ATTEMPTS');
  });
});

/*
 * 处理页「重新发起」的锁与结果页那把是同一种形状（rule.prd-admin.recording-entry-scope 第 3 条）：
 * 布尔锁会跨录音卡住，而 A 的成功回调还会清掉 B 正在显示的 run 与失败说明、重起 B 的观察器。
 */
describe('处理页重新发起的锁认录音、也认这一发', () => {
  const source = read('pages/document-store/RecordingProcessingPage.tsx');

  it('锁里存的是哪条录音，不是布尔', () => {
    expect(source).toContain('const restartingEntryRef = useRef<string | null>(null);');
    expect(source).toContain('restartingEntryRef.current === entryId) return;');
    expect(source).not.toMatch(/restartingRef\.current = (true|false)/);
  });

  it('回包先认录音再动这一屏的状态', () => {
    const at = source.indexOf('void transcribeEntry(restartedFor)');
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 900);
    const gate = body.indexOf('entryIdRef.current !== restartedFor');
    expect(gate).toBeGreaterThan(-1);
    for (const write of ['setFailure(null)', 'setRun(null)', 'setWatchEpoch(']) {
      expect(body.indexOf(write)).toBeGreaterThan(gate);
    }
  });

  it('只有最新那一发释放锁', () => {
    expect(source).toMatch(/if \(restartTokenRef\.current === token\) restartingEntryRef\.current = null;/);
  });
});


describe('转录记录不在了，不许拿全量重转顶上', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const launch = source.slice(source.indexOf('const launchedForEntryId = entryId;'));
  const body = launch.slice(0, launch.indexOf('launchingEntryRef.current = null;'));

  it('屏幕上已经有原文时当场停下，不落到重跑 ASR 那一路', () => {
    const fallback = body.indexOf('transcribeEntry(entryId, style)');
    expect(fallback, '找不到全量重转那条兜底').toBeGreaterThan(0);
    // 守卫要同时认「没有可复用的 run」和「已经有一篇原文」，缺一条都会误伤另一档
    const guard = body.search(/if \(!priorRunId && note[A-Za-z]*(Ref\.current|Id)\)/);
    expect(guard, '没有「有原文就别重转」这道守卫').toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(fallback);
    // 而且这道守卫必须真的**停下**，不是提示一句继续往下走
    expect(body.slice(guard, fallback)).toContain('return;');
  });

  it('还没有原文的那一档仍然走全量转录', () => {
    // 反向断言：兜底本身没被删掉——这条录音压根没转录成功过时，跑 ASR 才是对的
    expect(body).toContain('transcribeEntry(entryId, style)');
  });
});

describe('回到还在整理的录音，把在途那一发接回来', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const at = source.indexOf("const res = await getLatestAgentRun(entryId, 'transcribe');");
  const body = source.slice(at, at + 1200);

  it('查到的 run 还在途才接，历史 run 不复活成进度条', () => {
    expect(at, '结果页没有「接回在途整理」这一段').toBeGreaterThan(0);
    const gate = body.indexOf('isTranscriptionInflight(run.status)');
    const adopt = body.indexOf('setRunning(');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(adopt);
  });

  it('接之前先认这一屏还是不是当初那条录音', () => {
    const gate = body.indexOf('entryIdRef.current !== entryId');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf('setRunning('));
  });

  it('已经有在途的不许被这条查询顶掉', () => {
    expect(body).toMatch(/setRunning\(prev => prev \?\?/);
  });

  it('笔记加载出来之后才认，依赖里带着它', () => {
    const tail = source.slice(at, source.indexOf('}, [entryId, noteIdForFlush]);', at) + 40);
    expect(tail).toContain('}, [entryId, noteIdForFlush]);');
    expect(source.slice(Math.max(0, at - 400), at)).toContain('!noteIdForFlush) return;');
  });
});

describe('查询失败分两种：抖动才重试，永久失败当场停下', () => {
  const processing = read('pages/document-store/RecordingProcessingPage.tsx');
  const result = read('pages/document-store/RecordingResultPage.tsx');
  const vault = read('pages/document-store/recordingVault.ts');

  it('判定只有一处定义，两处轮询共用', () => {
    expect(vault).toContain('export function isPermanentLookupFailure(');
    // 只读权限与「条目不存在」后端都回 NOT_FOUND，两种都得认
    for (const code of ['NOT_FOUND', 'PERMISSION_DENIED']) {
      expect(vault).toContain(`'${code}'`);
    }
    expect(processing).not.toMatch(/function isPermanentLookupFailure/);
    expect(result).not.toMatch(/function isPermanentLookupFailure/);
  });

  it('处理页：永久失败不再排下一发，而是说出来', () => {
    const tick = processing.lastIndexOf("const res = await getLatestAgentRun(entryId, 'transcribe');");
    expect(tick, '找不到看护这条 run 的轮询').toBeGreaterThan(0);
    const at = processing.indexOf('if (!res.success) {', tick);
    expect(at).toBeGreaterThan(0);
    const block = processing.slice(at, processing.indexOf('const next =', at));
    const permanent = block.indexOf('isPermanentLookupFailure(res.error?.code)');
    expect(permanent, '处理页没有区分永久失败').toBeGreaterThan(-1);
    // 永久那一档要在任何 schedule() 之前就返回
    expect(permanent).toBeLessThan(block.indexOf('schedule();'));
    expect(block.slice(permanent, block.indexOf('schedule();'))).toContain('setWatchError(');
    // 抖动也不能无限试
    expect(block).toContain('failureStreak >= MAX_FAILURE_STREAK');
  });

  it('处理页：停下来这件事出现在屏幕上，并给得出下一步', () => {
    expect(processing).toContain('{watchError && (');
    const banner = processing.slice(processing.indexOf('{watchError && ('), processing.indexOf('<TranscribeStatusCard'));
    expect(banner).toContain('setWatchEpoch(v => v + 1)');
  });

  it('结果页等笔记：永久失败当场收手，不白问一百遍', () => {
    const at = result.indexOf('if (!runRes.success) {');
    expect(at).toBeGreaterThan(0);
    const block = result.slice(at, at + 600);
    // 串行轮询里「收手」就是不排下一轮：永久失败那一档不许调 schedule()
    expect(block).toMatch(/if \(!isPermanentLookupFailure\(runRes\.error\?\.code\)\) schedule\(\);/);
  });
});

describe('在线补传卡住时会自己再试，而且看得见', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');

  it('版本没查着就排一次退避重试，不是等下一次断网重连', () => {
    const at = source.indexOf('if (!remote.success) {');
    expect(at, '找不到版本查询那一档').toBeGreaterThan(0);
    // 卡住的原因要被记下来，回到 then 里才分得清「该重试」和「冲突/被作废」
    expect(source.slice(at, at + 120)).toContain('retryOnFailure = true');
    expect(source).toMatch(/if \(retryOnFailure\) scheduleRetry\(\);/);
    expect(source).toContain('const RETRY_DELAYS = [');
  });

  it('重试的节拍进了依赖，否则退避到点了也不会再跑一遍', () => {
    expect(source).toMatch(/\}, \[enqueueWrite, flushConflict, flushRetryTick, noteIdForFlush, offline, ownerId, pendingEdits\]\);/);
  });

  it('退避到点前先清掉定时器，别让切走的那一屏把 tick 打回来', () => {
    expect(source).toMatch(/return \(\) => \{ alive = false; window\.clearTimeout\(retryTimer\); \};/);
  });

  it('在线也出横幅：欠了几处、还试不试、能不能手动再来一次', () => {
    const at = source.indexOf('(pendingEdits && flushStalled) ? (');
    expect(at, '在线卡住时没有任何横幅').toBeGreaterThan(0);
    const banner = source.slice(at, source.indexOf(') : undefined}', at));
    expect(banner).toContain('{pendingEdits.count} 处离线校对还没上去');
    // 两档给两句话：还在自动重试 / 次数用完了。合成一句就会在用完之后继续说假话
    expect(banner).toContain("flushStalled === 'retrying'");
    expect(banner).toContain('立即重试');
  });

  it('传上去之后卡住那一档散掉，重试额度还给下一份草稿', () => {
    const at = source.indexOf('已补传 ${queued!.count} 处离线校对');
    expect(at).toBeGreaterThan(0);
    const around = source.slice(at - 400, at);
    expect(around).toContain('setFlushStalled(null)');
    expect(around).toContain('flushRetryRef.current = { savedAt: 0, attempts: 0 }');
  });
});


describe('结果页看整理进度的轮询也是串行的', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const at = source.indexOf('const runningRunId = ');
  const body = source.slice(at, source.indexOf('}, [ownerId, runningRunId]);', at));

  it('一发回来了才排下一发，不是定点发', () => {
    // 注释里为了讲清楚踩过的坑会写到这个词，判据只看真正的调用
    expect(body).not.toMatch(/window\.setInterval\(/);
    expect(body).not.toMatch(/clearInterval\(/);
    expect(body).toContain('window.setTimeout(() => { void tick(); }, 2000)');
    // 还在跑那一支要自己排下一发，否则轮询只跑一次就停了
    const inflight = body.lastIndexOf('setRunning((prev)');
    expect(body.indexOf('schedule();', inflight)).toBeGreaterThan(inflight);
  });

  it('终态那两支不再排下一发', () => {
    for (const marker of ['run.status === \'done\'', "run.status === 'failed'"]) {
      const at2 = body.indexOf(marker);
      expect(at2, `找不到 ${marker} 这一支`).toBeGreaterThan(-1);
    }
    // done / failed 两支各自 setRunning(null) 收手，schedule 只出现在失败重试与还在跑那两处
    expect([...body.matchAll(/schedule\(\);/g)].length).toBe(2);
  });

  it('查询失败也分两种，且都不会留下一根不动的进度条', () => {
    const at2 = body.indexOf('if (!res.success) {');
    expect(at2).toBeGreaterThan(-1);
    const branch = body.slice(at2, body.indexOf('watchFailures = 0;', at2));
    expect(branch).toContain('isPermanentLookupFailure(res.error?.code)');
    expect(branch).toContain('watchFailures >= MAX_WATCH_FAILURES');
    // 收手那一路要把进度条摘掉并说一句
    const stop = branch.indexOf('setRunning(null)');
    expect(stop).toBeGreaterThan(-1);
    expect(branch.slice(stop)).toContain('toast.error(');
  });
});

describe('对照画板缺图必须变红', () => {
  const source = read('../../e2e/design-fidelity/build-compare-artifact.mjs');

  it('缺一侧就非零退出，不静默交出半截证据', () => {
    const at = source.indexOf('if (missing.length) {');
    expect(at, '缺图没有任何出路').toBeGreaterThan(0);
    const block = source.slice(at, at + 400);
    expect(block).toContain('process.exitCode = 1');
    // 只 console.log 一行不算：自动跑的流水线读的是退出码
    expect(source).not.toMatch(/if \(missing\.length\) console\.log/);
  });

  it('产物自己也把缺的那几块点名，不能被误当成完整取证', () => {
    expect(source).toContain('renderPage(cards, DATA, missing)');
    expect(source).toContain('这份对照不完整：缺 ${missing.length} 张图');
  });
});


describe('在线保存不许清掉这期间新排下的草稿', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const save = source.slice(source.indexOf('const onSaveNote = useCallback'), source.indexOf('const noteIdForFlush ='));

  it('发起时先记下队列里是哪一份', () => {
    expect(save).toContain('const queuedBeforeSave = pendingRef.current?.savedAt ?? null;');
  });

  it('只有队列没换过才清本机草稿', () => {
    const clear = save.indexOf('clearOfflineEdit(savingNoteId, ownerId)');
    expect(clear, '找不到清草稿那一句').toBeGreaterThan(-1);
    // 清之前必须先比一次；无条件清就会把断网期间新写的那几处删掉
    const decide = save.indexOf('const queueUnchanged =');
    expect(decide).toBeGreaterThan(-1);
    expect(decide).toBeLessThan(clear);
    expect(save.slice(decide, clear + 60)).toMatch(/if \(queueUnchanged\) clearOfflineEdit/);
  });

  it('队列换过就什么都不动：不清横幅、也不把正文换回旧的', () => {
    const at = save.indexOf('if (!queueUnchanged) {');
    expect(at, '没有「队列换过」这一档').toBeGreaterThan(-1);
    const branch = save.slice(at, save.indexOf('setPendingEdits(null);', at));
    expect(branch).toContain('return true;');
    // 这一档不许落到下面那几句共享状态的清理上
    expect(branch).not.toContain('setPendingEdits(null)');
    expect(branch).not.toContain('setFlushConflict(null)');
  });
});


describe('发起整理这件事要当场看得见', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const launch = source.slice(source.indexOf('const onPickOrganizeStyle = useCallback'), source.indexOf('const onRestyle = useCallback'));

  it('屏幕上的状态与锁同刻置位，不等两个请求回来', () => {
    const lock = launch.indexOf('launchingEntryRef.current = entryId;');
    const visible = launch.indexOf('setLaunchingStyle(styleKey)');
    const firstAwait = launch.indexOf('await ');
    expect(lock).toBeGreaterThan(-1);
    expect(visible, '锁只有 ref，屏幕上没有任何表示').toBeGreaterThan(-1);
    expect(visible).toBeGreaterThan(lock);
    expect(visible, '「正在发起」落在 await 之后就等于没有').toBeLessThan(firstAwait);
  });

  it('失败与成功都撤掉这一档，且只有最新那一发有资格撤', () => {
    const at = launch.indexOf('} finally {');
    expect(at).toBeGreaterThan(-1);
    const block = launch.slice(at);
    expect(block).toContain('launchTokenRef.current === launchToken');
    expect(block).toContain('setLaunchingStyle(null)');
  });

  it('这一档跟着录音复位，不带到下一条上', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{ setRunning\(null\); setLaunchingStyle\(null\); \}, \[entryId\]\);/);
  });

  it('传给面板了，否则算完了也画不出来', () => {
    expect(source).toContain('launchingStyleKey: launchingStyle,');
  });
});


describe('处理页跑完之后要把原文接上，而不是请用户再转一遍', () => {
  const source = read('pages/document-store/RecordingProcessingPage.tsx');

  it('done 之后去取条目，把 transcribe_entry_id 接进卡片', () => {
    const at = source.indexOf('if (!isTranscriptionSucceeded(next.status)) return;');
    expect(at, '跑完之后没有去接原文').toBeGreaterThan(-1);
    const after = source.slice(at, at + 700);
    expect(after).toContain('await getDocumentEntry(entryId)');
    expect(after).toContain("metadata?.transcribe_entry_id");
    expect(after).toContain('setNoteEntryId(publishedNoteId)');
  });

  it('这一格真的传给了卡片——不传的话卡片仍按「还没有原文」画', () => {
    expect(source).toContain('noteEntryId={noteEntryId || undefined}');
  });

  it('回头再打开这个地址时，从条目上直接取原文', () => {
    expect(source).toContain("setNoteEntryId(entryRes.data.metadata?.transcribe_entry_id ?? '')");
    // 换条目要先清，否则上一条的原文会挂在下一条身上
    expect(source).toContain("setNoteEntryId('');");
  });

  it('发布还没读到时给几轮宽限，failed/cancelled 不白取', () => {
    expect(source).toContain('publishGrace += 1;');
    expect(source).toContain('if (publishGrace <= MAX_PUBLISH_GRACE) schedule();');
  });
});


describe('在线保存落地后，队列里那份新草稿要跟着换基线', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const save = source.slice(source.indexOf('const onSaveNote = useCallback'), source.indexOf('const noteIdForFlush ='));

  it('发起时记下当时的版本令牌', () => {
    expect(save).toContain('const revisionBeforeSave = noteRevisionRef.current;');
  });

  it('队列换过那一档里真的调了换基线，并且落盘', () => {
    const at = save.indexOf('if (!queueUnchanged) {');
    expect(at).toBeGreaterThan(-1);
    const branch = save.slice(at, save.indexOf('return true;', at));
    expect(branch).toContain('rebaseOfflineEditAfterOwnSave(');
    // 只改内存不落盘的话，刷新之后接回来的还是旧基线那一份
    expect(branch).toContain('saveOfflineEdit(rebased)');
    expect(branch).toContain('setPendingEdits(rebased)');
  });

  it('判据在队列模块里，页面不另算一套', () => {
    expect(save).not.toContain('baseUpdatedAt: nextRevision');
  });
});


describe('切知识库时，已经飞出去的那一发建会话必须作废', () => {
  const source = read('pages/document-store/RecordAudioSheet.tsx');

  it('建会话时记下代次，回来先认代次', () => {
    expect(source).toContain('const uploadSessionEpochRef = useRef(0);');
    const at = source.indexOf('uploadSessionPromiseRef.current = startRecordingUpload(');
    expect(at).toBeGreaterThan(-1);
    const epoch = source.lastIndexOf('const epoch = uploadSessionEpochRef.current;', at);
    expect(epoch, '发起时没有记代次').toBeGreaterThan(-1);
    expect(epoch).toBeLessThan(at);
  });

  it('认不上就不装 ref、不连实时转写，并把白建的会话取消掉', () => {
    const at = source.indexOf('uploadSessionPromiseRef.current = startRecordingUpload(');
    const body = source.slice(at, source.indexOf('return await uploadSessionPromiseRef.current;', at));
    const guard = body.indexOf('if (stale()) {');
    expect(guard, '成功分支没有认代次').toBeGreaterThan(-1);
    const install = body.indexOf('uploadSessionIdRef.current = res.data.sessionId;');
    expect(install).toBeGreaterThan(guard);
    expect(body.slice(guard, install)).toContain('cancelRecordingUpload(res.data.sessionId)');
    // 连实时转写也在这道门之后
    expect(body.indexOf('connectLiveTranscription(res.data.sessionId)')).toBeGreaterThan(guard);
    // 失败两支也认代次：旧库那一发失败不该把新库这一条打成降级
    expect([...body.matchAll(/if \(stale\(\)\) return null;/g)]).toHaveLength(2);
  });

  it('切库那一步先推代次，再动别的', () => {
    const at = source.indexOf('const previousSessionId = uploadSessionIdRef.current;');
    expect(at).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, at - 600), at);
    expect(before, '推代次没有排在切库动作最前面').toContain('uploadSessionEpochRef.current += 1;');
  });
});

describe('阅读器里换一条录音也要重挂跟读组件', () => {
  const source = read('components/file-preview/FilePreview.tsx');

  it('AudioDocumentPreview 带上认这条录音的 key', () => {
    const at = source.indexOf('<AudioDocumentPreview');
    expect(at).toBeGreaterThan(-1);
    const tag = source.slice(at, source.indexOf('/>', at));
    expect(tag, '不重挂的话，A 的编辑草稿会保存进 B').toContain('key={entry.id}');
  });
});


describe('补传失败的两种都要再试，且状态跟着笔记走', () => {
  const source = read('pages/document-store/RecordingResultPage.tsx');
  const flush = source.slice(
    source.indexOf('/** 恢复联网就把队列补传上去'),
    source.indexOf('/** 冲突时用户明说「用我的版本」'),
  );

  it('写这一发自己失败了也算「值得再试」，不只是版本没查着', () => {
    const put = flush.indexOf('return updateDocumentContent(noteIdForFlush');
    expect(put).toBeGreaterThan(-1);
    /*
     * 置位必须落在**冲突判定之后、PUT 之前**这一段里。
     * 只找「PUT 之前的最后一处」是不够的：版本没查着那一处也在 PUT 之前，
     * 把写这一发的置位删掉，判据照样能找到它——守卫就永远不会红（形状 6：取值口径太宽）。
     */
    const verdictAt = flush.indexOf('const verdict = decideOfflineFlush(');
    expect(verdictAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeLessThan(put);
    expect(flush.slice(verdictAt, put), '写这一发没有被算进重试').toContain('retryOnFailure = true;');
  });

  it('冲突那一档不进重试：它等的是用户裁决，不是网络', () => {
    const at = flush.indexOf('if (verdict !== ');
    expect(at).toBeGreaterThan(-1);
    const branch = flush.slice(at, flush.indexOf('return skipped;', at));
    expect(branch).toContain('setFlushConflict(verdict)');
    expect(branch).not.toContain('retryOnFailure = true');
  });

  it('换一条笔记时把「重试用完了」和重试额度一起放掉', () => {
    const at = source.indexOf('const noteIdForFlush = ');
    const effect = source.slice(at, source.indexOf('}, [noteIdForFlush, ownerId]);', at));
    expect(effect, '换笔记没有复位补传状态').toContain('setFlushStalled(null);');
    expect(effect).toContain('flushRetryRef.current = { savedAt: 0, attempts: 0 };');
    // 复位要排在早退之前，否则「没有笔记」那一路会把上一条的状态留着
    expect(effect.indexOf('setFlushStalled(null);')).toBeLessThan(effect.indexOf('if (!noteIdForFlush || !ownerId)'));
  });
});
