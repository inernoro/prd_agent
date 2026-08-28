/**
 * 录音采集屏的接线守卫。
 *
 * 采集屏那几行字全都挂着真实数量（本机存了多少、传了多少、停在第几句、
 * 还有几秒重试）。判据抽进 `recordingCaptureView.ts` 之后，最容易发生的退化
 * 不是算错，而是**面板绕过它自己又算一遍**，或者判据建好了根本没人调用
 * （predicate-and-wiring-discipline 形状 2/3）。这两种都编译得过、全量测试全绿。
 *
 * 所以这里断言的是「接线这件事本身」：每个判据都有面板在用，
 * 倒计时确实由 socket 的排期驱动，而不是面板自己拍一个数。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, '..');
const SHEET = fs.readFileSync(path.join(DIR, 'RecordAudioSheet.tsx'), 'utf8');
const SOCKET = fs.readFileSync(path.join(DIR, 'liveTranscription.ts'), 'utf8');

describe('采集屏的每个判据都真的有人在调用', () => {
  it.each([
    ['describeCaptureChips', '已保护 / 本机已存 / 实时上传三块凭据'],
    ['describeLiveTranscriptTitle', '实时原文卡的标题（正常 / 已停在 N 句 / 不可用）'],
    ['advanceLiveSentenceLog', '逐句时刻，展开列表左边那一列时间'],
    ['describeRetryCountdown', '「N 秒后重试」'],
  ])('%s 被采集面板调用（否则 %s 是画上去的）', (symbol) => {
    expect(SHEET).toContain(`${symbol}(`);
  });
});

describe('倒计时由真实排期驱动，不是面板自己拍的数', () => {
  it('socket 在排下一次重连时把时刻回调出去', () => {
    /*
     * 判据要认「真的调了」，不能认「这个名字出现过」：它是构造器参数属性，
     * 声明那一行本身就含这个词，删光所有调用点用例照样绿（对抗审查 A6）。
     */
    const calls = SOCKET.match(/this\.onRetryScheduled\(/g) ?? [];
    expect(calls.length, 'socket 里没有任何一处真的回调重连时刻').toBeGreaterThanOrEqual(2);
    // 退避时长走共享判据，不在 socket 里再写一份常量
    expect(SOCKET).toContain('liveTranscriptionRetryDelayMs(');
  });

  it('面板把第五个回调接上了（不接就永远没有倒计时）', () => {
    const start = SHEET.indexOf('new LiveTranscriptionSocket(');
    expect(start, '面板里找不到实时转写连接').toBeGreaterThanOrEqual(0);
    const call = SHEET.slice(start, SHEET.indexOf('socket.connect()', start));
    expect(call).toContain('setLiveRetryAt');
  });

  it('没有排期时不显示倒计时——这条由纯函数兜底，面板不许自己造一个默认值', () => {
    /*
     * 此前钉的是「反引号」这一种写法，换成 JSX 文本就绕开了（对抗审查 A5）。
     * 改为认「面板里有没有自己算秒数」：倒计时只能来自共享判据。
     */
    expect(SHEET).toContain('describeRetryCountdown(');
    // 自己拿排期时刻做减法再除以 1000 —— 那就是在面板里另造一份倒计时
    expect(SHEET).not.toMatch(/liveRetryAt[^\n]*-[^\n]*\/\s*1000/);
    expect(SHEET).not.toMatch(/Math\.ceil\([^\n]*1000\)[^\n]*秒后/);
  });
});

/*
 * 接线：判据有了「落没落住」这一路，但没人把真实的失败喂给它，它就永远是 true——
 * 界面照样替一件没发生的事作保（predicate-and-wiring-discipline 形状 2）。
 */
