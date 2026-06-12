/**
 * 功能 tab — 左侧无限层级目录树 + 右侧子树记录表格。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, FolderTree, Plus, Search, Upload } from 'lucide-react';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { searchDirectoryUsers } from '@/services';
import { listFeatures, listVersions } from '@/services/real/productAgent';
import type { ProductVersion } from './types';
import { useEffectiveWorkflow } from './DynamicForm';
import { FeatureImportDialog } from './FeatureImportDialog';
import {
  buildFeatureTree,
  collectSubtreeIds,
  countDescendants,
  featurePathLabel,
  type FeatureTreeNode,
} from './featureTreeUtils';
import { resolveRequirementStateLabel } from './requirementWorkflowUtils';
import { toProductOptions } from './comboboxOptions';
import type { Feature, FeatureBusinessType, Product } from './types';

const FEATURE_TYPE_LABEL: Record<FeatureBusinessType, string> = {
  basic: '基础功能',
  core: '核心功能',
  value_added: '增值功能',
};

function FeatureTreeNodeRow({
  node,
  depth,
  selectedId,
  expanded,
  onSelect,
  onToggle,
}: {
  node: FeatureTreeNode;
  depth: number;
  selectedId: string | null;
  expanded: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.feature.id);
  const isSelected = selectedId === node.feature.id;
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(node.feature.id)}
        className={`flex w-full items-center gap-1 rounded-md py-1.5 pr-2 text-left text-xs transition-colors ${
          isSelected ? 'bg-cyan-500/15 text-cyan-100' : 'text-white/70 hover:bg-white/5'
        }`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {hasChildren ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onToggle(node.feature.id); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onToggle(node.feature.id); } }}
            className="flex h-5 w-5 shrink-0 items-center justify-center text-white/40 hover:text-white"
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.feature.title}</span>
        {hasChildren && (
          <span className="shrink-0 text-[10px] text-white/30">{countDescendants(node) + 1}</span>
        )}
      </button>
      {hasChildren && isExpanded && node.children.map((child) => (
        <FeatureTreeNodeRow
          key={child.feature.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          expanded={expanded}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

export function FeatureCatalogTab({
  productId,
  productPicker,
  showImport = true,
  showCreate = true,
  showReleaseLink = true,
}: {
  productId: string;
  /** 主页跨产品：在工具栏「全部版本」左侧展示可搜索的产品下拉 */
  productPicker?: {
    products: Product[];
    productId: string;
    onProductIdChange: (id: string) => void;
  };
  /** 导入目录结构（主页仅管理员展示） */
  showImport?: boolean;
  showCreate?: boolean;
  showReleaseLink?: boolean;
}) {
  const navigate = useNavigate();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [versionId, setVersionId] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());
  const { workflow } = useEffectiveWorkflow('feature', productId);

  const reload = useCallback(async () => {
    setLoading(true);
    const [featRes, verRes] = await Promise.all([listFeatures(productId), listVersions(productId)]);
    if (featRes.success) setFeatures(featRes.data.items);
    if (verRes.success) setVersions(verRes.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    setSelectedId(null);
    setVersionId('');
    setKeyword('');
  }, [productId]);

  useEffect(() => {
    const ids = Array.from(new Set(features.flatMap((f) => [f.ownerId, f.assigneeId].filter(Boolean) as string[])));
    if (ids.length === 0) return;
    let cancelled = false;
    void searchDirectoryUsers('', 200).then((res) => {
      if (cancelled || !res.success) return;
      setUserNames(new Map(res.data.items.map((u) => [u.userId, u.displayName])));
    });
    return () => { cancelled = true; };
  }, [features]);

  const tree = useMemo(() => buildFeatureTree(features), [features]);

  const subtreeIds = useMemo(
    () => collectSubtreeIds(features, selectedId),
    [features, selectedId],
  );

  const tableRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return features
      .filter((f) => subtreeIds.has(f.id))
      .filter((f) => !versionId || f.plannedVersionId === versionId)
      .filter((f) => {
        if (!kw) return true;
        return `${f.featureNo} ${f.title} ${f.moduleName} ${f.description ?? ''}`.toLowerCase().includes(kw);
      })
      .sort((a, b) => featurePathLabel(features, a.id).localeCompare(featurePathLabel(features, b.id), 'zh'));
  }, [features, subtreeIds, keyword, versionId]);

  const versionName = useMemo(() => new Map(versions.map((v) => [v.id, v.versionName])), [versions]);
  const productOptions = useMemo(
    () => (productPicker ? toProductOptions(productPicker.products) : []),
    [productPicker],
  );

  const selectedNode = selectedId ? features.find((f) => f.id === selectedId) : null;

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectNode = (id: string) => {
    setSelectedId(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <MapSectionLoader text="正在加载功能目录…" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-full min-h-0 flex-1">
        <aside className="flex h-full min-h-0 w-60 shrink-0 flex-col border-r border-white/10 bg-[#121317]">
          <div className="shrink-0 border-b border-white/10 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] text-white/40">
              <FolderTree size={13} /> 功能目录
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" style={{ overscrollBehavior: 'contain' }}>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className={`mb-1 flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs ${
                selectedId === null ? 'bg-cyan-500/15 text-cyan-100' : 'text-white/60 hover:bg-white/5'
              }`}
            >
              全部功能
              <span className="ml-auto text-[10px] text-white/30">{features.length}</span>
            </button>
            {tree.length === 0 ? (
              <div className="px-2 py-6 text-center text-[11px] text-white/30">
                暂无目录。可「导入目录结构」或「新建功能」。
              </div>
            ) : tree.map((node) => (
              <FeatureTreeNodeRow
                key={node.feature.id}
                node={node}
                depth={0}
                selectedId={selectedId}
                expanded={expanded}
                onSelect={selectNode}
                onToggle={toggleExpand}
              />
            ))}
          </div>
        </aside>

        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[#0f1014]">
          <div className="shrink-0 border-b border-white/10 px-4 py-2.5">
            <div className="text-sm font-medium text-white/85 truncate">
              {selectedNode ? selectedNode.title : '全部功能'}
            </div>
            <div className="text-[11px] text-white/40 mt-0.5">
              {selectedNode
                ? `展示「${selectedNode.title}」及其下所有层级共 ${tableRows.length} 条记录`
                : `共 ${tableRows.length} 条功能记录`}
            </div>
          </div>
          <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
            {productPicker && (
              <div className="h-8 w-[min(100%,200px)] min-w-[140px] shrink-0">
                <ItemSearchSelect
                  value={productPicker.productId}
                  onChange={productPicker.onProductIdChange}
                  options={productOptions}
                  placeholder="搜索产品名称/编号"
                  uiSize="sm"
                  countUnit="个产品"
                  emptyText="暂无产品"
                />
              </div>
            )}
            <select
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              className="h-8 min-w-[140px] max-w-[200px] rounded-lg border border-white/10 bg-[#15171c] px-2.5 text-xs text-white outline-none focus:border-cyan-400/50"
            >
              <option value="">全部版本</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>{v.versionName}</option>
              ))}
            </select>
            <label className="relative block min-w-[200px] flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索编号/名称/模块"
                className="w-full rounded-lg border border-white/10 bg-black/20 py-1.5 pl-9 pr-3 text-xs text-white outline-none placeholder:text-white/25 focus:border-cyan-400/50"
              />
            </label>
            {showImport && (
              <button
                type="button"
                onClick={() => setShowImportDialog(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
              >
                <Upload size={14} /> 导入目录结构
              </button>
            )}
            {showCreate && (
              <button
                type="button"
                onClick={() => navigate(`/product-agent/p/${productId}/feature/new`)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-200 border border-cyan-500/30 hover:bg-cyan-500/25"
              >
                <Plus size={14} /> 新建功能
              </button>
            )}
            {showReleaseLink && (
              <button
                type="button"
                onClick={() => navigate(`/product-agent/p/${productId}/release/new`)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/45 hover:bg-white/5"
              >
                申领正式版本号
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
            {tableRows.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-white/35">
                {features.length === 0 ? '还没有功能记录，请先导入或新建。' : '当前目录下没有匹配的记录。'}
              </div>
            ) : (
              <table className="w-full min-w-[1100px] text-left text-xs">
                <thead className="sticky top-0 z-10 bg-[#0f1014] text-white/45 border-b border-white/10">
                  <tr>
                    <th className="px-3 py-2.5 font-medium whitespace-nowrap">编号</th>
                    <th className="px-3 py-2.5 font-medium">目录路径</th>
                    <th className="px-3 py-2.5 font-medium">功能名称</th>
                    <th className="px-3 py-2.5 font-medium">计划版本</th>
                    <th className="px-3 py-2.5 font-medium">状态</th>
                    <th className="px-3 py-2.5 font-medium">类型</th>
                    <th className="px-3 py-2.5 font-medium">所属模块</th>
                    <th className="px-3 py-2.5 font-medium">处理人</th>
                    <th className="px-3 py-2.5 font-medium">负责人</th>
                    <th className="px-3 py-2.5 font-medium">关联需求</th>
                    <th className="px-3 py-2.5 font-medium">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((f) => (
                    <tr
                      key={f.id}
                      onClick={() => navigate(`/product-agent/p/${productId}/feature/${f.id}`)}
                      className="border-t border-white/5 cursor-pointer hover:bg-white/[0.03]"
                    >
                      <td className="px-3 py-2.5 font-mono text-cyan-200/80 whitespace-nowrap">{f.featureNo}</td>
                      <td className="px-3 py-2.5 text-white/50 max-w-[200px] truncate" title={featurePathLabel(features, f.id)}>
                        {featurePathLabel(features, f.id)}
                      </td>
                      <td className="px-3 py-2.5 text-white/85">{f.title}</td>
                      <td className="px-3 py-2.5 text-white/55">{versionName.get(f.plannedVersionId) ?? '—'}</td>
                      <td className="px-3 py-2.5 text-white/55">
                        {resolveRequirementStateLabel(f.currentState ?? '', workflow) || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-white/55">{FEATURE_TYPE_LABEL[f.featureType] ?? f.featureType}</td>
                      <td className="px-3 py-2.5 text-white/55">{f.moduleName || '—'}</td>
                      <td className="px-3 py-2.5 text-white/55">{f.assigneeId ? userNames.get(f.assigneeId) ?? f.assigneeId : '—'}</td>
                      <td className="px-3 py-2.5 text-white/55">{userNames.get(f.ownerId) ?? f.ownerId}</td>
                      <td className="px-3 py-2.5 text-white/55">{f.requirementIds.length}</td>
                      <td className="px-3 py-2.5 text-white/35 whitespace-nowrap">
                        {new Date(f.updatedAt).toLocaleDateString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {showImportDialog && (
        <FeatureImportDialog
          productId={productId}
          onClose={() => setShowImportDialog(false)}
          onImported={reload}
        />
      )}
    </div>
  );
}
