import { useCallback, useMemo, useState } from 'react';
import { Copy, Search, Info } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  DIALECT_LABEL,
  SQL_SNIPPET_GROUPS,
  SQL_SNIPPET_TOTAL,
  type SqlDialect,
  type SqlSnippet,
} from './sqlSnippetsData';

const DIALECT_TONE: Record<SqlDialect, { bg: string; border: string; fg: string }> = {
  mssql: {
    bg: 'rgba(99, 102, 241, 0.12)',
    border: 'rgba(99, 102, 241, 0.35)',
    fg: 'rgba(165, 180, 252, 0.95)',
  },
  mysql: {
    bg: 'rgba(56, 189, 248, 0.12)',
    border: 'rgba(56, 189, 248, 0.35)',
    fg: 'rgba(125, 211, 252, 0.95)',
  },
  'mssql+mysql': {
    bg: 'rgba(244, 114, 182, 0.12)',
    border: 'rgba(244, 114, 182, 0.35)',
    fg: 'rgba(249, 168, 212, 0.95)',
  },
};

function DialectBadge({ dialect }: { dialect: SqlDialect }) {
  const tone = DIALECT_TONE[dialect];
  return (
    <span
      className="inline-flex items-center text-[10px] leading-none px-1.5 py-1 rounded-md border font-medium tracking-wide"
      style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
    >
      {DIALECT_LABEL[dialect]}
    </span>
  );
}

function SnippetCard({ snippet }: { snippet: SqlSnippet }) {
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet.sql);
      toast.success(`已复制「${snippet.title}」`);
    } catch {
      toast.error('复制失败', '请手动选中代码块文本复制');
    }
  }, [snippet]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
      <div className="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-white/8 bg-white/[0.02]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-white/90 truncate">{snippet.title}</span>
          <DialectBadge dialect={snippet.dialect} />
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs text-white/75 hover:text-amber-200 border border-white/12 hover:border-amber-300/40 bg-white/5 hover:bg-amber-300/10 transition"
          title="复制 SQL 到剪贴板"
        >
          <Copy className="w-3 h-3" />
          复制
        </button>
      </div>

      {snippet.note && (
        <div className="px-4 py-2 text-[11.5px] text-white/55 flex items-start gap-1.5 border-b border-white/6 bg-white/[0.01]">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300/60" />
          <span>{snippet.note}</span>
        </div>
      )}

      <pre
        className="text-[12.5px] leading-[1.6] text-white/85 font-mono px-4 py-3 m-0 overflow-x-auto"
        style={{ tabSize: 2 }}
      >
        <code>{snippet.sql}</code>
      </pre>
    </div>
  );
}

/**
 * 常用 SQL 语句库子 tab —— 内置预设按数据库版本分组展示。
 *
 * 行为：
 *   - 顶部搜索框过滤（匹配片段标题 / 备注 / SQL 内容，case-insensitive）
 *   - 每个分组展示组名 + 组说明 + 该组所有片段卡片
 *   - 每张卡：标题 + 方言徽章 + 复制按钮 + 备注 + SQL 代码块
 *   - 纯静态数据，零后端、零持久化
 */
export function CcasSqlSnippets() {
  const [keyword, setKeyword] = useState('');

  const filteredGroups = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return SQL_SNIPPET_GROUPS;
    return SQL_SNIPPET_GROUPS
      .map((g) => ({
        ...g,
        snippets: g.snippets.filter((s) => {
          const hay = `${s.title} ${s.note ?? ''} ${s.sql}`.toLowerCase();
          return hay.includes(k);
        }),
      }))
      .filter((g) => g.snippets.length > 0);
  }, [keyword]);

  const matchedCount = filteredGroups.reduce((acc, g) => acc + g.snippets.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-white/55 leading-relaxed">
          团队公认的 CCAS 排查 SQL 集合，按数据库版本分组。点「复制」即可粘贴到 Navicat / DBeaver / SSMS 执行。
        </p>
        <div className="relative shrink-0 w-full sm:w-72">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索标题 / 备注 / SQL 内容"
            className="w-full h-8 pl-7 pr-2.5 rounded-md border border-white/10 bg-white/[0.04] text-xs text-white/85 placeholder:text-white/35 focus:outline-none focus:border-amber-300/40 transition"
          />
        </div>
      </div>

      <div className="text-[11px] text-white/40">
        共 {SQL_SNIPPET_TOTAL} 条预设
        {keyword.trim() && <span>，当前匹配 <span className="text-amber-300/85">{matchedCount}</span> 条</span>}
      </div>

      {filteredGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/12 bg-white/[0.02] px-6 py-10 text-center text-sm text-white/45">
          没有匹配「{keyword.trim()}」的语句
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {filteredGroups.map((group) => (
            <section key={group.id} className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-white/90">{group.name}</h3>
                {group.description && (
                  <p className="text-[11.5px] text-white/50 leading-relaxed">{group.description}</p>
                )}
              </div>
              <div className="flex flex-col gap-3">
                {group.snippets.map((s) => (
                  <SnippetCard key={s.id} snippet={s} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
