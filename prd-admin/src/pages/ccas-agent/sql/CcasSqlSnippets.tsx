import { useEffect, useMemo, useState } from 'react';
import { Copy, Search, Info, BookOpen } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  DIALECT_LABEL,
  SQL_SNIPPET_GROUPS,
  SQL_SNIPPET_TOTAL,
  type SqlDialect,
  type SqlSnippet,
  type SqlSnippetGroup,
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

interface SnippetWithGroup extends SqlSnippet {
  groupId: string;
  groupName: string;
}

/**
 * 常用 SQL 语句库子 tab —— 左侧目录 + 右侧详情布局。
 *
 * 行为：
 *   - 搜索框 case-insensitive 过滤左侧目录（匹配标题 / 备注 / SQL 内容）
 *   - 默认选中第一条；搜索结果不含当前选中时自动跳到首条匹配
 *   - 左右两栏独立滚动，互不打架；移动端折叠为「上目录 + 下详情」
 *   - 详情区右上角「复制 SQL」按钮 + 代码块 `tabSize:2 + overflow-x:auto`
 *   - 纯静态数据，零后端、零持久化
 */
export function CcasSqlSnippets() {
  const [keyword, setKeyword] = useState('');
  const firstSnippetId = SQL_SNIPPET_GROUPS[0]?.snippets[0]?.id ?? '';
  const [selectedId, setSelectedId] = useState<string>(firstSnippetId);

  const allSnippets = useMemo<SnippetWithGroup[]>(
    () =>
      SQL_SNIPPET_GROUPS.flatMap((g) =>
        g.snippets.map((s) => ({ ...s, groupId: g.id, groupName: g.name }))
      ),
    []
  );

  const filteredGroups = useMemo<SqlSnippetGroup[]>(() => {
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

  useEffect(() => {
    if (!keyword.trim()) return;
    const visibleIds = new Set(filteredGroups.flatMap((g) => g.snippets.map((s) => s.id)));
    if (!visibleIds.has(selectedId) && filteredGroups.length > 0) {
      setSelectedId(filteredGroups[0].snippets[0].id);
    }
  }, [filteredGroups, selectedId, keyword]);

  const selected = useMemo(
    () => allSnippets.find((s) => s.id === selectedId) ?? allSnippets[0],
    [allSnippets, selectedId]
  );

  const handleCopy = async (snippet: SqlSnippet) => {
    try {
      await navigator.clipboard.writeText(snippet.sql);
      toast.success(`已复制「${snippet.title}」`);
    } catch {
      toast.error('复制失败', '请手动选中代码块文本复制');
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <div className="shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-white/55 leading-relaxed">
          团队公认的 CCAS 排查 SQL 集合，按数据库版本分组。点左侧目录浏览，右上角一键复制。
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

      <div className="shrink-0 text-[11px] text-white/40">
        共 {SQL_SNIPPET_TOTAL} 条预设
        {keyword.trim() && (
          <span>
            ，当前匹配 <span className="text-amber-300/85">{matchedCount}</span> 条
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-0 rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
        <aside
          className="shrink-0 md:w-64 lg:w-72 max-h-60 md:max-h-full md:border-r border-b md:border-b-0 border-white/8 bg-white/[0.015]"
          style={{ overflowY: 'auto', minHeight: 0 }}
        >
          {filteredGroups.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-white/40">
              没有匹配的语句
            </div>
          ) : (
            <nav className="py-2">
              {filteredGroups.map((group) => (
                <div key={group.id} className="px-2 pb-2">
                  <div className="px-2 pt-1.5 pb-1 text-[10.5px] uppercase tracking-wider text-white/40 font-semibold">
                    {group.name}
                  </div>
                  <ul className="flex flex-col">
                    {group.snippets.map((s) => {
                      const isActive = s.id === selectedId;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(s.id)}
                            data-active={isActive}
                            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs text-white/75 hover:text-white hover:bg-white/[0.06] data-[active=true]:bg-amber-300/12 data-[active=true]:text-amber-200 data-[active=true]:font-medium transition flex items-center gap-2"
                          >
                            <span
                              aria-hidden
                              className="w-1 h-3.5 rounded-sm shrink-0"
                              style={{ background: isActive ? 'rgba(252, 211, 77, 0.85)' : 'transparent' }}
                            />
                            <span className="truncate">{s.title}</span>
                            <span className="ml-auto shrink-0">
                              <DialectBadge dialect={s.dialect} />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          )}
        </aside>

        <div className="flex-1 min-h-0" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {selected ? (
            <article className="flex flex-col">
              <header className="sticky top-0 z-10 px-4 py-3 border-b border-white/8 bg-[#0f1014]/95 backdrop-blur flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <h3 className="text-sm font-semibold text-white/95 truncate">{selected.title}</h3>
                  <DialectBadge dialect={selected.dialect} />
                  <span className="text-[10.5px] text-white/40 truncate">· {selected.groupName}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(selected)}
                  className="shrink-0 inline-flex items-center gap-1 h-7 px-3 rounded-md text-xs text-amber-200 border border-amber-300/35 bg-amber-300/10 hover:bg-amber-300/20 hover:border-amber-300/55 transition"
                  title="复制 SQL 到剪贴板"
                >
                  <Copy className="w-3 h-3" />
                  复制 SQL
                </button>
              </header>

              {selected.note && (
                <div className="px-4 py-2 text-[11.5px] text-white/55 flex items-start gap-1.5 border-b border-white/6 bg-white/[0.01]">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-300/60" />
                  <span>{selected.note}</span>
                </div>
              )}

              <pre
                className="text-[13px] leading-[1.65] text-white/90 font-mono px-4 py-4 m-0 overflow-x-auto"
                style={{ tabSize: 2 }}
              >
                <code>{selected.sql}</code>
              </pre>
            </article>
          ) : (
            <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center gap-2 text-white/40 px-6">
              <BookOpen className="w-6 h-6" />
              <div className="text-xs">从左侧目录选一条 SQL 查看</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
