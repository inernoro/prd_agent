import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import { Search, ArrowRight, CornerDownLeft, Command } from 'lucide-react';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';
import { useAuthStore } from '@/stores/authStore';

type PaletteItem = {
  id: string;
  title: string;
  subtitle?: string;
  iconName?: string;
  section: '智能体' | '菜单' | '快捷操作';
  keywords: string;
  routePath: string;
};

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

function matchScore(q: string, keywords: string): number {
  if (!q) return 1;
  const k = keywords;
  if (k.includes(q)) {
    // 起始位置优先
    const idx = k.indexOf(q);
    return 100 - idx;
  }
  // 分词子串命中
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.every((p) => k.includes(p))) return 50;
  return 0;
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

  const allItems: PaletteItem[] = useMemo(() => {
    const agentItems: PaletteItem[] = BUILTIN_TOOLS.filter((t) => !!t.routePath).map((t) => ({
      id: `tool:${t.id}`,
      title: t.name,
      subtitle: t.description,
      iconName: typeof t.icon === 'string' ? t.icon : undefined,
      section: '智能体',
      keywords: normalize(
        [t.name, t.description, (t.tags || []).join(' '), t.agentKey, t.routePath].filter(Boolean).join(' '),
      ),
      routePath: t.routePath!,
    }));

    const menuItems: PaletteItem[] = (menuCatalog || []).map((m) => ({
      id: `menu:${m.appKey}:${m.path}`,
      title: m.label,
      subtitle: m.description || undefined,
      iconName: m.icon,
      section: '菜单',
      keywords: normalize([m.label, m.description, m.appKey, m.path, m.group].filter(Boolean).join(' ')),
      routePath: m.path,
    }));

    // 固定快捷入口
    const shortcuts: PaletteItem[] = [
      {
        id: 'shortcut:home',
        title: '返回首页',
        subtitle: '智能体启动器',
        iconName: 'Home',
        section: '快捷操作',
        keywords: 'home 首页 launcher 启动器',
        routePath: '/',
      },
      {
        id: 'shortcut:toolbox',
        title: '打开百宝箱',
        subtitle: '全部内置与自定义工具',
        iconName: 'Wrench',
        section: '快捷操作',
        keywords: 'toolbox 百宝箱 工具',
        routePath: '/ai-toolbox',
      },
      {
        id: 'shortcut:settings',
        title: '打开设置',
        subtitle: '账户 / 皮肤 / 导航 / 小技巧',
        iconName: 'Settings',
        section: '快捷操作',
        keywords: 'settings 设置 account profile 皮肤 skin',
        routePath: '/settings',
      },
      {
        id: 'shortcut:changelog',
        title: '更新中心',
        subtitle: '本周代码变更 / 产品动态',
        iconName: 'Sparkles',
        section: '快捷操作',
        keywords: 'changelog 更新 release whatsnew',
        routePath: '/changelog',
      },
    ];

    // 去重：菜单和 BUILTIN_TOOLS 可能 routePath 重复，菜单项是权威(带权限)
    const seen = new Set<string>();
    const uniq: PaletteItem[] = [];
    for (const it of [...shortcuts, ...menuItems, ...agentItems]) {
      if (seen.has(it.routePath)) continue;
      seen.add(it.routePath);
      uniq.push(it);
    }
    return uniq;
  }, [menuCatalog]);

  // 过滤 + 排序
  const filtered = useMemo(() => {
    const q = normalize(query);
    const scored = allItems
      .map((it) => ({ it, s: matchScore(q, it.keywords) }))
      .filter((x) => x.s > 0);

    // 按 section 分组内部排序 by score
    scored.sort((a, b) => b.s - a.s);

    // 按 section 稳定分组：快捷操作 → 智能体 → 菜单
    const order: PaletteItem['section'][] = ['快捷操作', '智能体', '菜单'];
    const grouped: { section: PaletteItem['section']; items: PaletteItem[] }[] = order
      .map((sec) => ({ section: sec, items: scored.filter((x) => x.it.section === sec).map((x) => x.it) }))
      .filter((g) => g.items.length > 0);

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

  const handleSelect = useCallback(
    (target: PaletteItem) => {
      setOpen(false);
      navigate(target.routePath);
    },
    [navigate],
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
        if (picked) handleSelect(picked);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    },
    [cursor, flat, handleSelect],
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
                  {group.section}
                </div>
                {group.items.map((it, i) => {
                  const idx = startIdx + i;
                  const active = idx === cursor;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      data-cmd-index={idx}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => handleSelect(it)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        width: '100%',
                        padding: '9px 12px',
                        margin: '2px 4px',
                        borderRadius: 10,
                        border: 'none',
                        textAlign: 'left',
                        cursor: 'pointer',
                        background: active ? 'rgba(129,140,248,0.16)' : 'transparent',
                        color: 'var(--text-primary, #fff)',
                        transition: 'background 120ms',
                      }}
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
                        {getIcon(it.iconName, 15)}
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
                          }}
                        >
                          {it.title}
                        </div>
                        {it.subtitle && (
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
                            {it.subtitle}
                          </div>
                        )}
                      </div>
                      {active && (
                        <CornerDownLeft
                          size={13}
                          style={{ color: 'rgba(199,210,254,0.9)', flexShrink: 0 }}
                        />
                      )}
                    </button>
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
