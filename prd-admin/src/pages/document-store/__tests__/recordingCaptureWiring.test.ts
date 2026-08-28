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
    expect(SOCKET).toContain('onRetryScheduled');
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
    expect(SHEET).not.toContain('后重试`');
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
  it('写分片失败时读返回值把状态翻掉，而不是只挂一个接不到的 catch', () => {
    expect(sheet).toContain('.then((ok) => { if (!ok) setVaultPersisted(false); })');
  });

  it('建会话失败同样读返回值', () => {
    expect(sheet).toContain('.then((ok) => { if (!ok) setVaultPersisted(false); }).catch(');
  });

  it('这个状态真的传给了 describeCaptureChips', () => {
    const call = sheet.slice(sheet.indexOf('describeCaptureChips({'));
    expect(call.slice(0, 260)).toContain('vaultPersisted,');
  });
});

