/**
 * Agent Switcher 浮层（命令面板）v13.0
 *
 * 触发：全局快捷键 Cmd/Ctrl + K
 * 内容：Agent / 百宝箱 / 实用工具 的统一命令面板，支持：
 *   - 搜索（按名称 / 标签 / 描述）
 *   - 键盘导航（↑↓ 行内、←→ 横向、Enter 进入、Esc 关闭）
 *   - 置顶（Pin）、最近使用、使用次数自动排序
 *   - 分组展示：置顶 → 最近 → Agent → 百宝箱 → 实用工具
 *
 * 存储：复用 agentSwitcherStore 的 pinnedIds / usageCounts / recentVisits（sessionStorage 持久化）
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import * as LucideIcons from 'lucide-react';
import { Search, Pin, PinOff, Clock, Star, Hammer, Sparkles, X } from 'lucide-react';
import { useAgentSwitcherStore } from '@/stores/agentSwitcherStore';
import { useAuthStore } from '@/stores/authStore';
import {
  getLauncherCatalog,
  findLauncherItem,
  type LauncherItem,
  type LauncherGroup,
} from '@/lib/launcherCatalog';

interface Section {
  key: 'pinned' | 'recent' | 'agent' | 'toolbox' | 'utility';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  items: LauncherItem[];
}

function getIcon(name: string, size = 18) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Icon = (LucideIcons as any)[name] ?? LucideIcons.Circle;
  return <Icon size={size} />;
}

/** 单张卡片 */
function LauncherCard({
  item,
  isSelected,
  isPinned,
  onClick,
  onMouseEnter,
  onTogglePin,
  badge,
}: {
  item: LauncherItem;
  isSelected: boolean;
  isPinned: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onTogglePin: (e: React.MouseEvent) => void;
  badge?: string;
}) {
  const accent = item.accentColor ?? '#818CF8';
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="group relative text-left outline-none focus:outline-none"
      style={{
        width: '100%',
      }}
    >
      <div
        className="relative h-[92px] p-3 rounded-[14px] flex items-start gap-3 transition-all duration-200 cursor-pointer overflow-hidden"
        style={{
          background: isSelected
            ? `linear-gradient(135deg, ${accent}22 0%, rgba(255,255,255,0.03) 100%)`
            : 'rgba(255, 255, 255, 0.025)',
          border: `1px solid ${isSelected ? `${accent}55` : 'rgba(255,255,255,0.06)'}`,
          boxShadow: isSelected
            ? `0 0 0 1px ${accent}40 inset, 0 8px 24px -8px ${accent}55`
            : '0 2px 8px rgba(0,0,0,0.25)',
          transform: isSelected ? 'translateY(-1px)' : 'translateY(0)',
        }}
      >
        {/* 图标 */}
        <div
          className="shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center"
          style={{
            background: isSelected ? `${accent}20` : 'rgba(255,255,255,0.04)',
            color: isSelected ? accent : 'rgba(255,255,255,0.72)',
            border: `1px solid ${isSelected ? `${accent}40` : 'rgba(255,255,255,0.06)'}`,
          }}
        >
          {getIcon(item.icon, 18)}
        </div>

        {/* 文字 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="text-[13px] font-semibold truncate"
              style={{ color: isSelected ? '#fff' : 'rgba(255,255,255,0.92)' }}
            >
              {item.name}
            </span>
            {item.wip && (
              <span
                className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(251, 146, 60, 0.2)', color: '#fb923c' }}
              >
                施工中
              </span>
            )}
            {badge && (
              <span
                className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(99,102,241,0.2)', color: '#a5b4fc' }}
              >
                {badge}
              </span>
            )}
          </div>
          <div
            className="mt-1 text-[11px] leading-relaxed line-clamp-2"
            style={{ color: isSelected ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.48)' }}
          >
            {item.description}
          </div>
        </div>

        {/* 置顶按钮（hover 或已置顶时显示） */}
        <button
          type="button"
          onClick={onTogglePin}
          className="absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center transition-opacity"
          style={{
            opacity: isPinned || isSelected ? 1 : 0,
            background: isPinned ? `${accent}30` : 'rgba(255,255,255,0.05)',
            color: isPinned ? accent : 'rgba(255,255,255,0.55)',
            border: `1px solid ${isPinned ? `${accent}60` : 'rgba(255,255,255,0.08)'}`,
          }}
          title={isPinned ? '取消置顶' : '置顶到前台'}
          aria-label={isPinned ? '取消置顶' : '置顶'}
        >
          {isPinned ? <Pin size={11} /> : <PinOff size={11} />}
        </button>
      </div>
    </button>
  );
}

