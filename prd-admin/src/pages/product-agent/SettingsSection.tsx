/**
 * 产品管理智能体 — 全局设置（表单 / 描述 / 产品类型 / 需求类型 / 应用管理员；产品管理员见「应用 → 应用配置」）。
 *
 * 全局默认（ProductId 留空）+ 允许选某产品覆盖。复用后端 form-templates / desc-templates CRUD。
 * 作用对象类型：需求 / 功能 / 版本 / 客户。
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Save, GripVertical, X, AlertTriangle } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import {
  listProducts,
  listFormTemplates,
  upsertFormTemplate,
  upsertProductCategory,
  deleteProductCategory,
  upsertRequirementType,
  deleteRequirementType,
  listDescTemplates,
  upsertDescTemplate,
  deleteDescTemplate,
  listProductMembers,
  listProductApplicationAdmins,
  addProductApplicationAdmin,
  removeProductApplicationAdmin,
  resetProductAgentDemoData,
  type ProductApplicationAdmin,
} from '@/services/real/productAgent';
import type { Product, FormField, FormFieldType, ProductEntityType, ProductCategory, RequirementType, DescTemplate } from './types';
import { useProductCategories } from './productCategories';
import { useRequirementTypes } from './requirementTypes';
import { RichTextField } from './DynamicForm';

const ENTITY_TYPES: { value: ProductEntityType; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'feature', label: '功能' },
  { value: 'version', label: '版本' },
  { value: 'customer', label: '客户' },
];

const FIELD_TYPES: { value: FormFieldType; label: string }[] = [
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
  { value: 'richtext', label: '富文本（排版+截图）' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '单选下拉' },
  { value: 'multiselect', label: '多选' },
  { value: 'radio', label: '单选按钮' },
  { value: 'checkbox', label: '勾选' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期时间' },
  { value: 'user', label: '用户选择' },
  { value: 'relation', label: '关联对象' },
  { value: 'file', label: '附件上传' },
];
const HAS_OPTIONS = new Set(['select', 'multiselect', 'radio']);
const RELATION_TARGETS: { value: string; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'feature', label: '功能' },
  { value: 'version', label: '版本' },
  { value: 'customer', label: '客户' },
];

// 各对象类型的系统预置字段（由页面原生渲染，不可在表单里增删改；这里仅展示让配置者知晓）
const PRESET_FIELDS: Partial<Record<ProductEntityType, { label: string; type: string }[]>> = {
  requirement: [
    { label: '标题', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '需求类型', type: '分类（可配置）' },
    { label: '分级', type: 'P0-P3' },
    { label: '状态', type: '流程驱动' },
    { label: '所属客户', type: '关联客户' },
    { label: '归属版本', type: '关联版本' },
    { label: '追溯缺陷', type: '关联缺陷' },
  ],
  feature: [
    { label: '名称', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '状态', type: '流程驱动' },
    { label: '实现需求', type: '关联需求' },
    { label: '纳入版本', type: '功能版本化' },
    { label: '追溯缺陷', type: '关联缺陷' },
  ],
  version: [
    { label: '版本名', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '生命周期', type: '流程驱动' },
    { label: '关联需求', type: '关联需求' },
    { label: '纳入功能', type: '功能版本化' },
  ],
  customer: [
    { label: '名称', type: '单行文本' },
    { label: '公司', type: '单行文本' },
    { label: '联系方式', type: '单行文本' },
    { label: '描述', type: '多行文本' },
  ],
  product: [
    { label: '名称', type: '单行文本' },
    { label: '描述', type: '多行文本' },
    { label: '类型', type: '产品类型（可管理）' },
  ],
};

export function SettingsSection() {
  const [mode, setMode] = useState<'form' | 'desc' | 'category' | 'reqtype' | 'admins' | 'debug'>('form');
  const [entityType, setEntityType] = useState<ProductEntityType>('requirement');
  const [productScope, setProductScope] = useState(''); // '' = 全局
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await listProducts({ pageSize: 200 });
      if (res.success) setProducts(res.data.items);
    })();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* 模式 + 对象类型 + 作用范围 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          <button onClick={() => setMode('form')} className={`px-3 py-1.5 text-sm ${mode === 'form' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>表单模板</button>
          <button onClick={() => setMode('desc')} className={`px-3 py-1.5 text-sm ${mode === 'desc' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>描述模板</button>
          <button onClick={() => setMode('category')} className={`px-3 py-1.5 text-sm ${mode === 'category' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>产品类型</button>
          <button onClick={() => setMode('reqtype')} className={`px-3 py-1.5 text-sm ${mode === 'reqtype' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>需求类型</button>
          <button onClick={() => setMode('admins')} className={`px-3 py-1.5 text-sm ${mode === 'admins' ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}>应用管理员</button>
          <button onClick={() => setMode('debug')} className={`px-3 py-1.5 text-sm ${mode === 'debug' ? 'bg-amber-500/15 text-amber-200' : 'text-white/50 hover:bg-white/5'}`}>调试</button>
        </div>
        {mode !== 'category' && mode !== 'reqtype' && mode !== 'admins' && mode !== 'debug' && (
          <>
            <div className="w-px h-6 bg-white/10" />
            {ENTITY_TYPES.map((e) => (
              <button
                key={e.value}
                onClick={() => setEntityType(e.value)}
                className={`px-2.5 py-1 rounded-md text-xs border ${entityType === e.value ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
              >
                {e.label}
              </button>
            ))}
            {mode !== 'desc' && (
              <>
                <div className="w-px h-6 bg-white/10" />
                <select
                  value={productScope}
                  onChange={(e) => setProductScope(e.target.value)}
                  className="px-2 py-1.5 rounded-md text-xs bg-white/5 border border-white/10 text-white/70 outline-none"
                >
                  <option value="">全局默认（所有产品共用）</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>覆盖：{p.name}</option>
                  ))}
                </select>
              </>
            )}
          </>
        )}
      </div>

      {mode === 'admins' ? (
        <ApplicationAdminManager />
      ) : mode === 'debug' ? (
        <DebugDataResetPanel />
      ) : mode === 'form' ? (
        <FormTemplateEditor key={`f-${entityType}-${productScope}`} entityType={entityType} productId={productScope || null} />
      ) : mode === 'desc' ? (
        <DescTemplateManager key={`d-${entityType}`} entityType={entityType} />
      ) : mode === 'reqtype' ? (
        <RequirementTypeManager />
      ) : (
        <CategoryManager />
      )}
    </div>
  );
}

function ApplicationAdminManager() {
  const [items, setItems] = useState<ProductApplicationAdmin[]>([]);
  const [productAdminRows, setProductAdminRows] = useState<Array<{ productId: string; productName: string; admins: string[] }>>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const [adminResult, productsResult] = await Promise.all([
      listProductApplicationAdmins(),
      listProducts({ pageSize: 200 }),
    ]);
    if (adminResult.success) setItems(adminResult.data.items);
    else setMessage(adminResult.error?.message ?? '管理员名单加载失败');
    if (productsResult.success) {
      const rows = await Promise.all(productsResult.data.items.map(async (product) => {
        const memberResult = await listProductMembers(product.id);
        const admins = memberResult.success
          ? memberResult.data.members
            .filter((member) => member.role === 'owner' || member.role === 'admin')
            .map((member) => member.displayName)
          : [];
        return { productId: product.id, productName: product.name, admins };
      }));
      setProductAdminRows(rows);
    }
    setLoading(false);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    if (!selectedUserId) return;
    setBusy(true);
    const result = await addProductApplicationAdmin(selectedUserId);
    setBusy(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '添加失败');
      return;
    }
    setItems(result.data.items);
    setSelectedUserId('');
    setMessage('管理员已添加');
  };

  const remove = async (userId: string) => {
    setBusy(true);
    const result = await removeProductApplicationAdmin(userId);
    setBusy(false);
    if (!result.success) {
      setMessage(result.error?.message ?? '移除失败');
      return;
    }
    setMessage('管理员已移除');
    await reload();
  };

  if (loading) return <MapSectionLoader text="正在加载管理员…" />;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="text-sm font-medium text-white/75">产品管理应用管理员</div>
        <div className="mt-1 text-xs leading-5 text-white/40">只有名单内管理员可看到并执行历史数据导入：产品、需求、缺陷、版本请在产品管理总览对应菜单导入；功能目录仅在单产品「功能」页导入。可重复导入，带外部 ID 的数据按原记录更新。</div>
        <div className="mt-4 flex items-center gap-2">
          <div className="min-w-0 flex-1"><UserSearchSelect value={selectedUserId} onChange={setSelectedUserId} placeholder="搜索 MAP 用户" showAllOption={false} /></div>
          <button onClick={() => void add()} disabled={!selectedUserId || busy} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/20 px-3 py-2 text-sm text-cyan-100 disabled:opacity-40">
            {busy ? <MapSpinner size={14} /> : <Plus size={14} />} 添加管理员
          </button>
        </div>
        {message && <div className="mt-2 text-xs text-white/50">{message}</div>}
      </div>
      <div className="overflow-hidden rounded-xl border border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/[0.03] text-xs text-white/45"><tr><th className="px-4 py-2.5 font-medium">姓名</th><th className="px-4 py-2.5 font-medium">账号</th><th className="w-24 px-4 py-2.5 font-medium">操作</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.userId} className="border-t border-white/5">
                <td className="px-4 py-3 text-white/80">{item.displayName}</td>
                <td className="px-4 py-3 text-xs text-white/45">{item.username || item.userId}</td>
                <td className="px-4 py-3"><button onClick={() => void remove(item.userId)} disabled={busy || items.length <= 1} title={items.length <= 1 ? '至少保留一位管理员' : '移除管理员'} className="text-white/35 hover:text-red-300 disabled:opacity-25"><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-hidden rounded-xl border border-white/10">
        <div className="px-4 py-2.5 text-xs text-white/50 border-b border-white/10">
          产品实时管理员（2 列）：产品 / 管理员（多位用分号分隔）
        </div>
        <table className="w-full text-left text-sm">
          <thead className="bg-white/[0.03] text-xs text-white/45">
            <tr>
              <th className="px-4 py-2.5 font-medium">产品</th>
              <th className="px-4 py-2.5 font-medium">管理员</th>
            </tr>
          </thead>
          <tbody>
            {productAdminRows.map((row) => (
              <tr key={row.productId} className="border-t border-white/5">
                <td className="px-4 py-3 text-white/80">{row.productName}</td>
                <td className="px-4 py-3 text-xs text-white/55">{row.admins.length > 0 ? row.admins.join('；') : '未配置'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const DEBUG_RESET_CONFIRM = '清空演示数据';

function DebugDataResetPanel() {
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [untouched, setUntouched] = useState<string[]>([]);

  const reset = async () => {
    if (confirmPhrase.trim() !== DEBUG_RESET_CONFIRM) {
      setMessage(`请输入确认语：${DEBUG_RESET_CONFIRM}`);
      return;
    }
    setBusy(true);
    setMessage('正在清空业务数据…');
    setResult(null);
    setUntouched([]);
    const response = await resetProductAgentDemoData(confirmPhrase.trim());
    setBusy(false);
    if (!response.success) {
      setMessage(response.error?.message ?? '清空失败');
      return;
    }
    setResult(response.data.deleted);
    setUntouched(response.data.untouched ?? []);
    setConfirmPhrase('');
    setMessage(response.data.message);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.06] p-4">
        <div className="flex items-start gap-2">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-300" />
          <div>
            <div className="text-sm font-medium text-amber-100">调试模式 · 清空演示数据</div>
            <div className="mt-1 text-xs leading-5 text-white/50">
              作用范围：<span className="text-white/70">仅 product-agent 产品管理应用</span>。删除 MongoDB 业务记录，不修改任何代码或配置结构。
            </div>
            <div className="mt-2 text-xs leading-5 text-white/45">
              会清空：产品、版本、正式/内部版本、需求、功能、客户、本应用挂载的知识库文档、产品侧追溯/导入的缺陷。
            </div>
            <div className="mt-2 text-xs leading-5 text-white/40">
              不会动：表单/描述/类型/流程/管理员配置；defect-agent 独立缺陷与其他 Agent 文档空间；用户、团队、权限等全局数据。
            </div>
            <div className="mt-2 text-[11px] text-amber-200/70">此功能为临时调试入口，演示准备完成后将移除。</div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <label className="block">
          <span className="mb-1.5 block text-xs text-white/50">输入确认语以继续</span>
          <input
            value={confirmPhrase}
            onChange={(event) => setConfirmPhrase(event.target.value)}
            placeholder={DEBUG_RESET_CONFIRM}
            className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-amber-400/40"
          />
        </label>
        <button
          onClick={() => void reset()}
          disabled={busy || confirmPhrase.trim() !== DEBUG_RESET_CONFIRM}
          className="mt-4 flex items-center gap-1.5 rounded-lg border border-red-500/35 bg-red-500/15 px-4 py-2 text-sm text-red-100 hover:bg-red-500/25 disabled:opacity-40"
        >
          {busy ? <MapSpinner size={14} /> : <Trash2 size={14} />}
          清空全部业务数据
        </button>
        {message && <div className="mt-3 text-xs text-white/55">{message}</div>}
      </div>

      {result && (
        <div className="flex flex-col gap-3">
          {untouched.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-2 text-xs font-medium text-white/55">明确不删除（其他系统 / 全局）</div>
              <ul className="list-inside list-disc space-y-1 text-xs leading-5 text-white/40">
                {untouched.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
          <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-left text-xs">
            <thead className="bg-white/[0.03] text-white/45">
              <tr>
                <th className="px-4 py-2.5 font-medium">集合</th>
                <th className="px-4 py-2.5 font-medium">删除条数</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result).map(([key, count]) => (
                <tr key={key} className="border-t border-white/5">
                  <td className="px-4 py-2 font-mono text-white/60">{key}</td>
                  <td className="px-4 py-2 text-white/80">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════ 描述模板管理 ════════════════════════

function DescTemplateManager({ entityType }: { entityType: ProductEntityType }) {
  const [items, setItems] = useState<DescTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<DescTemplate | 'new' | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listDescTemplates(entityType);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [entityType]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (id: string) => {
    const res = await deleteDescTemplate(id);
    if (res.success) await reload();
  };

  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="text-xs text-white/50">
          为「{ENTITY_TYPES.find((e) => e.value === entityType)?.label}」配置描述模板，用户在详情「描述」区可一键套用，方便按统一结构编写。
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm shrink-0"
        >
          <Plus size={14} /> 新增模板
        </button>
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载模板…" />
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-4 py-10 text-center text-sm text-white/40">
          还没有描述模板。点「新增模板」创建第一个（如「用户故事」「PRD 标准结构」）。
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 divide-y divide-white/5">
          {items.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-3.5 py-2.5">
              <span className="text-sm text-white/85 truncate flex-1">{t.name}</span>
              <button onClick={() => setEditing(t)} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-white/60 hover:text-white hover:bg-white/10">
                <Save size={12} /> 编辑
              </button>
              <button onClick={() => remove(t.id)} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-300/60 hover:text-red-300 hover:bg-red-500/10">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <DescTemplateEditModal
          entityType={entityType}
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function DescTemplateEditModal({
  entityType,
  template,
  onClose,
  onSaved,
}: {
  entityType: ProductEntityType;
  template: DescTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [content, setContent] = useState(template?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isNew = !template;

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setMsg(null);
    const res = await upsertDescTemplate({ id: template?.id, entityType, name: name.trim(), content, sortOrder: template?.sortOrder ?? 0 });
    setSaving(false);
    if (res.success) onSaved();
    else setMsg(res.error?.message || '保存失败');
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3.5 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">{isNew ? '新增描述模板' : '编辑描述模板'}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">模板名称</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：用户故事 / PRD 标准结构"
              className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-white/50">模板内容（富文本，套用时填入描述）</label>
            <RichTextField value={content} onChange={setContent} minHeight={280} placeholder="编写模板骨架，如：## 背景 / ## 目标 / ## 验收标准…" />
          </div>
          {msg && <div className="text-xs text-red-300/80">{msg}</div>}
        </div>
        <div className="shrink-0 px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">取消</button>
          <button
            onClick={save}
            disabled={!name.trim() || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
          >
            {saving ? <MapSpinner size={14} /> : <Save size={14} />} {isNew ? '创建' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ════════════════════════ 产品类型管理 ════════════════════════

function CategoryManager() {
  const { categories, reload } = useProductCategories();
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#38bdf8');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!draftName.trim()) return;
    setSaving(true);
    setMsg(null);
    const res = await upsertProductCategory({ name: draftName.trim(), color: draftColor });
    setSaving(false);
    if (res.success) {
      setDraftName('');
      setDraftColor('#38bdf8');
      await reload();
    } else {
      setMsg(res.error?.message || '新增失败');
    }
  };

  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <div className="text-xs text-white/50">
        产品类型用于产品分级筛选与标记。内置 4 项（核心 / 重要 / 普通 / 实验）可改名、改色，但不可删除；自定义类型在无产品占用时可删除。
      </div>

      <div className="rounded-xl border border-white/10 divide-y divide-white/5">
        {categories.map((c) => (
          <CategoryRow key={c.id} category={c} onChanged={reload} />
        ))}
        {categories.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-white/40">正在加载产品类型…</div>
        )}
      </div>

      {/* 新增 */}
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2.5">
        <input
          type="color"
          value={draftColor}
          onChange={(e) => setDraftColor(e.target.value)}
          className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/10"
          title="选择颜色"
        />
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          placeholder="新增产品类型名称，如「战略级」"
          className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
        />
        <button
          onClick={add}
          disabled={!draftName.trim() || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
        >
          {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 新增
        </button>
      </div>
      {msg && <div className="text-xs text-red-300/80">{msg}</div>}
    </div>
  );
}

