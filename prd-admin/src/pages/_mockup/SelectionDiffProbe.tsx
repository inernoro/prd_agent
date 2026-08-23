import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { buildInlineDiffBody } from '@/components/doc-browser/selectionDiffMarkup';
import { InlineDiffReviewBar } from '@/components/doc-browser/SelectionRewriteInline';

// 自测专用：把真实的就地 diff 渲染链（buildInlineDiffBody → MarkdownViewer → doc-diff.css）
// 与真实的操作条挂在固定假正文上，用假流替代 SSE，方便无登录情形下直接用 Playwright
// 在真实部署上验证「新增标蓝 / 删除加删除线 / 列表结构不塌 / 双主题都成立」
// （CLAUDE.md §8.1 自测优先，与 InlineCommentOverlayProbe 同一套路）。公开路由，不需要登录。
//
// 覆盖不到的部分（老实说清楚）：划词捕获、选区定位、SSE 与写回落库不在本页，
// 那几段要在登录后的真实知识库文档上验收。

const ORIGINAL = `# 逐句修改自测页

第一阶段建议至少形成以下成果：

1. 《真实工作能力基准标准》，定义任务来源、任务分级、验证方式、入库和退役规则；
2. 《真实任务制作模板》，统一问题说明、代码版本、环境、验收条件、测试和任务元数据；
3. 《能力评价标准》，统一通过、部分通过、失败以及各能力维度的判断方式。

结尾段落逐字保留，用来确认改写没有越界。
`;

const SELECTED = `第一阶段建议至少形成以下成果：

1. 《真实工作能力基准标准》，定义任务来源、任务分级、验证方式、入库和退役规则；
2. 《真实任务制作模板》，统一问题说明、代码版本、环境、验收条件、测试和任务元数据；
3. 《能力评价标准》，统一通过、部分通过、失败以及各能力维度的判断方式。`;

const REWRITTEN = `第一阶段建议至少形成以下可落地成果（从「概念定义」细化到「可执行交付物」）：

1. **《真实工作能力基准标准》V0.1（规则 + 分级体系）**
   - 明确任务来源分类（缺陷 / 需求 / 事故 / 性能 / 重构 / 数据问题）及每类的「可入库条件」
   - 定义任务分级标准（L1-L4），每级对应问题复杂度、依赖范围、是否需要定位能力
2. **《真实任务制作模板》V0.1（结构化任务包规范）**
   - 必须字段：问题背景、目标、代码版本、运行环境、验收标准、隐藏测试说明
   - 可选字段：业务上下文、历史事故说明、性能指标、风险说明
3. **《能力评价标准》V0.1（判定口径）**
   - 通过 / 部分通过 / 失败三档的机器判据，逐维度给出证据要求`;

const RANGE = { start: ORIGINAL.indexOf(SELECTED), end: ORIGINAL.indexOf(SELECTED) + SELECTED.length };

export default function SelectionDiffProbe() {
  const [streamedLen, setStreamedLen] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'review'>('idle');
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const timerRef = useRef<number | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState({ top: 120, left: 80, width: 420, height: 24 });

  const run = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    setStartedAt(Date.now());
    setPhase('streaming');
    setStreamedLen(0);
    timerRef.current = window.setInterval(() => {
      setStreamedLen((n) => {
        const next = n + 6;
        if (next >= REWRITTEN.length) {
          if (timerRef.current) window.clearInterval(timerRef.current);
          timerRef.current = null;
          setPhase('review');
          return REWRITTEN.length;
        }
        return next;
      });
    }, 90);
  }, []);

  useEffect(() => {
    // ?autorun=1：Playwright 打开即开跑，不用先点按钮
    if (new URLSearchParams(window.location.search).get('autorun') === '1') run();
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [run]);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchorRect({ top: r.top + 90, left: r.left + 24, width: 420, height: 24 });
  }, [phase]);

  const diff = useMemo(() => {
    if (phase === 'idle') return null;
    const text = phase === 'streaming' ? `${REWRITTEN.slice(0, streamedLen)}▌` : REWRITTEN;
    return buildInlineDiffBody(ORIGINAL, RANGE, text);
  }, [phase, streamedLen]);

  const toggleTheme = () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 px-6 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <button
          data-testid="probe-run"
          onClick={run}
          className="h-8 px-3 rounded-[10px] text-[12px] font-semibold cursor-pointer"
          style={{ background: 'rgba(168,85,247,0.28)', border: '1px solid rgba(168,85,247,0.5)', color: 'var(--accent-fg-violet-strong)' }}
        >
          模拟一次逐句修改
        </button>
        <button
          data-testid="probe-theme"
          onClick={toggleTheme}
          className="h-8 px-3 rounded-[10px] text-[12px] font-semibold cursor-pointer bg-token-nested border border-token-subtle"
          style={{ color: 'var(--text-secondary)' }}
        >
          切换主题
        </button>
        <span data-testid="probe-phase" className="text-[12px] font-mono" style={{ color: 'var(--text-muted)' }}>
          phase={phase}
        </span>
      </div>

      <div
        ref={anchorRef}
        className={`px-6 py-4${diff ? ' doc-inline-diff' : ''}`}
        style={{ maxWidth: 900 }}
      >
        <MarkdownViewer content={diff ? diff.body : ORIGINAL} />
      </div>

      {diff && phase !== 'idle' && (
        <InlineDiffReviewBar
          anchorRect={anchorRect}
          phase={phase === 'streaming' ? 'streaming' : 'review'}
          model="probe/fake-model"
          added={diff.added}
          removed={diff.removed}
          codeChangeUnmarked={diff.codeChangeUnmarked}
          startedAt={startedAt}
          applying={false}
          onAccept={() => setPhase('idle')}
          onDiscard={() => setPhase('idle')}
          onRetry={run}
          onStop={() => setPhase('review')}
        />
      )}
    </div>
  );
}
