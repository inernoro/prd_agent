/**
 * 录音交付页「设计稿 vs 实现」一致性对照台（开发期取证用，不进产品路由）。
 *
 * 为什么存在：2026-08-25 用户拿线上截图对比设计稿 `MAP 录音转录交付页 v2.dc.html`，
 * 判断「完全不同」。要把这句判断变成可核对的证据，就得让实现在**没有后端**的机器上
 * 也能渲染出录音结果页的两个关键形态，再和设计画板并排截图。
 *
 * 纪律（对齐 .claude/rules/predicate-and-wiring-discipline.md 形状 6：判据要读真正生效的值）：
 *   - 这里渲染的每一个部件都从 `@/components/...` 导入**生产组件本体**，
 *     禁止在本文件里复刻一份长得像的 UI —— 复刻出来的一致性结论毫无意义。
 *   - 只有数据是 mock：台词、说话人、在途 run。文案与配色一律由生产代码决定。
 *
 * 入口：`pnpm dev` 后打开 http://localhost:8000/mock.html
 * 该页不在 `App.tsx` 路由表里，也不是 `vite build` 的入口，产物零影响。
 */
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import { TranscribeStatusCard } from '@/components/doc-browser/TranscribeStatusCard';
import { TranscriptKaraoke } from '@/components/doc-browser/TranscriptKaraoke';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { describeBackgroundTranscriptionBanner } from '@/pages/document-store/recordingVault';
import { RecentEntriesList } from '@/pages/document-store/RecentEntriesList';
import type { RecentDocumentEntry } from '@/services/contracts/documentStore';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';

/**
 * 台词取自设计稿 P1/P2/P3 画板同一段「用户访谈 · 留存与导入」，
 * 保证两边比的是同一份内容，差异只可能来自实现。
 * 高频词（导入 / 等待 / 进度）刻意出现 ≥2 次 —— 词云的 `count >= 2` 判据要求如此，
 * 只出现一次的词不进词云，用一次性台词会把「词云为空」误判成实现缺陷。
 */
const MOCK_NOTE_MD = `# 用户访谈 · 留存与导入

## 摘要

## 结论

导入环节的核心问题是「无反馈的等待」：解析阶段 40 秒空白直接导致用户判定卡死并重开，
是第 7 天留存跌到 41% 的主因。

## 行动项

- [ ] 出导入两步拆分的交互稿
- [ ] 补齐解析阶段的进度埋点
- [x] 再约 3 位重度用户复访

## 转录全文

**[09:41 - 09:47]** [主持人] 你第一次导入的时候，最不确定的是什么？
**[09:58 - 10:05]** [受访者 A] 等待解析那 40 秒，我以为它卡死了。
**[10:12 - 10:18]** [受访者 A] 我通常会直接退出去重开一次。
**[10:35 - 10:41]** [主持人] 如果导入时能看到进度呢？
**[10:52 - 10:58]** [受访者 A] 那我肯定会等，至少知道它在动。
**[11:18 - 11:24]** [主持人] 你会等到多久就放弃？
**[11:35 - 11:43]** [受访者 A] 超过半分钟没有进度，我就当它挂了。
**[12:02 - 12:10]** [受访者 A] 第七天我基本不会再打开，留存就是这么掉的。
**[12:24 - 12:31]** [主持人] 所以进度反馈比速度更要紧？
**[12:40 - 12:48]** [受访者 A] 对，进度反馈到位我就愿意等待。
**[13:05 - 13:12]** [主持人] 导入之后你会先看哪一屏？
**[13:20 - 13:27]** [受访者 A] 先看结果，看不到结果我就重开。
`;

/**
 * 知识库「最近」的 mock 数据。时间用相对当下的偏移生成，
 * 这样「今天 / 昨天 / 更早」三组在任何一天跑都能出齐，截图不会因为跑的日子不同而缺一组。
 */