function CategoryRow({ category, onChanged }: { category: ProductCategory; onChanged: () => Promise<unknown> }) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = name.trim() !== category.name || color !== category.color;

  const save = async () => {
    if (!name.trim() || !dirty) return;
    setBusy(true);
    setErr(null);
    const res = await upsertProductCategory({ id: category.id, name: name.trim(), color, sortOrder: category.sortOrder });
    setBusy(false);
    if (res.success) await onChanged();
    else setErr(res.error?.message || '保存失败');
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    const res = await deleteProductCategory(category.id);
    setBusy(false);
    if (res.success) await onChanged();
    else setErr(res.error?.message || '删除失败');
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/10 shrink-0"
        title="选择颜色"
      />
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
        className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
      />
      {category.isBuiltin && (
        <span className="text-[10px] px-1.5 py-0.5 rounded text-white/40 border border-white/10 shrink-0">内置</span>
      )}
      {err && <span className="text-[11px] text-red-300/80 shrink-0 max-w-[160px] truncate" title={err}>{err}</span>}
      <button
        onClick={save}
        disabled={!dirty || !name.trim() || busy}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cyan-200/80 hover:text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-30 shrink-0"
      >
        {busy ? <MapSpinner size={12} /> : <Save size={12} />} 保存
      </button>
      <button
        onClick={remove}
        disabled={category.isBuiltin || busy}
        title={category.isBuiltin ? '内置类型不可删除' : '删除'}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-300/60 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 shrink-0"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// ════════════════════════ 需求类型管理 ════════════════════════

function RequirementTypeManager() {
  const { types, reload } = useRequirementTypes();
  const [draftName, setDraftName] = useState('');
  const [draftDefinition, setDraftDefinition] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!draftName.trim()) return;
    setSaving(true);
    setMsg(null);
    const res = await upsertRequirementType({ name: draftName.trim(), definition: draftDefinition.trim() });
    setSaving(false);
    if (res.success) {
      setDraftName('');
      setDraftDefinition('');
      await reload();
    } else {
      setMsg(res.error?.message || '新增失败');
    }
  };

  return (
    <div className="flex flex-col gap-3 max-w-3xl">
      <div className="text-xs text-white/50">
        需求类型用于新建需求表单与 AI 智能填充分类。每类需写清「定义」供 AI 判断；内置 5 项可改名称与定义，不可删除；自定义类型在无需求占用时可删除。
      </div>

      <div className="rounded-xl border border-white/10 divide-y divide-white/5">
        {types.map((t) => (
          <RequirementTypeRow key={t.id} item={t} onChanged={reload} />
        ))}
        {types.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-white/40">正在加载需求类型…</div>
        )}
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-white/15 px-3 py-3">
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="新增类型名称，如「安全合规」"
          className="w-full px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
        />
        <textarea
          value={draftDefinition}
          onChange={(e) => setDraftDefinition(e.target.value)}
          rows={2}
          placeholder="类型定义（AI 识别依据）：描述何种需求应归入此类…"
          className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-y min-h-[56px]"
        />
        <button
          onClick={add}
          disabled={!draftName.trim() || saving}
          className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
        >
          {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 新增类型
        </button>
      </div>
      {msg && <div className="text-xs text-red-300/80">{msg}</div>}
    </div>
  );
}