describe('本机保险箱失败要接到凭据上', () => {
  const sheet = fs.readFileSync(
    path.resolve(__dirname, '../RecordAudioSheet.tsx'),
    'utf-8',
  );

  /*
   * 注意判据取的是什么：vault 那两个函数失败时**返回 false 而不是抛**，
   * 所以「有没有挂 .catch」证明不了任何事——上一版守卫钉的正是那句 catch，
   * 它绿着，而 setVaultPersisted 从来没被调用过（形状 8：拿一份不成立的声明当证据）。
   * 判据必须认「读了返回值」。
   */
  /*
   * 判据必须**分别定位到各自的调用点**。此前两条都是全文件搜同一句字面串，而那句
   * 在文件里出现三次（切库 / 建会话 / 写分片）——删掉写分片那一处，用例照样绿
   * （对抗审查 A2：一条命中就够，等于谁都没守住）。
   */
  it.each([
    ['写分片', 'vaultAppendChunk('],
    ['建会话', 'vaultStartSession('],
    ['切归属库', 'vaultUpdateSessionStore('],
  ])('%s 失败时读返回值把凭据翻掉，而不是只挂一个接不到的 catch', (_name, callee) => {
    const at = sheet.indexOf(callee);
    expect(at, `找不到 ${callee} 的调用点`).toBeGreaterThanOrEqual(0);
    // 只看这一处调用之后的一小段：降级必须挂在它自己的链上
    const chain = sheet.slice(at, at + 420);
    expect(chain).toMatch(/if \(!ok\) setVaultPersisted\(false\)/);
  });

  it('这个状态真的传给了 describeCaptureChips', () => {
    const call = sheet.slice(sheet.indexOf('describeCaptureChips({'));
    expect(call.slice(0, 260)).toContain('vaultPersisted,');
  });
});

/*
 * 本机保险箱里的分片存在哪个库下，决定了恢复弹窗会不会把这段录音端到用户面前
 * （它按 storeId 过滤）。两处都容易存错，而且错了全程静默：
 *   - 建会话时盖的是路由那个库，可用户在按录音之前就把目的地改掉是常态；
 *   - 切库时裸发更新，抢在建会话前面跑就找不到那条会话记录，静默 no-op。
 * 两种都表现为「用户在自己选的库里看不到刚录的那段」——像丢了（Codex 第十八轮 P2）。
 */
describe('本机保险箱的分片存进用户选的那个库', () => {
  const sheet = fs.readFileSync(
    path.resolve(__dirname, '../RecordAudioSheet.tsx'),
    'utf-8',
  );

  it('建会话盖的是当前选中的库，不是路由参数', () => {
    const call = sheet.slice(sheet.indexOf('vaultStartSession('));
    const args = call.slice(0, call.indexOf(')'));
    expect(args).toContain('targetStoreIdRef.current');
  });

  it('切库的更新排在写队列上，不是裸发', () => {
    const fn = sheet.slice(sheet.indexOf('const changeDestination = useCallback'));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/(void|await)\s+vaultUpdateSessionStore\(/);
    const chained = body.slice(body.indexOf('vaultWriteQueueRef.current'));
    expect(chained.slice(0, 500)).toContain('vaultUpdateSessionStore(');
  });

  /*
   * 三个 vault 写口径必须一致：都返回成败、调用方都读返回值。改归属库这一路此前
   * 返回 void，写失败被吞掉，凭据仍然说「已保护」——而分片其实留在旧库下
   * （Codex 第十九轮 P2）。
   */
  it('改归属库失败同样读返回值，凭据跟着降级', () => {
    const fn = sheet.slice(sheet.indexOf('const changeDestination = useCallback'));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    const call = body.indexOf('vaultUpdateSessionStore(');
    expect(call).toBeGreaterThan(0);
    expect(body.slice(call)).toContain('if (!ok) setVaultPersisted(false);');
  });

  it('vault 那一侧真的把成败报出来了（不是 Promise<void>）', () => {
    const vault = fs.readFileSync(
      path.resolve(__dirname, '../recordingVault.ts'),
      'utf-8',
    );
    expect(vault).toContain('vaultUpdateSessionStore(id: string, storeId: string): Promise<boolean>');
  });
});

