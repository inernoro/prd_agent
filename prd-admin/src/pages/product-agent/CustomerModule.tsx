/**
 * 产品管理 — 客户模块。
 *
 * 两个平级子模块：
 *   客户管理：列表（可新增，按客户表单配置渲染自定义字段）→ 详情（基本信息 + 动态跟进）
 *   营销问策：独立智能体（自带客户选择器）。列表/详情提供「营销问策」快捷入口，
 *             点击把该客户作为上下文带入营销问策子模块。
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Plus, Search, Trash2, Save, Clock, User as UserIcon, Sparkles } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  listCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomerFollowUps,
  createCustomerFollowUp,
  deleteCustomerFollowUp,
} from '@/services/real/productAgent';
import type { Customer, CustomerFollowUp } from './types';
import { RichTextField, useEffectiveTemplate, FormFieldsRenderer } from './DynamicForm';
import { MarketingConsultPanel } from './MarketingConsultPanel';

const CERT_STATUS_OPTIONS = ['未认证', '已认证', '认证失败'];
const FOLLOW_UP_PLACEHOLDER =
  '客户在什么时间做了什么事情；客户有什么新的动态；客户提了什么需求或者遇到了什么问题；我们与客户达成了什么共识等等。';

type SubModule = 'manage' | 'consult';

export function CustomerModule({ isAdmin }: { isAdmin: boolean }) {
  const [subModule, setSubModule] = useState<SubModule>('manage');
  const [consultCustomerId, setConsultCustomerId] = useState<string | null>(null);

  const goConsult = (customerId: string) => {
    setConsultCustomerId(customerId);
    setSubModule('consult');
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SubModuleTab on={subModule === 'manage'} onClick={() => setSubModule('manage')}>客户管理</SubModuleTab>
        <SubModuleTab on={subModule === 'consult'} onClick={() => setSubModule('consult')}>营销问策</SubModuleTab>
      </div>
      {subModule === 'manage'
        ? <CustomerManage isAdmin={isAdmin} onConsult={goConsult} />
        : <CustomerConsultSubModule initialCustomerId={consultCustomerId} />}
    </div>
  );
}

function SubModuleTab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3.5 py-1.5 text-sm ${on ? 'border-cyan-500/45 bg-cyan-500/15 text-cyan-200' : 'border-white/10 text-white/55 hover:bg-white/5'}`}
    >
      {children}
    </button>
  );
}

// ════════════════════════ 客户管理（列表 + 详情） ════════════════════════

function CustomerManage({ isAdmin, onConsult }: { isAdmin: boolean; onConsult: (customerId: string) => void }) {
  const [rows, setRows] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Customer | 'new' | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listCustomers({ keyword: keyword.trim() || undefined });
    if (res.success) setRows(res.data.items);
    setLoading(false);
  }, [keyword]);
  useEffect(() => { void reload(); }, [reload]);

  if (selected) {
    return (
      <CustomerDetail
        customer={selected === 'new' ? null : selected}
        isAdmin={isAdmin}
        onBack={() => setSelected(null)}
        onSavedNew={(c) => setSelected(c)}
        onDeleted={() => { setSelected(null); void reload(); }}
        onUpdated={() => void reload()}
        onConsult={onConsult}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
          <Search size={14} className="text-white/40" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索商户名称 / 编号"
            className="w-48 bg-transparent text-sm text-white outline-none"
          />
        </div>
        <button
          onClick={() => setSelected('new')}
          className="ml-auto flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/15 px-2.5 py-1 text-xs text-cyan-300 hover:bg-cyan-500/25"
        >
          <Plus size={13} /> 新增客户
        </button>
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载客户…" />
      ) : rows.length === 0 ? (
        <div className="py-12 text-center text-sm text-white/40">还没有客户。点击右上角「新增客户」录入，需求里即可关联。</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/[0.03] text-xs text-white/45">
              <tr>
                <th className="px-4 py-2.5 font-medium">商户编号</th>
                <th className="px-4 py-2.5 font-medium">商户名称</th>
                <th className="px-4 py-2.5 font-medium">简称</th>
                <th className="px-4 py-2.5 font-medium">认证状态</th>
                <th className="px-4 py-2.5 font-medium">区域</th>
                <th className="px-4 py-2.5 font-medium">行业</th>
                <th className="px-4 py-2.5 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="group cursor-pointer border-t border-white/5 hover:bg-white/[0.03]"
                >
                  <td className="px-4 py-3 font-mono text-xs text-white/45">{c.merchantNo || '-'}</td>
                  <td className="px-4 py-3 text-white/90">{c.name}</td>
                  <td className="px-4 py-3 text-xs text-white/55">{c.shortName || '-'}</td>
                  <td className="px-4 py-3 text-xs"><CertBadge value={c.certStatus} /></td>
                  <td className="px-4 py-3 text-xs text-white/55">{c.region || '-'}</td>
                  <td className="px-4 py-3 text-xs text-white/55">{c.industry || '-'}</td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => onConsult(c.id)}
                      title="带该客户信息去营销问策"
                      className="inline-flex items-center gap-1 rounded-md border border-cyan-500/25 px-2 py-1 text-[11px] text-cyan-300/90 opacity-0 hover:bg-cyan-500/15 group-hover:opacity-100"
                    >
                      <Sparkles size={11} /> 营销问策
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CertBadge({ value }: { value?: string | null }) {
  if (!value) return <span className="text-white/35">-</span>;
  const tone =
    value === '已认证' ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300'
      : value === '认证失败' ? 'border-rose-400/25 bg-rose-400/10 text-rose-300'
        : 'border-white/15 bg-white/5 text-white/60';
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>{value}</span>;
}

// ── 客户详情（基本信息 + 动态跟进） ──

type DetailTab = 'info' | 'follow-up';

function CustomerDetail({
  customer,
  isAdmin,
  onBack,
  onSavedNew,
  onDeleted,
  onUpdated,
  onConsult,
}: {
  customer: Customer | null;
  isAdmin: boolean;
  onBack: () => void;
  onSavedNew: (c: Customer) => void;
  onDeleted: () => void;
  onUpdated: () => void;
  onConsult: (customerId: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>('info');
  const isNew = !customer;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-white/45 hover:text-white">
          <ArrowLeft size={13} /> 返回客户列表
        </button>
        <h3 className="text-base font-semibold text-white">{isNew ? '新增客户' : customer!.name}</h3>
        {!isNew && (
          <button
            onClick={() => onConsult(customer!.id)}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-cyan-500/30 bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/25"
          >
            <Sparkles size={13} /> 营销问策
          </button>
        )}
      </div>

      {!isNew && (
        <div className="flex flex-wrap items-center gap-2">
          <TabBtn on={tab === 'info'} onClick={() => setTab('info')}>基本信息</TabBtn>
          <TabBtn on={tab === 'follow-up'} onClick={() => setTab('follow-up')}>动态跟进</TabBtn>
        </div>
      )}

      {(isNew || tab === 'info') && (
        <CustomerInfoForm
          customer={customer}
          isAdmin={isAdmin}
          onSavedNew={onSavedNew}
          onDeleted={onDeleted}
          onUpdated={onUpdated}
        />
      )}
      {!isNew && tab === 'follow-up' && <FollowUpTimeline customerId={customer!.id} />}
    </div>
  );
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-3 py-1 text-sm ${on ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200' : 'border-white/10 text-white/50 hover:bg-white/5'}`}
    >
      {children}
    </button>
  );
}

// ── 客户信息（基础商户字段 + 按客户表单配置的自定义字段） ──

const inputCls = 'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25';

function CustomerInfoForm({
  customer,
  isAdmin,
  onSavedNew,
  onDeleted,
  onUpdated,
}: {
  customer: Customer | null;
  isAdmin: boolean;
  onSavedNew: (c: Customer) => void;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const [merchantNo, setMerchantNo] = useState(customer?.merchantNo ?? '');
  const [name, setName] = useState(customer?.name ?? '');
  const [shortName, setShortName] = useState(customer?.shortName ?? '');
  const [status, setStatus] = useState(customer?.status ?? '');
  const [certStatus, setCertStatus] = useState(customer?.certStatus ?? '');
  const [region, setRegion] = useState(customer?.region ?? '');
  const [industry, setIndustry] = useState(customer?.industry ?? '');
  const [openedAt, setOpenedAt] = useState(toDateInput(customer?.openedAt));
  const [expireAt, setExpireAt] = useState(toDateInput(customer?.expireAt));
  const [company, setCompany] = useState(customer?.company ?? '');
  const [contact, setContact] = useState(customer?.contact ?? '');
  const [tagsText, setTagsText] = useState((customer?.tags ?? []).join(', '));
  const [description, setDescription] = useState(customer?.description ?? '');
  const [formData, setFormData] = useState<Record<string, string>>(customer?.formData ?? {});
  const [saving, setSaving] = useState(false);

  // 「按配置项」：客户表单模板定义的自定义字段（设置 → 客户 → 客户表单）
  const { template } = useEffectiveTemplate('customer', null);
  const customFields = template?.fields ?? [];

  const save = async () => {
    if (!name.trim()) { toast.error('请填写商户名称'); return; }
    setSaving(true);
    const body = {
      merchantNo: merchantNo.trim() || null,
      name: name.trim(),
      shortName: shortName.trim() || null,
      status: status.trim() || null,
      certStatus: certStatus || null,
      region: region.trim() || null,
      industry: industry.trim() || null,
      openedAt: openedAt || null,
      expireAt: expireAt || null,
      company: company.trim() || null,
      contact: contact.trim() || null,
      description: description.trim() || null,
      tags: tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      templateId: template?.id ?? null,
      formData,
    };
    const res = customer ? await updateCustomer(customer.id, body) : await createCustomer(body);
    setSaving(false);
    if (res.success) {
      toast.success(customer ? '已保存' : '已创建');
      if (customer) onUpdated();
      else onSavedNew(res.data);
    } else {
      toast.error('保存失败', res.error?.message);
    }
  };

  const onDelete = async () => {
    if (!customer) return;
    const ok = await systemDialog.confirm({ title: '删除客户', message: `删除客户「${customer.name}」？已关联的需求不受影响（仅解除显示）。`, tone: 'danger', confirmText: '删除', cancelText: '取消' });
    if (!ok) return;
    const res = await deleteCustomer(customer.id);
    if (res.success) { toast.success('已删除'); onDeleted(); }
    else toast.error('删除失败', res.error?.message);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="商户编号"><input value={merchantNo} onChange={(e) => setMerchantNo(e.target.value)} placeholder="如 M10001" className={inputCls} /></Field>
        <Field label="商户名称 *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="商户全称" className={inputCls} /></Field>
        <Field label="商户简称"><input value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="简称" className={inputCls} /></Field>
        <Field label="商户状态"><input value={status} onChange={(e) => setStatus(e.target.value)} placeholder="如 正常 / 停用" className={inputCls} /></Field>
        <Field label="认证状态">
          <select value={certStatus} onChange={(e) => setCertStatus(e.target.value)} className={inputCls}>
            <option value="">未填写</option>
            {CERT_STATUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="所在区域"><input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="如 华南 / 广东深圳" className={inputCls} /></Field>
        <Field label="所属行业"><input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="如 快消 / 餐饮" className={inputCls} /></Field>
        <Field label="开户时间"><input type="date" value={openedAt} onChange={(e) => setOpenedAt(e.target.value)} className={inputCls} /></Field>
        <Field label="过期时间"><input type="date" value={expireAt} onChange={(e) => setExpireAt(e.target.value)} className={inputCls} /></Field>
        <Field label="所属公司"><input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="所属公司 / 组织" className={inputCls} /></Field>
        <Field label="联系方式"><input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="电话 / 邮箱 / 微信" className={inputCls} /></Field>
        <Field label="标签"><input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="逗号分隔，如：核心, 金融" className={inputCls} /></Field>
      </div>
      <Field label="备注">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="客户描述 / 备注" className={`${inputCls} resize-none`} />
      </Field>

      {customFields.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-xs font-medium text-white/55">自定义字段（按「设置 → 客户 → 客户表单」配置）</div>
          <FormFieldsRenderer
            fields={customFields}
            values={formData}
            onChange={(key, value) => setFormData((p) => ({ ...p, [key]: value }))}
            productId={null}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving || !name.trim()} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40">
          {saving ? <MapSpinner size={14} /> : <Save size={14} />} {customer ? '保存' : '创建客户'}
        </button>
        {customer && isAdmin && (
          <button onClick={onDelete} className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200 hover:bg-red-500/20">
            <Trash2 size={14} /> 删除
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}

// ── 动态跟进 ──

function FollowUpTimeline({ customerId }: { customerId: string }) {
  const [items, setItems] = useState<CustomerFollowUp[]>([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listCustomerFollowUps(customerId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [customerId]);
  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    const trimmed = content.replace(/<[^>]*>/g, '').trim();
    if (!trimmed) { toast.error('请填写跟进内容'); return; }
    setSaving(true);
    const res = await createCustomerFollowUp(customerId, { content });
    setSaving(false);
    if (res.success) { setContent(''); void reload(); }
    else toast.error('保存失败', res.error?.message);
  };

  const remove = async (f: CustomerFollowUp) => {
    const ok = await systemDialog.confirm({ title: '删除跟进', message: '删除这条动态跟进记录？', tone: 'danger', confirmText: '删除', cancelText: '取消' });
    if (!ok) return;
    const res = await deleteCustomerFollowUp(f.id);
    if (res.success) void reload();
    else toast.error('删除失败', res.error?.message);
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <RichTextField value={content} onChange={setContent} minHeight={120} placeholder={FOLLOW_UP_PLACEHOLDER} />
        <div className="mt-2 flex justify-end">
          <button onClick={add} disabled={saving} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-3 py-1.5 text-sm text-cyan-200 disabled:opacity-40">
            {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 添加跟进
          </button>
        </div>
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载跟进记录…" />
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-sm text-white/40">还没有跟进记录。在上方记录客户的动态、需求或共识。</div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((f) => (
            <div key={f.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <div className="mb-2 flex items-center gap-3 text-[11px] text-white/40">
                <span className="flex items-center gap-1"><UserIcon size={11} /> {f.createdByName || '—'}</span>
                <span className="flex items-center gap-1"><Clock size={11} /> {fmtTime(f.createdAt)}</span>
                <button onClick={() => remove(f)} className="ml-auto text-white/30 hover:text-red-300" title="删除"><Trash2 size={12} /></button>
              </div>
              <div className="prose-sm text-sm leading-relaxed text-white/80 [&_*]:!text-white/80" dangerouslySetInnerHTML={{ __html: f.content }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════ 营销问策（独立子模块） ════════════════════════

function CustomerConsultSubModule({ initialCustomerId }: { initialCustomerId: string | null }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialCustomerId);

  useEffect(() => {
    void (async () => {
      const res = await listCustomers({});
      if (res.success) setCustomers(res.data.items);
      setLoading(false);
    })();
  }, []);

  // 从快捷入口带入的客户
  useEffect(() => {
    if (initialCustomerId) setSelectedId(initialCustomerId);
  }, [initialCustomerId]);

  const selected = customers.find((c) => c.id === selectedId) ?? null;
  const filtered = keyword.trim()
    ? customers.filter((c) => `${c.name} ${c.merchantNo ?? ''} ${c.shortName ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase()))
    : customers;

  if (loading) return <MapSectionLoader text="正在加载客户…" />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-cyan-300" />
          <span className="text-sm font-medium text-white/80">营销问策智能体</span>
          <span className="text-xs text-white/40">选择一个客户，结合其全部信息与问策知识库做专业营销评估</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
            <Search size={14} className="text-white/40" />
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索客户" className="w-44 bg-transparent text-sm text-white outline-none" />
          </div>
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className="min-w-[200px] rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-500/40"
          >
            <option value="">选择客户…</option>
            {filtered.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.merchantNo ? `（${c.merchantNo}）` : ''}</option>
            ))}
          </select>
        </div>
      </div>

      {selected ? (
        <MarketingConsultPanel key={selected.id} customerId={selected.id} customerName={selected.name} />
      ) : customers.length === 0 ? (
        <div className="py-12 text-center text-sm text-white/40">还没有客户。请先在「客户管理」新增客户，再来做营销问策。</div>
      ) : (
        <div className="py-12 text-center text-sm text-white/40">请在上方选择一个客户开始营销问策。</div>
      )}
    </div>
  );
}

// ── 工具 ──

function toDateInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