function RequirementTypeRow({ item, onChanged }: { item: RequirementType; onChanged: () => Promise<unknown> }) {
  const [name, setName] = useState(item.name);
  const [definition, setDefinition] = useState(item.definition);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = name.trim() !== item.name || definition !== item.definition;

  useEffect(() => {
    setName(item.name);
    setDefinition(item.definition);
  }, [item.id, item.name, item.definition]);

  const save = async () => {
    if (!name.trim() || !dirty) return;
    setBusy(true);
    setErr(null);
    const res = await upsertRequirementType({ id: item.id, name: name.trim(), definition: definition.trim(), sortOrder: item.sortOrder });
    setBusy(false);
    if (res.success) await onChanged();
    else setErr(res.error?.message || '保存失败');
  };

  const remove = async () => {
    setBusy(true);
    setErr(null);
    const res = await deleteRequirementType(item.id);
    setBusy(false);
    if (res.success) await onChanged();
    else setErr(res.error?.message || '删除失败');
  };

  return (
    <div className="px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 min-w-[140px] px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
        />
        {item.isBuiltin && (
          <span className="text-[10px] px-1.5 py-0.5 rounded text-white/40 border border-white/10 shrink-0">内置</span>
        )}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-white/45 hover:text-white/70 px-2 py-1 shrink-0"
        >
          {expanded ? '收起定义' : '编辑定义'}
        </button>
        {err && <span className="text-[11px] text-red-300/80 shrink-0 max-w-[140px] truncate" title={err}>{err}</span>}
        <button
          onClick={save}
          disabled={!dirty || !name.trim() || busy}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-cyan-200/80 hover:text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-30 shrink-0"
        >
          {busy ? <MapSpinner size={12} /> : <Save size={12} />} 保存
        </button>
        <button
          onClick={remove}
          disabled={item.isBuiltin || busy}
          title={item.isBuiltin ? '内置类型不可删除' : '删除'}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-300/60 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 shrink-0"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {expanded && (
        <textarea
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          rows={3}
          placeholder="类型定义：描述 AI 应如何将需求归入此类…"
          className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-xs text-white/80 outline-none focus:border-cyan-500/40 resize-y min-h-[72px]"
        />
      )}
      {!expanded && definition.trim() && (
        <p className="text-[11px] text-white/35 pl-0.5 line-clamp-2" title={definition}>{definition}</p>
      )}
    </div>
  );
}

