import { useEffect, useRef, useState } from 'react';
import { StreamingText, type StreamingMode } from '@/components/streaming';

/**
 * 流式文本动效实验场
 *
 * 访问路径: /_dev/streaming-text-lab
 *
 * 用途:
 * - 设计验收: 直观对比 4 种 mode (blur / wordFade / rise / typewriter)
 * - 接入参考: 演示如何使用 StreamingText 组件
 * - 回归测试: 改动 StreamingText 后人工确认动画无回归
 */

const SAMPLE_SHORT = '阳光散射在空气分子上, 蓝色波长比红色散射得更多, 所以天空看起来是蓝色的。';

const SAMPLE_LONG =
  '流式输出的核心是让用户在等待时也能看到 AI 正在工作。\n\n好的动效应当: 有节奏感, 不让用户焦虑; 不抢戏, 不让用户分心; 一致, 让用户在不同入口感受到同一种品牌质感。\n\nBlur focus 模式选择对每个词做轻微的模糊 -> 清晰过渡, 视觉上像注意力聚焦, 比单纯的 opacity 淡入更有"被读出来"的感觉。';

const MODES: { value: StreamingMode; label: string; desc: string }[] = [
  { value: 'blur', label: 'Blur focus (默认)', desc: '词级 opacity + 模糊聚焦' },
  { value: 'wordFade', label: 'Word fade', desc: '词级 opacity 淡入' },
  { value: 'rise', label: 'Char rise', desc: '词级位移上升' },
  { value: 'typewriter', label: 'Typewriter', desc: '无入场动画, 按上游速率自然出现' },
];

function useFakeStream(fullText: string, speedMs = 35) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const timerRef = useRef<number | null>(null);

  const stop = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setStreaming(false);
  };

  const start = () => {
    stop();
    setText('');
    setStreaming(true);
    let i = 0;
    timerRef.current = window.setInterval(() => {
      // 模拟 LLM token 粒度: 每次推进 1-4 个字符
      const step = 1 + Math.floor(Math.random() * 4);
      i = Math.min(i + step, fullText.length);
      setText(fullText.slice(0, i));
      if (i >= fullText.length) {
        stop();
      }
    }, speedMs);
  };

  useEffect(() => () => stop(), []);

  return { text, streaming, start, stop };
}

function StreamCard({ mode, label, desc, sample }: { mode: StreamingMode; label: string; desc: string; sample: string }) {
  const { text, streaming, start } = useFakeStream(sample);
  useEffect(() => {
    const t = window.setTimeout(start, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 flex flex-col gap-3" style={{ minHeight: 220 }}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-white/90">{label}</div>
          <div className="text-[11px] text-white/50">{desc}</div>
        </div>
        <button
          type="button"
          onClick={start}
          disabled={streaming}
          className="px-2.5 py-1 rounded-md text-[11px] bg-white/5 hover:bg-white/10 disabled:opacity-40 text-white/70 border border-white/10"
        >
          {streaming ? '播放中…' : '重播'}
        </button>
      </div>
      <div className="text-[13px] leading-[1.7] text-white/85 min-h-[120px]">
        <StreamingText text={text} streaming={streaming} mode={mode} />
      </div>
    </div>
  );
}

export default function StreamingTextLab() {
  return (
    <div className="min-h-screen w-full p-8" style={{ background: 'var(--bg-primary, #0b0b10)', color: 'var(--text-primary, #fff)' }}>
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold">流式文本动效实验场 · Streaming Text Lab</h1>
          <p className="text-sm text-white/60 mt-1">
            统一基础设施 <code className="px-1.5 py-0.5 rounded bg-white/5 text-white/80">{'<StreamingText />'}</code>{' '}
            演示与回归。默认 mode = blur, 设计来源 Claude Design (2026-05-13)。
          </p>
        </div>

        <section>
          <div className="text-xs text-white/50 mb-2 uppercase tracking-wider">短文本 (单段)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {MODES.map((m) => (
              <StreamCard key={m.value} mode={m.value} label={m.label} desc={m.desc} sample={SAMPLE_SHORT} />
            ))}
          </div>
        </section>

        <section>
          <div className="text-xs text-white/50 mb-2 uppercase tracking-wider">长文本 (多段落)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <StreamCard mode="blur" label="Blur focus" desc="生产默认值" sample={SAMPLE_LONG} />
            <StreamCard mode="wordFade" label="Word fade" desc="备选" sample={SAMPLE_LONG} />
          </div>
        </section>

        <section>
          <div className="text-xs text-white/50 mb-2 uppercase tracking-wider">说明</div>
          <ul className="text-[13px] text-white/70 space-y-1.5 list-disc pl-5">
            <li>每个词以稳定 offset 作为 React key, 上游文本增长时已渲染的词不会 remount, 不重复触发动画。</li>
            <li>中日韩文按单字切分, 让动画更细腻; 英文按词切。</li>
            <li>已自动遵守 <code>prefers-reduced-motion</code>, 用户在系统偏好关闭动效时直接显示静态终态。</li>
            <li>markdown 场景: 流式期间渲染为纯文本词级动画 (避免每个 chunk 全量 markdown reflow), 完成后切换为最终 markdown 视图。</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
