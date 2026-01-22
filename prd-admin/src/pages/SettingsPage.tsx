import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useNavOrderStore } from '@/stores/navOrderStore';
import { useAuthStore } from '@/stores/authStore';
import { GripVertical, Settings, RefreshCw, RotateCcw } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { ThemeSkinEditor } from '@/pages/settings/ThemeSkinEditor';

interface NavItem {
  key: string;
  label: string;
  icon: string;
}

// 动态获取 Lucide 图标
function getIcon(name: string, size = 16) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const IconComponent = (LucideIcons as any)[name];
  if (IconComponent) {
    return <IconComponent size={size} />;
  }
  return <LucideIcons.Circle size={size} />;
}

export default function SettingsPage() {
  const { navOrder, loaded, saving, loadFromServer, setNavOrder, reset } = useNavOrderStore();
  const menuCatalog = useAuthStore((s) => s.menuCatalog);

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // 用于节流的 ref
  const lastDragOverTimeRef = useRef<number>(0);
  const pendingDragOverIndexRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  // 列表容器 ref（用于锁定高度防止抖动）
  const listContainerRef = useRef<HTMLDivElement>(null);

  // 从后端菜单目录构建导航项（menuCatalog 已经是后端根据用户权限过滤后的结果，无需二次过滤）
  const sortedItems: NavItem[] = useMemo(() => {
    if (!Array.isArray(menuCatalog) || menuCatalog.length === 0) return [];

    // 构建导航项
    const items = menuCatalog.map((m) => ({
      key: m.appKey,
      label: m.label,
      icon: m.icon,
    }));

    // 如果有用户自定义顺序，按该顺序排列
    if (navOrder.length > 0) {
      const orderMap = new Map(navOrder.map((k, i) => [k, i]));
      items.sort((a, b) => {
        const aOrder = orderMap.get(a.key) ?? 9999;
        const bOrder = orderMap.get(b.key) ?? 9999;
        return aOrder - bOrder;
      });
    }

    return items;
  }, [menuCatalog, navOrder]);

  // 首次加载
  useEffect(() => {
    if (!loaded) {
      void loadFromServer();
    }
  }, [loaded, loadFromServer]);

  // 清理 RAF（组件卸载时）
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // 拖拽开始
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    // 锁定容器高度：当前高度 + 一个条目高度（~54px），防止插入指示器导致容器扩展引起抖动
    if (listContainerRef.current) {
      const currentHeight = listContainerRef.current.offsetHeight;
      listContainerRef.current.style.minHeight = `${currentHeight + 54}px`;
    }
    setDraggingIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  // 拖拽经过（使用节流 + RAF，避免频繁状态更新导致抖动）
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // 记录待处理的目标索引
    pendingDragOverIndexRef.current = index;

    // 节流：至少间隔 50ms 才更新一次
    const now = performance.now();
    if (now - lastDragOverTimeRef.current < 50) {
      return;
    }

    // 使用 RAF 批量更新，避免在同一帧内多次 setState
    if (rafIdRef.current !== null) {
      return;
    }

    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      const targetIndex = pendingDragOverIndexRef.current;
      if (targetIndex !== null) {
        lastDragOverTimeRef.current = performance.now();
        setDragOverIndex((prev) => (prev === targetIndex ? prev : targetIndex));
      }
    });
  }, []);

  // 拖拽离开
  const handleDragLeave = useCallback(() => {
    // 取消待处理的 RAF
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingDragOverIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  // 放下
  const handleDrop = useCallback(
    (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      const sourceIndex = draggingIndex;
      setDraggingIndex(null);
      setDragOverIndex(null);

      if (sourceIndex === null || sourceIndex === targetIndex) return;

      const newOrder = [...sortedItems.map((it) => it.key)];
      const [removed] = newOrder.splice(sourceIndex, 1);
      newOrder.splice(targetIndex, 0, removed);
      setNavOrder(newOrder);
    },
    [draggingIndex, sortedItems, setNavOrder]
  );

  // 拖拽结束
  const handleDragEnd = useCallback(() => {
    // 取消待处理的 RAF
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    // 释放容器高度锁定
    if (listContainerRef.current) {
      listContainerRef.current.style.minHeight = '';
    }
    pendingDragOverIndexRef.current = null;
    lastDragOverTimeRef.current = 0;
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  // 重置为默认顺序
  const handleReset = useCallback(() => {
    reset();
    void loadFromServer();
  }, [reset, loadFromServer]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-5 overflow-x-hidden overflow-y-auto">
      {/* 页面头部 */}
      <TabBar
        title="系统设置"
        icon={<Settings size={16} />}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void loadFromServer()} disabled={saving}>
              <RefreshCw size={14} className={saving ? 'animate-spin' : ''} />
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={handleReset} disabled={saving}>
              <RotateCcw size={14} />
              重置
            </Button>
          </>
        }
      />

      {/* 左右分栏布局：左侧 1/4 导航顺序，右侧 3/4 皮肤编辑 */}
      <div className="flex-1 min-h-0 grid grid-cols-4 gap-5">
        {/* 左侧：导航顺序设置 */}
        <div className="col-span-1 min-h-0 flex flex-col">
          <GlassCard glow accentHue={210} className="h-full flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 mb-4 shrink-0">
              <div>
                <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)' }}>
                  导航顺序
                </h2>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  拖拽调整左侧导航菜单的显示顺序
                </p>
              </div>
              {saving && (
                <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <RefreshCw size={12} className="animate-spin" />
                  保存中...
                </div>
              )}
            </div>

            {/* 列表容器：隐藏滚动条 + 底部阴影渐隐 */}
            <div className="relative flex-1 min-h-0">
              <div
                className="h-full overflow-y-auto pr-1"
                style={{
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none',
                }}
              >
                <style>{`
                  .nav-order-list::-webkit-scrollbar { display: none; }
                `}</style>
                <div ref={listContainerRef} className="nav-order-list pb-6">
                  {sortedItems.map((item, index) => {
                    const isDragging = draggingIndex === index;
                    // 显示插入指示器：在目标位置之前显示空隙
                    const showGapBefore =
                      draggingIndex !== null &&
                      dragOverIndex !== null &&
                      dragOverIndex === index &&
                      draggingIndex !== index &&
                      draggingIndex !== index - 1;

                    return (
                      <div key={item.key}>
                        {/* 插入指示器：空隙 + 线条 */}
                        <div
                          style={{
                            height: showGapBefore ? 48 : 0,
                            marginBottom: showGapBefore ? 6 : 0,
                            transition: 'height 0.2s cubic-bezier(0.32, 0.72, 0, 1), margin 0.2s cubic-bezier(0.32, 0.72, 0, 1)',
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {showGapBefore && (
                            <div
                              className="rounded-[10px] w-full h-full"
                              style={{
                                background: 'rgba(214,178,106,0.08)',
                                border: '2px dashed rgba(214,178,106,0.4)',
                              }}
                            />
                          )}
                        </div>
                        {/* 实际的项目 */}
                        <div
                          draggable
                          onDragStart={(e) => handleDragStart(e, index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, index)}
                          onDragEnd={handleDragEnd}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-[10px] cursor-grab active:cursor-grabbing"
                          style={{
                            background: isDragging
                              ? 'rgba(214,178,106,0.15)'
                              : 'rgba(255,255,255,0.03)',
                            border: isDragging
                              ? '1px solid rgba(214,178,106,0.3)'
                              : '1px solid rgba(255,255,255,0.06)',
                            opacity: isDragging ? 0.5 : 1,
                            marginBottom: 6,
                            transition: 'background 0.15s ease, border 0.15s ease, opacity 0.15s ease',
                          }}
                        >
                          <div
                            className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            <GripVertical size={14} />
                          </div>
                          <div
                            className="shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center"
                            style={{
                              background: 'rgba(255,255,255,0.05)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            {getIcon(item.icon, 16)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                              {item.label}
                            </div>
                          </div>
                          <div
                            className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded"
                            style={{
                              background: 'rgba(255,255,255,0.04)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            {index + 1}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* 末尾插入指示器：当拖到最后一个之后 */}
                  {draggingIndex !== null && dragOverIndex === sortedItems.length - 1 && draggingIndex !== sortedItems.length - 1 && (
                    <div
                      style={{
                        height: 48,
                        marginTop: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <div
                        className="rounded-[10px] w-full h-full"
                        style={{
                          background: 'rgba(214,178,106,0.08)',
                          border: '2px dashed rgba(214,178,106,0.4)',
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {/* 底部阴影渐隐遮罩 */}
              <div
                className="absolute bottom-0 left-0 right-0 h-12 pointer-events-none"
                style={{
                  background: 'linear-gradient(to top, var(--card-bg, rgba(30,30,35,0.95)) 0%, transparent 100%)',
                }}
              />
            </div>

            {sortedItems.length === 0 && (
              <div
                className="text-center py-8 text-sm"
                style={{ color: 'var(--text-muted)' }}
              >
                {loaded ? '暂无可显示的导航项' : '加载中...'}
              </div>
            )}
          </GlassCard>
        </div>

        {/* 右侧：皮肤编辑 */}
        <div className="col-span-3 min-h-0 overflow-y-auto">
          <ThemeSkinEditor />
        </div>
      </div>
    </div>
  );
}