export function AgentSwitcher() {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const permissions = useAuthStore((s) => s.permissions ?? []);
  const isRoot = useAuthStore((s) => s.isRoot ?? false);

  const {
    isOpen,
    selectedId,
    searchQuery,
    recentVisits,
    usageCounts,
    pinnedIds,
    close,
    setSelectedId,
    setSearchQuery,
    addRecentVisit,
    togglePin,
  } = useAgentSwitcherStore();

  // 目录（按权限过滤）
  const catalog = useMemo(
    () => getLauncherCatalog({ permissions, isRoot }),
    [permissions, isRoot]
  );

  // 过滤 + 分组
  const sections = useMemo<Section[]>(() => {
    const query = searchQuery.trim().toLowerCase();
    const match = (it: LauncherItem) => {
      if (!query) return true;
      const haystack = [it.name, it.description, ...(it.tags ?? [])].join(' ').toLowerCase();
      return haystack.includes(query);
    };

    const filtered = catalog.filter(match);

    // 置顶
    const pinnedSet = new Set(pinnedIds);
    const pinned = pinnedIds
      .map((id) => findLauncherItem(filtered, id))
      .filter((x): x is LauncherItem => !!x);

    // 最近（去掉已置顶的）
    const recentIds = recentVisits.map((v) => v.id).filter((id) => !pinnedSet.has(id));
    const recent = recentIds
      .map((id) => findLauncherItem(filtered, id))
      .filter((x): x is LauncherItem => !!x)
      .slice(0, 6);

    // 按 group 拆分（去掉已置顶的）
    const rest = filtered.filter((it) => !pinnedSet.has(it.id));
    const byGroup = (g: LauncherGroup) => {
      const arr = rest.filter((it) => it.group === g);
      // 有搜索时：按"匹配名称优先 + 使用次数"简易排序
      arr.sort((a, b) => {
        if (query) {
          const aName = a.name.toLowerCase().includes(query) ? 0 : 1;
          const bName = b.name.toLowerCase().includes(query) ? 0 : 1;
          if (aName !== bName) return aName - bName;
        }
        return (usageCounts[b.id] ?? 0) - (usageCounts[a.id] ?? 0);
      });
      return arr;
    };

    const agents = byGroup('agent');
    const toolbox = byGroup('toolbox');
    const utility = byGroup('utility');

    const out: Section[] = [];
    if (pinned.length)
      out.push({
        key: 'pinned',
        title: '置顶',
        subtitle: '你固定在前台的入口',
        icon: <Pin size={12} />,
        items: pinned,
      });
    if (!query && recent.length)
      out.push({
        key: 'recent',
        title: '最近使用',
        subtitle: '近期从这里打开的工具',
        icon: <Clock size={12} />,
        items: recent,
      });
    if (agents.length)
      out.push({
        key: 'agent',
        title: 'Agent',
        subtitle: '专属场景助手',
        icon: <Star size={12} />,
        items: agents,
      });
    if (toolbox.length)
      out.push({
        key: 'toolbox',
        title: '百宝箱',
        subtitle: '内置工具与定制 Agent',
        icon: <Hammer size={12} />,
        items: toolbox,
      });
    if (utility.length)
      out.push({
        key: 'utility',
        title: '实用工具',
        subtitle: '日常高频入口',
        icon: <Sparkles size={12} />,
        items: utility,
      });

    return out;
  }, [catalog, pinnedIds, recentVisits, usageCounts, searchQuery]);

  // 扁平化列表用于键盘导航
  const flatList = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // 打开时自动选中第一项
  useEffect(() => {
    if (!isOpen) return;
    if (flatList.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !flatList.some((it) => it.id === selectedId)) {
      setSelectedId(flatList[0].id);
    }
  }, [isOpen, flatList, selectedId, setSelectedId]);

  // 输入框聚焦
  useEffect(() => {
    if (isOpen) {
      const t = setTimeout(() => inputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  const launchItem = useCallback(
    (item: LauncherItem) => {
      addRecentVisit({
        id: item.id,
        agentKey: item.agentKey ?? '',
        agentName: item.name,
        title: item.name,
        path: item.route,
        icon: item.icon,
      });
      close();
      navigate(item.route);
    },
    [addRecentVisit, close, navigate]
  );

  // 键盘导航
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (flatList.length === 0) return;
      const curIdx = Math.max(
        0,
        flatList.findIndex((it) => it.id === selectedId)
      );

      const move = (delta: number) => {
        e.preventDefault();
        const next = (curIdx + delta + flatList.length) % flatList.length;
        setSelectedId(flatList[next].id);
      };

      switch (e.key) {
        case 'ArrowDown':
          move(2);
          break;
        case 'ArrowUp':
          move(-2);
          break;
        case 'ArrowRight':
          move(1);
          break;
        case 'ArrowLeft':
          move(-1);
          break;
        case 'Enter': {
          e.preventDefault();
          const item = flatList[curIdx];
          if (item) launchItem(item);
          break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, flatList, selectedId, setSelectedId, launchItem, close]);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) close();
    },
    [close]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center"
      onClick={handleBackdrop}
      style={{
        animation: 'switcherBgIn 0.18s ease-out both',
        paddingTop: '8vh',
      }}
    >
      {/* 背景 */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(8, 9, 15, 0.72)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
        }}
      />

      {/* 面板 */}
      <div
        className="relative w-[92vw] max-w-[960px]"
        style={{
          height: '80vh',
          maxHeight: '80vh',
          animation: 'switcherPanelIn 0.22s cubic-bezier(0.22, 1, 0.36, 1) both',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div
          className="h-full flex flex-col rounded-[20px] overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, rgba(22, 23, 32, 0.96) 0%, rgba(16, 17, 25, 0.96) 100%)',
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow:
              '0 30px 80px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02) inset',
          }}
        >
          {/* 搜索栏 */}
          <div
            className="shrink-0 flex items-center gap-3 px-5 h-[60px]"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Search size={18} style={{ color: 'rgba(255,255,255,0.4)' }} />
            <input
              ref={inputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索 Agent、工具或页面..."
              className="flex-1 bg-transparent outline-none text-[15px]"
              style={{ color: '#fff' }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="w-6 h-6 rounded-md flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}
                aria-label="清空搜索"
              >
                <X size={12} />
              </button>
            )}
            <div
              className="text-[11px] px-2 py-1 rounded"
              style={{
                background: 'rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.4)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              Esc 关闭
            </div>
          </div>

          {/* 内容区 */}
          <div
            className="flex-1"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {sections.length === 0 ? (
              <div
                className="h-full flex flex-col items-center justify-center gap-2"
                style={{ color: 'rgba(255,255,255,0.4)' }}
              >
                <Search size={24} style={{ opacity: 0.4 }} />
                <div className="text-[13px]">没有匹配的条目</div>
                <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  试试其他关键词，或按 Esc 关闭
                </div>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-5">
                {sections.map((section) => (
                  <div key={section.key}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <span style={{ color: 'rgba(255,255,255,0.45)' }}>{section.icon}</span>
                      <span
                        className="text-[11px] font-bold uppercase tracking-wider"
                        style={{ color: 'rgba(255,255,255,0.55)' }}
                      >
                        {section.title}
                      </span>
                      {section.subtitle && (
                        <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.28)' }}>
                          · {section.subtitle}
                        </span>
                      )}
                      <span
                        className="ml-auto text-[10px]"
                        style={{ color: 'rgba(255,255,255,0.3)' }}
                      >
                        {section.items.length}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      {section.items.map((item) => (
                        <LauncherCard
                          key={`${section.key}:${item.id}`}
                          item={item}
                          isSelected={selectedId === item.id}
                          isPinned={pinnedIds.includes(item.id)}
                          onClick={() => launchItem(item)}
                          onMouseEnter={() => setSelectedId(item.id)}
                          onTogglePin={(e) => {
                            e.stopPropagation();
                            togglePin(item.id);
                          }}
                          badge={
                            section.key === 'recent'
                              ? undefined
                              : section.key === 'pinned'
                              ? undefined
                              : (usageCounts[item.id] ?? 0) > 0
                              ? `${usageCounts[item.id]}`
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 底部提示 */}
          <div
            className="shrink-0 flex items-center justify-between px-5 h-[38px] text-[11px]"
            style={{
              borderTop: '1px solid rgba(255,255,255,0.06)',
              color: 'rgba(255,255,255,0.4)',
              background: 'rgba(255,255,255,0.015)',
            }}
          >
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5">
                <kbd
                  className="px-1.5 py-0.5 rounded font-mono"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  ↑↓←→
                </kbd>
                <span>导航</span>
              </span>
              <span className="flex items-center gap-1.5">
                <kbd
                  className="px-1.5 py-0.5 rounded font-mono"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  Enter
                </kbd>
                <span>进入</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Pin size={11} />
                <span>点击星标置顶</span>
              </span>
            </div>
            <div style={{ color: 'rgba(255,255,255,0.3)' }}>
              {flatList.length} 个入口 · 在「设置 → 我的空间」管理
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes switcherBgIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes switcherPanelIn {
          from {
            opacity: 0;
            transform: translateY(-12px) scale(0.985);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>,
    document.body
  );
}

export default AgentSwitcher;
