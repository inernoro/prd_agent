import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import { Search, ArrowRight, CornerDownLeft, Command, Pin, Check } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useNavOrderStore, NAV_DIVIDER_KEY } from '@/stores/navOrderStore';
import {
  getUnifiedNavCatalog,
  matchKeywordScore,
  NAV_SECTION_LABELS,
  NAV_SECTION_ORDER,
  type NavCatalogItem,
} from '@/lib/unifiedNavCatalog';

function getIcon(name: string | undefined, size = 16) {
  if (!name) return <LucideIcons.Circle size={size} />;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Comp = (LucideIcons as any)[name];
  if (Comp) return <Comp size={size} />;
  return <LucideIcons.Circle size={size} />;
}

function normalize(s: string): string {
  return (s || '').toLowerCase().trim();
}

/**
 * 全局命令面板 (⌘/Ctrl + K)
 * - 统一搜索 BUILTIN_TOOLS (智能体) + 后端菜单目录 (菜单)
 * - 键盘操作：↑↓ 导航 / Enter 进入 / ESC 关闭
 * - 遵守 frontend-modal 3 硬约束: createPortal + inline style 高度 + min-h:0
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const menuCatalog = useAuthStore((s) => s.menuCatalog);
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);

  // 全局快捷键监听
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        // 避免在 CodeMirror 等内置搜索里被拦截
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 打开时聚焦输入框 & 重置
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  const allItems: NavCatalogItem[] = useMemo(
    () => getUnifiedNavCatalog({ menuCatalog, permissions, isRoot, includeShortcuts: true }),
    [isRoot, menuCatalog, permissions],
  );

  // 过滤 + 排序
  const filtered = useMemo(() => {
    const q = normalize(query);
    const scored = allItems
      .map((it) => ({ it, s: matchKeywordScore(q, it.keywords) }))
      .filter((x) => x.s > 0);

    // 同分项按 section 顺序稳定排序
    scored.sort((a, b) => b.s - a.s);

    // 按 section 稳定分组（顺序：快捷操作 → 智能体 → 百宝箱 → 实用工具 → 基础设施 → 其他菜单）
    const grouped = NAV_SECTION_ORDER.map((sec) => ({
      section: sec,
      label: NAV_SECTION_LABELS[sec],
      items: scored.filter((x) => x.it.section === sec).map((x) => x.it),
    })).filter((g) => g.items.length > 0);

    return grouped;
  }, [allItems, query]);

  // 扁平列表（用于 ↑↓ 键）
  const flat = useMemo(() => filtered.flatMap((g) => g.items), [filtered]);

  // 游标保护
  useEffect(() => {
    if (cursor >= flat.length) setCursor(Math.max(0, flat.length - 1));
  }, [flat.length, cursor]);

  // 确保选中项可见
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const navOrder = useNavOrderStore((s) => s.navOrder);
  const navHidden = useNavOrderStore((s) => s.navHidden);
  const setNavLayout = useNavOrderStore((s) => s.setNavLayout);

  const pinnedSet = useMemo(
    () => new Set(navOrder.filter((k) => k !== NAV_DIVIDER_KEY)),
    [navOrder],
  );

  const handleSelect = useCallback(
    (target: NavCatalogItem) => {
      setOpen(false);
      navigate(target.route);
    },
    [navigate],
  );

  const handlePin = useCallback(
    (target: NavCatalogItem) => {
      // 已在导航中则不重复添加
      if (pinnedSet.has(target.id)) return;
      // 直接追加到末尾，逻辑与设置页 appendFromPool 一致
      const filteredHidden = navHidden.filter((k) => k !== target.id);
      setNavLayout({ navOrder: [...navOrder, target.id], navHidden: filteredHidden });
    },
    [navHidden, navOrder, pinnedSet, setNavLayout],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(flat.length - 1, c + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const picked = flat[cursor];
        if (!picked) return;
        // ⌘/Ctrl+Enter 加入导航；普通 Enter 跳转
        if (e.metaKey || e.ctrlKey) {
          handlePin(picked);
        } else {
          handleSelect(picked);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    },
    [cursor, flat, handlePin, handleSelect],
  );

  if (!open) return null;

  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');

  return createPortal(
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
        animation: 'cmdPaletteFade 160ms ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(680px, 94vw)',
          maxHeight: '70vh',
          height: 'auto',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 16,
          overflow: 'hidden',
          background: 'linear-gradient(180deg, rgba(22,22,28,0.98), rgba(15,16,20,0.98))',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 40px 120px -30px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)',
          animation: 'cmdPaletteSlide 200ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <Search size={16} style={{ color: 'rgba(255,255,255,0.5)' }} />
          <input
            ref={inputRef}
            data-tour-id="command-palette-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="搜索智能体、菜单、快捷操作…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary, #fff)',
              fontSize: 15,
              lineHeight: 1.4,
            }}
          />
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: 'rgba(255,255,255,0.4)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
            title="按 ESC 关闭"
          >
            ESC
          </div>
        </div>

        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: '6px 6px 10px',
          }}
        >
          {flat.length === 0 && (
            <div
              style={{
                padding: '40px 16px',
                textAlign: 'center',
                color: 'rgba(255,255,255,0.45)',
                fontSize: 13,
              }}
            >
              没有匹配项。试试搜「视觉」「缺陷」「周报」或「设置」。
            </div>
          )}

          {filtered.map((group) => {
            const startIdx = flat.findIndex((x) => x.id === group.items[0]?.id);
            return (
              <div key={group.section} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    padding: '10px 14px 4px',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.35)',
                  }}
                >
                  {group.label}
                </div>
                {group.items.map((it, i) => {
                  const idx = startIdx + i;
                  const active = idx === cursor;
                  const pinned = pinnedSet.has(it.id);
                  // 不可加入导航的特殊条目：快捷操作 + 首页 + 设置
                  const pinnable = it.section !== 'shortcut' && it.route !== '/settings';
                  return (
                    <div
                      key={it.id}
                      data-cmd-index={idx}
                      onMouseEnter={() => setCursor(idx)}
                      onContextMenu={(e) => {
                        if (!pinnable || pinned) return;
                        e.preventDefault();
                        handlePin(it);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        width: 'auto',
                        padding: '9px 12px',
                        margin: '2px 4px',
                        borderRadius: 10,
                        background: active ? 'rgba(129,140,248,0.16)' : 'transparent',
                        color: 'var(--text-primary, #fff)',
                        transition: 'background 120ms',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelect(it)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          flex: 1,
                          minWidth: 0,
                          padding: 0,
                          background: 'transparent',
                          border: 'none',
                          textAlign: 'left',
                          cursor: 'pointer',
                          color: 'inherit',
                        }}
                        title={`${it.label}（点击跳转${pinnable && !pinned ? ' / 右键加到导航' : ''}）`}
                      >
                        <div
                          style={{
                            flexShrink: 0,
                            width: 32,
                            height: 32,
                            borderRadius: 8,
                            background: active ? 'rgba(129,140,248,0.22)' : 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: active ? '#c7d2fe' : 'rgba(255,255,255,0.75)',
                          }}
                        >
                          {getIcon(it.icon, 15)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: 'var(--text-primary, #fff)',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            {it.label}
                            {it.wip && (
                              <span
                                style={{
                                  fontSize: 9,
                                  fontWeight: 600,
                                  padding: '1px 5px',
                                  borderRadius: 4,
                                  background: 'rgba(251,146,60,0.18)',
                                  color: '#fb923c',
                                  letterSpacing: '0.04em',
                                }}
                              >
                                施工中
                              </span>
                            )}
                          </div>
                          {it.description && (
                            <div
                              style={{
                                fontSize: 11,
                                color: 'rgba(255,255,255,0.5)',
                                marginTop: 2,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {it.description}
                            </div>
                          )}
                        </div>
                      </button>
                      {pinnable && (
                        pinned ? (
                          <span
                            title="已在左侧导航"
                            style={{
                              flexShrink: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                              fontSize: 10,
                              padding: '3px 6px',
                              borderRadius: 6,
                              color: 'rgba(134,239,172,0.85)',
                              background: 'rgba(34,197,94,0.10)',
                            }}
                          >
                            <Check size={11} />
                            已在导航
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePin(it);
                            }}
                            title="加到左侧导航（也可右键 / ⌘+Enter）"
                            style={{
                              flexShrink: 0,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 3,
                              fontSize: 10,
                              padding: '4px 7px',
                              borderRadius: 6,
                              cursor: 'pointer',
                              border: '1px solid rgba(255,255,255,0.12)',
                              background: active ? 'rgba(129,140,248,0.18)' : 'rgba(255,255,255,0.04)',
                              color: active ? '#c7d2fe' : 'rgba(255,255,255,0.65)',
                              opacity: active ? 1 : 0.6,
                              transition: 'opacity 120ms, background 120ms',
                            }}
                          >
                            <Pin size={11} />
                            加到导航
                          </button>
                        )
                      )}
                      {active && !pinnable && (
                        <CornerDownLeft
                          size={13}
                          style={{ color: 'rgba(199,210,254,0.9)', flexShrink: 0 }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 14px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            fontSize: 11,
            color: 'rgba(255,255,255,0.45)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd style={kbdStyle}>↑</kbd>
              <kbd style={kbdStyle}>↓</kbd>
              <span>导航</span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd style={kbdStyle}>
                <CornerDownLeft size={10} />
              </kbd>
              <span>进入</span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd style={kbdStyle}>{isMac ? <Command size={10} /> : 'Ctrl'}</kbd>
              <kbd style={kbdStyle}>
                <CornerDownLeft size={10} />
              </kbd>
              <span>加到导航</span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd style={kbdStyle}>ESC</kbd>
              <span>关闭</span>
            </span>
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>命令面板</span>
            <ArrowRight size={10} />
            <kbd style={kbdStyle}>{isMac ? <Command size={10} /> : 'Ctrl'}</kbd>
            <kbd style={kbdStyle}>K</kbd>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes cmdPaletteFade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes cmdPaletteSlide {
          from { opacity: 0; transform: translateY(-8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 18,
  height: 18,
  padding: '0 4px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: 'rgba(255,255,255,0.7)',
  fontSize: 10,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontWeight: 600,
  lineHeight: 1,
};