// ════════════════════════ 表单模板编辑器 ════════════════════════
function FormTemplateEditor({ entityType, productId }: { entityType: ProductEntityType; productId: string | null }) {
  const [id, setId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listFormTemplates({ entityType, productId: productId ?? undefined });
    if (res.success) {
      const match = res.data.items.find((t) => (t.productId ?? null) === productId && t.isDefault) ?? res.data.items.find((t) => (t.productId ?? null) === productId);
      if (match) {
        setId(match.id);
        setName(match.name);
        setFields([...match.fields].sort((a, b) => a.sortOrder - b.sortOrder));
      } else {
        setId(undefined);
        setName(`${ENTITY_TYPES.find((e) => e.value === entityType)?.label}默认表单`);
        setFields([]);
      }
    }
    setLoading(false);
  }, [entityType, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addField = () => setFields((f) => [...f, { key: `field_${f.length + 1}`, label: '', type: 'text', required: false, sortOrder: f.length }]);
  const updateField = (i: number, patch: Partial<FormField>) => setFields((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const removeField = (i: number) => setFields((f) => f.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => setFields((f) => {
    const j = i + dir;
    if (j < 0 || j >= f.length) return f;
    const next = [...f];
    [next[i], next[j]] = [next[j], next[i]];
    return next.map((x, idx) => ({ ...x, sortOrder: idx }));
  });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const res = await upsertFormTemplate({
      id,
      name: name.trim() || '默认表单',
      entityType,
      fields: fields.map((f, idx) => ({ ...f, sortOrder: idx })),
      isDefault: true,
      productId,
    });
    setSaving(false);
    if (res.success) {
      setMsg('已保存');
      await load();
    } else {
      setMsg(res.error?.message ?? '保存失败');
    }
  };

  if (loading) return <MapSectionLoader text="正在加载模板…" />;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名称" className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
        <button onClick={save} disabled={saving} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50">
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} 保存
        </button>
        {msg && <span className="text-xs text-white/50">{msg}</span>}
      </div>

      {/* 系统预置字段：页面原生渲染，锁定不可改 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.015] p-3">
        <div className="text-xs font-medium text-white/50 mb-2">系统预置字段（页面原生渲染，不可修改）</div>
        <div className="flex flex-wrap gap-1.5">
          {(PRESET_FIELDS[entityType] ?? []).map((p, i) => (
            <span key={i} className="text-[11px] px-2 py-1 rounded bg-white/5 border border-white/10 text-white/55">
              {p.label}
              <span className="text-white/30"> · {p.type}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="text-xs font-medium text-white/50">额外自定义字段（存入 FormData，按需补充，勿与上方预置重复）</div>
      <div className="flex flex-col gap-2">
        {fields.length === 0 && <div className="text-xs text-white/35 py-3 text-center">还没有额外字段，点下方「添加字段」补充预置之外的信息。</div>}
        {fields.map((f, i) => (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="flex flex-col">
                <button onClick={() => move(i, -1)} className="text-white/30 hover:text-white text-[10px] leading-none">▲</button>
                <button onClick={() => move(i, 1)} className="text-white/30 hover:text-white text-[10px] leading-none">▼</button>
              </div>
              <GripVertical size={14} className="text-white/20" />
              <input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="字段标签（如：需求背景）" className="flex-1 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
              <input value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} placeholder="key" className="w-28 px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none" />
              <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value as FormFieldType })} className="px-2 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none">
                {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="flex items-center gap-1 text-xs text-white/50">
                <input type="checkbox" checked={f.required} onChange={(e) => updateField(i, { required: e.target.checked })} className="accent-cyan-500" /> 必填
              </label>
              <button onClick={() => removeField(i)} className="text-white/30 hover:text-red-300"><Trash2 size={14} /></button>
            </div>
            {HAS_OPTIONS.has(f.type) && (
              <textarea
                value={(f.options ?? []).map((o) => o.label).join('\n')}
                onChange={(e) => updateField(i, { options: e.target.value.split('\n').filter((l) => l.trim()).map((l) => ({ value: l.trim(), label: l.trim() })) })}
                rows={2}
                placeholder="每行一个选项"
                className="px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-white/80 outline-none resize-none"
              />
            )}
            {f.type === 'relation' && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-white/40">关联对象类型</span>
                <select
                  value={f.relationEntityType ?? ''}
                  onChange={(e) => updateField(i, { relationEntityType: e.target.value })}
                  className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-xs text-white/70 outline-none"
                >
                  <option value="">请选择</option>
                  {RELATION_TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        ))}
      </div>
      <button onClick={addField} className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm">
        <Plus size={14} /> 添加字段
      </button>
    </div>
  );
}