function buildRecentMock(): RecentDocumentEntry[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const row = (
    title: string, storeName: string, minutesAgo: number, isNew: boolean, contentType: string,
  ): RecentDocumentEntry => ({
    id: title, storeId: 'store-' + title, storeName, title, contentType, tags: [],
    createdAt: at(minutesAgo), updatedAt: at(minutesAgo), isNew,
  });
  return [
    row('录音 2026-08-25 11-46.m4a', '产品研究', 3, true, 'audio/mp4'),
    row('用户访谈 · 留存与导入', '产品研究', 42, true, 'text/markdown'),
    row('report.2026-W34.md', 'MAP系统和设计', 6 * 60, false, 'text/markdown'),
    row('日报-2026-08-24-今日大事早知道', '日报知识库', 26 * 60, true, 'text/markdown'),
    row('竞品拆解 · 导入流程', '产品研究', 3 * 24 * 60, false, 'text/markdown'),
  ];
}

/** 无后端时也要有一条能播的音频：运行时合成 30s 静音 WAV，不往仓库塞二进制。 */
function useSilentWavUrl(seconds: number): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const rate = 8000;
    const frames = rate * seconds;
    const buffer = new ArrayBuffer(44 + frames);
    const view = new DataView(buffer);
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + frames, true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    ascii(36, 'data');
    view.setUint32(40, frames, true);
    for (let i = 0; i < frames; i++) view.setUint8(44 + i, 128); // 8-bit PCM 静音 = 128
    const next = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [seconds]);
  return url;
}

