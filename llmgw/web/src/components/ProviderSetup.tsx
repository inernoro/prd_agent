// 接入上游的两块 UI：选平台（预设搜索）与接完之后的自测/模型发现。
//
// 为什么长这样，见 .claude/rules/minimal-user-input.md：
//   1. 地址、协议、并发是系统本来就知道的值 —— 选平台就带出来，不摆输入框；
//   2. 模型清单与价格是上游查得到的 —— 系统去拉，用户勾选，不照抄文档；
//   3. 少填的每一项都欠用户一个交代 —— 所以接完必须能当场测、看得见系统配了什么。
import { useMemo, useState } from 'react';
import type { PlatformTestResult, ProviderPresetItem, UpstreamModelItem, UpstreamModelsData } from '@/lib/types';
import { Button, Chip, InlineAlert, Spinner } from '@/components/ui';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT } from '@/lib/typography';

/** 预设卡片：搜索命中即可选。命中判据同时看名称、key 与别名（中英文/拼音都能搜到）。 */
export function ProviderPresetPicker({
  presets,
  selectedKey,
  onSelect,
}: {
  presets: ProviderPresetItem[];
  selectedKey: string | null;
  onSelect: (preset: ProviderPresetItem | null) => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => filterPresets(presets, query), [presets, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ ...FIELD_LABEL, gap: 5 }}>
        <span>选择上游平台</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索：openai / 硅基流动 / kimi / 本地…"
          style={FIELD_INPUT}
          aria-label="搜索上游平台"
        />
      </label>
      {filtered.length === 0 ? (
        <div style={{ ...HINT_TEXT, padding: '8px 2px' }}>
          没有匹配的内置平台。可以直接用下面的「自定义上游」，自己填地址。
        </div>
      ) : (
        <div style={presetGridStyle}>
          {filtered.map((preset) => {
            const active = preset.key === selectedKey;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => onSelect(active ? null : preset)}
                style={{
                  ...presetCardStyle,
                  borderColor: active ? 'var(--accent-primary)' : 'var(--border-subtle)',
                  background: active ? 'var(--bg-elevated)' : 'var(--bg-surface)',
                }}
              >
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{preset.name}</span>
                <span style={{ ...HINT_TEXT, lineHeight: 1.5 }}>{preset.summary}</span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  <Chip
                    label={preset.platformType === 'claude' ? 'Claude 协议' : 'OpenAI 兼容'}
                    color="var(--text-secondary)"
                    bg="var(--bg-elevated)"
                  />
                  {preset.supportsModelDiscovery ? (
                    <Chip label="可自动拉模型" color="#7aa2ff" bg="rgba(122,162,255,0.14)" />
                  ) : null}
                  {preset.supportsUpstreamPricing ? (
                    <Chip label="价格自动带入" color="#5fd08a" bg="rgba(95,208,138,0.14)" />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <button type="button" onClick={() => onSelect(null)} style={customLinkStyle}>
        列表里没有？用自定义上游（自己填地址）
      </button>
    </div>
  );
}

/**
 * 搜索过滤。刻意做成「大小写无关 + 去空格 + 命中任一别名」——用户想的是「硅基」「kimi」
 * 「本地」这类词，不是我们内部的 key。搜不到就等于这个预设不存在。
 */
export function filterPresets(presets: ProviderPresetItem[], query: string): ProviderPresetItem[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return presets;
  return presets.filter((p) =>
    [p.name, p.key, p.summary, ...(p.searchTerms || [])]
      .filter(Boolean)
      .some((term) => term.toLowerCase().replace(/\s+/g, '').includes(q)),
  );
}

/**
 * 密钥前缀体检。只在「预设声明了前缀、而用户填的明显不是」时提示，
 * 且措辞是提醒不是拦截 —— 供应商换前缀比我们改代码快，判死会误伤。
 */
export function keyPrefixWarning(preset: ProviderPresetItem | null, apiKey: string): string | null {
  const hint = preset?.keyPrefixHint?.trim();
  const value = apiKey.trim();
  if (!hint || !value) return null;
  if (value.toLowerCase().startsWith(hint.toLowerCase())) return null;
  return `${preset!.name} 的密钥通常以 ${hint} 开头，你填的不是。如果确定没错可以直接保存。`;
}

/** 自测结果条：成败、耗时、探测地址、失败时的下一步，一条都不能少。 */
export function TestResultBar({ result }: { result: PlatformTestResult }) {
  return (
    <InlineAlert tone={result.reachable ? 'ok' : 'error'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span>
          {result.message}
          <span style={{ ...HINT_TEXT, marginLeft: 8 }}>耗时 {result.elapsedMs}ms</span>
        </span>
        <span style={{ ...HINT_TEXT, fontFamily: 'var(--font-mono)' }}>探测地址：{result.probedUrl}</span>
        {result.nextStep ? <span style={HINT_TEXT}>下一步：{result.nextStep}</span> : null}
      </div>
    </InlineAlert>
  );
}

/**
 * 上游模型清单 + 勾选导入。
 *
 * 默认勾选规则：**只勾还没导入、且系统推断出了用途的**。
 * 不推断出用途的模型全导进去会得到一批"哑"模型——模型池选型时它们不参与任何用途匹配，
 * 看着像配好了其实用不上（线上现存 11/17 个模型正是这个状态）。所以让用户显式决定。
 */
export function UpstreamModelPicker({
  data,
  busy,
  onImport,
  onCancel,
}: {
  data: UpstreamModelsData;
  busy: boolean;
  onImport: (selected: UpstreamModelItem[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(data.items));
  const [onlyNew, setOnlyNew] = useState(true);
  /*
    名录外模型默认勾不动：它们的用途只能靠模型名猜，猜错了照样入池、被调度到，
    用户看到的就是「一请求就报错」。要用得管理员在这里明确放行一次（这个动作进审计），
    而不是让系统替他赌一把。
  */
  const [allowOutside, setAllowOutside] = useState(false);

  const visible = onlyNew ? data.items.filter((m) => !m.alreadyImported) : data.items;
  const isBlocked = (m: UpstreamModelItem) => !m.inCatalog && !allowOutside;
  const selectable = visible.filter((m) => !m.alreadyImported && !isBlocked(m));
  const selectedCount = selectable.filter((m) => selected.has(m.modelId)).length;
  // 用户可以手动继续勾，勾过上限就在按钮上拦住并说清怎么办，别等服务端甩个 400 回来
  const overBatchLimit = selectedCount > MAX_IMPORT_BATCH;
  const eligibleCount = data.items.filter((m) => !m.alreadyImported && m.inCatalog).length;
  const outsideCount = data.items.filter((m) => !m.alreadyImported && !m.inCatalog).length;

  function toggle(modelId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>
          上游共 {data.truncatedFromTotal ?? data.total} 个模型
          {data.truncatedFromTotal ? `（过多，只展示前 ${data.total} 个）` : ''}
        </span>
        <span style={HINT_TEXT}>已导入 {data.alreadyImportedCount} 个</span>
        <Chip
          label={data.pricingProvided ? '价格取自上游' : '上游未提供价格'}
          color={data.pricingProvided ? '#5fd08a' : 'var(--text-muted)'}
          bg={data.pricingProvided ? 'rgba(95,208,138,0.14)' : 'var(--bg-elevated)'}
          title={data.pricingProvided
            ? '导入时会一并写入价格，无需手填'
            : '这个上游的模型列表接口没有返回价格，导入后价格保持“未知”，可以稍后在模型页补'}
        />
        <label style={checkRowStyle}>
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
          只看未导入
        </label>
        {outsideCount > 0 ? (
          <label style={checkRowStyle} title="名录外模型的用途只能按模型名猜；放行后请到模型页逐个核对用途，这个动作会记进审计">
            <input
              type="checkbox"
              checked={allowOutside}
              onChange={(e) => {
                setAllowOutside(e.target.checked);
                // 关掉放行时，把已经勾上的名录外模型一并撤掉——否则界面显示「不可选」，
                // 提交时却仍然带着它们，是最典型的「看到的和发出去的不一致」。
                if (!e.target.checked) {
                  const outside = new Set(data.items.filter((m) => !m.inCatalog).map((m) => m.modelId));
                  setSelected((prev) => new Set([...prev].filter((id) => !outside.has(id))));
                }
              }}
            />
            放行名录外的 {outsideCount} 个
          </label>
        ) : null}
        {/* 来源 + 时间一起给：面板可能开着不动，用户得能分辨手上这份报价是刚拉的还是很久以前的
            （minimal-user-input 第 2 条：拉回来的值要标来源与时间） */}
        <span style={{ marginLeft: 'auto', ...HINT_TEXT, fontFamily: 'var(--font-mono)' }}>
          {data.probedUrl} · {formatFetchedAt(data.fetchedAt)}
        </span>
      </div>

      <div style={modelListStyle}>
        {visible.map((m) => {
          const blocked = isBlocked(m);
          const disabled = m.alreadyImported || blocked;
          return (
            <label
              key={m.modelId}
              style={{ ...modelRowStyle, opacity: disabled ? 0.55 : 1 }}
              title={blocked ? '不在内置名录里：用途只能按模型名猜，先在上面打开「放行名录外的」再选' : undefined}
            >
              <input
                type="checkbox"
                disabled={disabled}
                checked={!disabled && selected.has(m.modelId)}
                onChange={() => toggle(m.modelId)}
              />
              <span style={{ fontFamily: 'var(--font-mono)', minWidth: 0, overflowWrap: 'anywhere' }}>{m.modelId}</span>
              <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginLeft: 'auto' }}>
                {m.alreadyImported ? <Chip label="已导入" color="var(--text-muted)" bg="var(--bg-elevated)" /> : null}
                {/* 用途是查出来的还是猜出来的，必须一眼分得清——它决定了用户要不要去核对 */}
                {m.inCatalog ? (
                  <Chip
                    label="名录内"
                    color="#5fd08a"
                    bg="rgba(95,208,138,0.14)"
                    title={`内置名录登记：${m.catalogDisplayName || m.modelId}${m.catalogVendor ? ` · ${m.catalogVendor}` : ''}。用途是查出来的事实，不是猜的`}
                  />
                ) : (
                  <Chip label="名录外" color="#e0b341" bg="rgba(224,179,65,0.14)" title="不在内置名录里，用途只能按模型名猜；要用得显式放行并自行核对" />
                )}
                {m.requiresImageInput ? (
                  <Chip label="必须给图" color="#7aa2ff" bg="rgba(122,162,255,0.14)" title="这个模型没有图片就调不动，界面会要求先给图再放行发送" />
                ) : null}
                {m.inferredCapabilities.length > 0 ? (
                  m.inferredCapabilities.map((c) => (
                    <Chip
                      key={c}
                      label={capabilityLabel(c)}
                      color={m.capabilitySource === 'guess' ? 'var(--text-muted)' : '#7aa2ff'}
                      bg={m.capabilitySource === 'guess' ? 'var(--bg-elevated)' : 'rgba(122,162,255,0.14)'}
                      title={capabilitySourceHint(m.capabilitySource)}
                    />
                  ))
                ) : (
                  <Chip label="用途待定" color="var(--text-muted)" bg="var(--bg-elevated)" title="推断不出来，导入后需要到模型页手动勾选用途" />
                )}
                {m.priceSource ? (
                  <Chip
                    label={formatPrice(m)}
                    color="#5fd08a"
                    bg="rgba(95,208,138,0.14)"
                    title="取自上游模型列表接口"
                  />
                ) : null}
              </span>
            </label>
          );
        })}
        {visible.length === 0 ? <div style={{ ...HINT_TEXT, padding: 10 }}>没有可显示的模型。</div> : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || selectedCount === 0 || overBatchLimit}
          onClick={() => onImport(selectable.filter((m) => selected.has(m.modelId)))}
        >
          {busy ? <Spinner size={14} /> : null}
          {busy ? '导入中…' : `导入选中的 ${selectedCount} 个模型`}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>关闭</Button>
        {overBatchLimit ? (
          <span style={HINT_TEXT}>一次最多导入 {MAX_IMPORT_BATCH} 个，请取消一些再导，剩下的分批来。</span>
        ) : (
          <span style={HINT_TEXT}>
            默认只勾了名录内的模型——它们的用途是查出来的事实。名录外的用途只能按模型名猜，猜错了入池后一请求就报错。
            {outsideCount > 0 ? `这个上游有 ${outsideCount} 个不在名录里，确实要用就打开上面的放行。` : ''}
            {eligibleCount > MAX_IMPORT_BATCH ? `可导的有 ${eligibleCount} 个，超过单批上限，已先勾前 ${MAX_IMPORT_BATCH} 个，导完再来一轮。` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 服务端一次最多导入多少个（`MaxImportBatch`，Program.cs）。超出直接 400。
 * 前端必须知道这个数——不知道就会出现「默认全勾好、一点就失败」。
 */
export const MAX_IMPORT_BATCH = 200;

/**
 * 默认选中：未导入 + 推断出了用途，**并且不超过单批上限**。
 *
 * 上限这一截是必须的：OpenRouter 这类聚合方一次返回四百多个模型，全勾上再点导入
 * 必然撞 400，用户得手动取消几百行才能继续——默认路径本身就是坏的。
 * 判据独立成函数，便于单测钉住。
 */
export function defaultSelection(items: UpstreamModelItem[]): Set<string> {
  // 默认只勾名录内的：名录外模型的用途是猜的，默认勾上等于替用户赌一把。
  const eligible = items.filter((m) => !m.alreadyImported && m.inCatalog);
  return new Set(eligible.slice(0, MAX_IMPORT_BATCH).map((m) => m.modelId));
}

/** 用途来源的人话说明。猜出来的必须说清是猜的，用户才知道要不要去核对。 */
export function capabilitySourceHint(source: string): string {
  if (source === 'catalog') return '取自内置名录：这是登记在案的事实，不是猜的';
  if (source === 'upstream') return '上游自己声明的用途';
  return '按模型标识猜的，导入后请到模型页核对；猜错会导致这个模型进池后一请求就报错';
}

/** 拉取时间的可读表达。拿不到就如实说「时间未知」，不编一个当前时间冒充新鲜度。 */
export function formatFetchedAt(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return '拉取时间未知';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '拉取时间未知';
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return '刚刚拉取';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前拉取`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前拉取`;
  return `${at.toLocaleDateString()} 拉取`;
}

export function formatPrice(m: UpstreamModelItem): string {
  const cur = m.priceCurrency || 'USD';
  const parts: string[] = [];
  if (m.inputPricePerMillion != null) parts.push(`入 ${trimNumber(m.inputPricePerMillion)}`);
  if (m.outputPricePerMillion != null) parts.push(`出 ${trimNumber(m.outputPricePerMillion)}`);
  if (parts.length === 0 && m.pricePerCall != null) parts.push(`每次 ${trimNumber(m.pricePerCall)}`);
  return parts.length === 0 ? '价格已带入' : `${parts.join(' / ')} ${cur}/百万`;
}

/** 价格量级跨度极大（0.02 到 75），定点小数会把小额显示成 0.00，故按量级选精度。 */
export function trimNumber(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1) return String(Math.round(value * 100) / 100);
  if (Math.abs(value) >= 0.01) return String(Math.round(value * 10000) / 10000);
  return value.toPrecision(2);
}

const CAPABILITY_LABELS: Record<string, string> = {
  chat: '对话',
  intent: '意图识别',
  vision: '图片理解',
  image_generation: '图片生成',
  video_generation: '视频生成',
  embedding: '向量嵌入',
  rerank: '重排',
  asr: '语音识别',
  tts: '语音合成',
  code: '代码',
  'long-context': '长文本',
};
export function capabilityLabel(code: string): string {
  return CAPABILITY_LABELS[code] || code;
}

const presetGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
  gap: 8,
  maxHeight: 260,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  padding: 2,
};

const presetCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  textAlign: 'left',
  padding: '10px 12px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 'var(--fs-secondary)',
};

const customLinkStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  background: 'none',
  border: 'none',
  padding: '2px 0',
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-caption)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

const modelListStyle: React.CSSProperties = {
  maxHeight: 340,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-surface)',
};

const modelRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  borderBottom: '1px solid var(--border-subtle)',
  fontSize: 'var(--fs-secondary)',
  cursor: 'pointer',
};

const checkRowStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--fs-secondary)',
  color: 'var(--text-secondary)',
};
