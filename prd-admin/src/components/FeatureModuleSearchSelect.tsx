import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, FolderTree, Search } from 'lucide-react';
import type { Feature } from '@/pages/product-agent/types';
import {
  buildFeatureTree,
  featurePathLabel,
  flattenCatalogModuleOptions,
  getTreeChildren,
  resolveCatalogModuleValue,
  type CatalogModuleOption,
} from '@/pages/product-agent/featureTreeUtils';
import {
  ItemComboboxChevron,
  ItemComboboxPanelFooter,
  itemComboboxInputClass,
  itemComboboxPanelStyle,
  itemComboboxTriggerStyle,
  truncateItemLabel,
  useItemComboboxPanel,
} from './itemSearchCombobox';

function matchCatalogSearch(option: CatalogModuleOption, q: string) {
  const hay = `${option.path} ${option.title} ${option.moduleName}`.toLowerCase();
  return hay.includes(q);
}

export function collectFeatureModuleOptions(features: Feature[], current?: string) {
  const tree = buildFeatureTree(features);
  const fromTree = flattenCatalogModuleOptions(tree, features).map((o) => ({ id: o.path, label: o.path }));
  const names = new Set(fromTree.map((o) => o.id));
  for (const f of features) {
    const n = f.moduleName?.trim();
    if (n && !names.has(n)) {
      names.add(n);
      fromTree.push({ id: n, label: n });
    }
  }
  if (current?.trim() && !names.has(current.trim())) {
    fromTree.push({ id: current.trim(), label: current.trim() });
  }
  return fromTree.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

export function FeatureModuleSearchSelect({
  value,
  onChange,
  features,
  placeholder = '搜索或逐级选择功能目录',
  disabled = false,
  uiSize = 'md',
}: {
  value: string;
  onChange: (name: string) => void;
  features: Feature[];
  placeholder?: string;
  disabled?: boolean;
  uiSize?: 'sm' | 'md';
}) {
  const tree = useMemo(() => buildFeatureTree(features), [features]);
  const flatOptions = useMemo(() => flattenCatalogModuleOptions(tree, features), [tree, features]);
  const resolved = useMemo(() => resolveCatalogModuleValue(features, tree, value), [features, tree, value]);

  const [browseParentId, setBrowseParentId] = useState<string | null>(null);
  const { open, setOpen, filter, setFilter, triggerRef, panelRef, inputRef, pos, closePanel } = useItemComboboxPanel(disabled);

  const q = filter.trim().toLowerCase();
  const isSearching = q.length > 0;
  const browseNodes = useMemo(() => getTreeChildren(tree, browseParentId), [tree, browseParentId]);
  const browseOptions = useMemo(
    () => browseNodes.map((node) => ({
      featureId: node.feature.id,
      title: node.feature.title,
      path: featurePathLabel(features, node.feature.id),
      hasChildren: node.children.length > 0,
      moduleName: node.feature.moduleName?.trim() ?? '',
    })),
    [browseNodes, features],
  );
  const searchResults = useMemo(
    () => (isSearching ? flatOptions.filter((o) => matchCatalogSearch(o, q)) : []),
    [flatOptions, isSearching, q],
  );

  const breadcrumb = useMemo(() => {
    if (!browseParentId) return [];
    const chain: CatalogModuleOption[] = [];
    const byId = new Map(features.map((f) => [f.id, f]));
    let cur = byId.get(browseParentId);
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.unshift({
        featureId: cur.id,
        title: cur.title,
        path: featurePathLabel(features, cur.id),
        hasChildren: true,
        moduleName: cur.moduleName?.trim() ?? '',
      });
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }, [browseParentId, features]);

  const closedLabel = resolved?.path ?? value;
  const displayValue = open ? filter : (closedLabel ? truncateItemLabel(closedLabel, 28) : '');
  const canCreate = isSearching && !flatOptions.some((o) => matchCatalogSearch(o, q) || o.path.toLowerCase() === q);

  const apply = (path: string) => {
    onChange(path.trim());
    closePanel();
    setBrowseParentId(null);
  };

  const openPanel = () => {
    if (disabled) return;
    setOpen(true);
    setFilter('');
    if (resolved) {
      const byId = new Map(features.map((f) => [f.id, f]));
      const parent = byId.get(resolved.featureId)?.parentId ?? null;
      setBrowseParentId(parent && features.some((f) => f.id === parent) ? parent : null);
    } else {
      setBrowseParentId(null);
    }
  };

  const selectOption = (option: CatalogModuleOption) => apply(option.path);

  const triggerHeight = uiSize === 'sm' ? 'h-8' : 'h-9';

  const dropdownPanel = open && pos && !disabled && createPortal(
    <div
      ref={panelRef}
      className="rounded-[8px] flex flex-col overflow-hidden"
      style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...itemComboboxPanelStyle }}
    >
      {!isSearching && flatOptions.length > 0 && (
        <div className="px-2.5 py-2 shrink-0 border-b border-white/8" style={{ minHeight: 0 }}>
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-white/45">
            <button
              type="button"
              className={`rounded px-1.5 py-0.5 hover:bg-white/8 ${browseParentId === null ? 'text-cyan-200/90' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBrowseParentId(null)}
            >
              根目录
            </button>
            {breadcrumb.map((item) => (
              <span key={item.featureId} className="flex items-center gap-1">
                <ChevronRight size={12} className="text-white/25" />
                <button
                  type="button"
                  className={`rounded px-1.5 py-0.5 hover:bg-white/8 truncate max-w-[120px] ${browseParentId === item.featureId ? 'text-cyan-200/90' : ''}`}
                  title={item.path}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setBrowseParentId(item.featureId)}
                >
                  {item.title}
                </button>
              </span>
            ))}
          </div>
          {browseParentId && (
            <button
              type="button"
              className="mt-2 w-full rounded-md border border-cyan-400/20 bg-cyan-400/5 px-2 py-1.5 text-left text-[11px] text-cyan-100/90 hover:bg-cyan-400/10"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const current = flatOptions.find((o) => o.featureId === browseParentId);
                if (current) selectOption(current);
              }}
            >
              选择当前目录「{breadcrumb[breadcrumb.length - 1]?.title ?? ''}」
            </button>
          )}
        </div>
      )}

      <div className="overflow-auto flex-1 py-1" style={{ minHeight: 0 }}>
        {flatOptions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {canCreate ? (
              <button
                type="button"
                className="text-cyan-200/90 hover:text-cyan-100"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(filter.trim())}
              >
                使用「{filter.trim()}」作为模块名
              </button>
            ) : (
              '暂无功能目录，可先导入目录树；或在上方搜索框输入模块名后回车'
            )}
          </div>
        ) : isSearching ? (
          <>
            {canCreate && (
              <button
                type="button"
                className="w-full px-3 py-2.5 text-left text-[12px] text-cyan-200/90 hover:bg-white/8"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(filter.trim())}
              >
                使用「{filter.trim()}」作为模块名
              </button>
            )}
            {searchResults.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {canCreate ? '未找到匹配目录，可使用上方自定义名称' : `未找到「${filter.trim()}」`}
              </div>
            ) : searchResults.map((option) => (
              <CatalogRow
                key={option.featureId}
                option={option}
                selected={option.path === value || option.path === resolved?.path}
                mode="search"
                onSelect={() => selectOption(option)}
                onDrill={() => setBrowseParentId(option.featureId)}
              />
            ))}
          </>
        ) : browseOptions.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            当前层级没有子目录
          </div>
        ) : browseOptions.map((option) => (
          <CatalogRow
            key={option.featureId}
            option={option}
            selected={option.path === value || option.path === resolved?.path}
            mode="browse"
            onSelect={() => selectOption(option)}
            onDrill={() => setBrowseParentId(option.featureId)}
          />
        ))}
      </div>

      <ItemComboboxPanelFooter
        left={
          isSearching
            ? `${searchResults.length} 条匹配`
            : flatOptions.length > 0
              ? `逐级点选 · 共 ${flatOptions.length} 个目录节点`
              : '输入模块名可手动创建'
        }
      />
    </div>,
    document.body,
  );

  return (
    <div className="relative">
      <div
        ref={triggerRef}
        className={`flex items-center gap-2 w-full rounded-[8px] px-2.5 text-[13px] ${triggerHeight} ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
        style={itemComboboxTriggerStyle(open)}
      >
        <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={displayValue}
          title={!open && closedLabel ? closedLabel : undefined}
          onChange={(e) => { setFilter(e.target.value); setOpen(true); }}
          onFocus={openPanel}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) {
              e.preventDefault();
              apply(filter.trim());
            }
          }}
          placeholder={placeholder}
          className={itemComboboxInputClass}
          style={{ color: 'var(--text-primary)', boxShadow: 'none' }}
        />
        <ItemComboboxChevron
          open={open}
          disabled={disabled}
          onToggle={() => {
            if (disabled) return;
            if (open) { closePanel(); inputRef.current?.blur(); } else { openPanel(); inputRef.current?.focus(); }
          }}
        />
      </div>
      {dropdownPanel}
    </div>
  );
}

function CatalogRow({
  option,
  selected,
  mode,
  onSelect,
  onDrill,
}: {
  option: CatalogModuleOption;
  selected: boolean;
  mode: 'browse' | 'search';
  onSelect: () => void;
  onDrill: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/8"
      style={selected ? { background: 'rgba(var(--accent-gold-rgb, 212,175,55), 0.08)' } : undefined}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (mode === 'browse' && option.hasChildren) onDrill();
          else onSelect();
        }}
      >
        {option.hasChildren ? (
          <FolderTree size={14} className="shrink-0 text-white/35" />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-white/90 truncate">{option.title}</span>
          {mode === 'search' && (
            <span className="block text-[10px] text-white/40 truncate mt-0.5">{option.path}</span>
          )}
        </span>
        {mode === 'browse' && option.hasChildren && (
          <ChevronRight size={14} className="shrink-0 text-white/30" />
        )}
      </button>
      {(mode === 'browse' && option.hasChildren) || mode === 'search' ? (
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-[10px] text-cyan-200/80 hover:bg-cyan-400/10"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSelect}
        >
          选择
        </button>
      ) : null}
    </div>
  );
}