/** 390×844 手机画板，尺寸对齐设计稿 `MAP KNOWLEDGE BASE / VOICE TO NOTE · V2 · 390×844`。 */
function Artboard({ label, note, children }: { label: string; note: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{note}</div>
      <div
        className="flex flex-col overflow-hidden"
        style={{
          width: 390,
          height: 844,
          borderRadius: 38,
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-primary)',
          boxShadow: '0 26px 64px rgba(0,0,0,.16)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function RecordingConsistencyMock() {
  const audioSrc = useSilentWavUrl(30);
  // 走生产的文案判据，而不是在这里手写一句像那样的话
  const banner = useMemo(
    () => describeBackgroundTranscriptionBanner({
      selectedEntryId: 'entry-mock',
      selectedHasFailure: false,
      runs: [{ entryId: 'entry-mock', title: '录音 2026-08-25 11-46.m4a' }],
    }),
    [],
  );

  return (
    <div
      className="flex flex-col gap-9"
      style={{ background: 'var(--bg-base)', minHeight: '100vh', padding: 40 }}
    >
      <div className="flex flex-col gap-2">
        <div className="font-mono text-[12px] tracking-[.16em]" style={{ color: 'var(--text-muted)' }}>
          MAP / RECORDING DELIVERY · IMPLEMENTATION AS-IS · 390×844
        </div>
        <div className="text-[28px] font-bold" style={{ color: 'var(--text-primary)' }}>
          移动端对照台 · 实现现状（mock 数据）
        </div>
        <div className="max-w-[820px] text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          全部画板由生产组件渲染，本文件只提供数据。01 与设计稿
          <code className="mx-1">MAP 录音转录交付页 v2</code>
          的 R4 / P1 / P3 画板逐屏比对；02 是本次新增的知识库「最近」。
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-8">
        <Artboard
          label="A · 处理中（对齐设计稿 R4「结束处理三阶段」）"
          note="三阶段 + 状态四问：音频安不安全 / 在做什么 / 还要多久 / 现在能做什么"
        >
          <div className="flex flex-col gap-3 overflow-y-auto px-3 py-3">
            {banner && (
              <div
                role="status"
                className="flex shrink-0 items-start gap-3 rounded-[14px] px-4 py-3"
                style={{ background: 'var(--semantic-info-bg)', border: '1px solid var(--semantic-info-border)' }}
              >
                <div className="mt-0.5 shrink-0"><MapSpinner size={16} /></div>
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-token-primary">{banner.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-token-muted">{banner.detail}</p>
                </div>
              </div>
            )}
            <TranscribeStatusCard
              currentEntryId="entry-mock"
              activeRun={{
                id: 'run-mock',
                status: 'running',
                phase: '解析音频',
                progress: 35,
                startedAt: new Date(Date.now() - 31_000).toISOString(),
              }}
              onStart={() => undefined}
              onOpenNote={() => undefined}
            />
            {audioSrc && <AudioWavePlayer src={audioSrc} />}
          </div>
        </Artboard>

        <Artboard
          label="F · 失败（对齐设计稿 S5「四字段逐条渲染」）"
          note="原因与 code / 时间 / 仍可用能力 / 下一步"
        >
          <div className="flex flex-col gap-3 overflow-y-auto px-3 py-3">
            <TranscribeStatusCard
              currentEntryId="entry-mock"
              lastFailure={{
                reason: '音频编码不受支持',
                at: new Date(Date.now() - 600_000).toISOString(),
                code: 'ERR_CODEC',
                automaticRetryCount: 3,
                automaticRetryNextAt: null,
              }}
              onStart={() => undefined}
              onOpenNote={() => undefined}
            />
            {audioSrc && <AudioWavePlayer src={audioSrc} />}
          </div>
        </Artboard>

        <Artboard
          label="G · 自动重试中（对齐设计稿 S6）"
          note="倒计时 + 明说无需操作，不给一个点了没用的按钮"
        >
          <div className="flex flex-col gap-3 overflow-y-auto px-3 py-3">
            <TranscribeStatusCard
              currentEntryId="entry-mock"
              lastFailure={{
                reason: '转录暂时不可用',
                at: new Date(Date.now() - 120_000).toISOString(),
                code: 'ASR_UNAVAILABLE',
                automaticRetryCount: 1,
                automaticRetryNextAt: new Date(Date.now() + 8_000).toISOString(),
              }}
              onStart={() => undefined}
              onOpenNote={() => undefined}
            />
            {audioSrc && <AudioWavePlayer src={audioSrc} />}
          </div>
        </Artboard>

        {/*
          接线必须照抄唯一的生产调用方 `FilePreview.tsx:736`：documentMode + onSaveNote + onAskRecording。
          少传 onSaveNote 会让词典入口整块消失（组件里 `onSaveNote ? ... : null`），
          那样截出来的「缺词典入口」是台架自己造的假差异，不是实现的问题。
        */}
        <Artboard
          label="B · 转录后（对应设计稿 P1/P2/P3「台词跟读 + 词云」）"
          note="接线照抄 FilePreview.tsx:736 的生产调用；词云/说话人/搜索/提问均为真实实现"
        >
          <div className="flex-1 overflow-y-auto px-3 py-3" style={{ minHeight: 0 }} data-mock-board="transcribed">
            {audioSrc && (
              <TranscriptKaraoke
                src={audioSrc}
                noteMd={MOCK_NOTE_MD}
                documentMode
                onSaveNote={async () => true}
                onAskRecording={() => undefined}
              />
            )}
          </div>
        </Artboard>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>
          02 · 知识库「最近」
        </div>
        <div className="max-w-[820px] text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          新增标签的内容形态。组件与生产同一份，只有条目数据是 mock。
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-8">
        <Artboard
          label="D · 知识库 → 最近"
          note="跨库时间线：今天 / 昨天 / 更早三组，每条带所属知识库与新增标"
        >
          <div className="flex-1 overflow-y-auto px-3 py-4" style={{ minHeight: 0 }}>
            <RecentEntriesList items={buildRecentMock()} onOpen={() => undefined} />
          </div>
        </Artboard>

        <Artboard label="E · 最近 · 空态" note="空状态必须给引导，不能只写「暂无数据」">
          <div className="flex-1 overflow-y-auto px-3 py-4" style={{ minHeight: 0 }}>
            <RecentEntriesList items={[]} onOpen={() => undefined} />
          </div>
        </Artboard>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<RecordingConsistencyMock />);
