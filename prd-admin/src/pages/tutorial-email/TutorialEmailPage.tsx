import { useCallback, useEffect, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import {
  Mail, Plus, Trash2, Play, Eye, Users, FileText, Image, Send,
  ChevronDown, ChevronUp, Clock, CheckCircle, XCircle, Pause,
} from 'lucide-react';
import {
  listTutorialEmailSequences,
  createTutorialEmailSequence,
  updateTutorialEmailSequence,
  deleteTutorialEmailSequence,
  listTutorialEmailTemplates,
  createTutorialEmailTemplate,
  updateTutorialEmailTemplate,
  deleteTutorialEmailTemplate,
  listTutorialEmailAssets,
  createTutorialEmailAsset,
  deleteTutorialEmailAsset,
  listTutorialEmailEnrollments,
  batchEnrollTutorialEmail,
  unsubscribeTutorialEmailEnrollment,
  testSendTutorialEmail,
} from '@/services';
import type {
  TutorialEmailSequence,
  TutorialEmailTemplate,
  TutorialEmailAsset,
  TutorialEmailEnrollment,
  TutorialEmailStep,
} from '@/services';
import { toast } from '@/lib/toast';

const tabs = [
  { key: 'sequences', label: '邮件序列', icon: <Mail size={14} /> },
  { key: 'templates', label: '邮件模板', icon: <FileText size={14} /> },
  { key: 'assets', label: '截图素材', icon: <Image size={14} /> },
  { key: 'enrollments', label: '发送记录', icon: <Users size={14} /> },
];

export default function TutorialEmailPage() {
  const [activeTab, setActiveTab] = useState('sequences');

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Mail size={24} style={{ color: 'var(--text-primary)' }} />
        <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          教程邮件
        </h1>
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          配置截图教程邮件序列，定期向用户发送产品使用教程
        </span>
      </div>

      <TabBar
        items={tabs}
        activeKey={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === 'sequences' && <SequencesTab />}
      {activeTab === 'templates' && <TemplatesTab />}
      {activeTab === 'assets' && <AssetsTab />}
      {activeTab === 'enrollments' && <EnrollmentsTab />}
    </div>
  );
}

// ========== Sequences Tab ==========

function SequencesTab() {
  const [sequences, setSequences] = useState<TutorialEmailSequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTutorialEmailSequences();
    if (res.success) setSequences(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (data: {
    sequenceKey: string;
    name: string;
    description?: string;
    triggerType?: string;
    steps?: TutorialEmailStep[];
  }) => {
    const res = await createTutorialEmailSequence(data);
    if (res.success) {
      toast.success('序列创建成功');
      setShowCreate(false);
      void load();
    } else {
      toast.error(res.error?.message || '创建失败');
    }
  };

  const handleToggle = async (seq: TutorialEmailSequence) => {
    const res = await updateTutorialEmailSequence(seq.id, { isActive: !seq.isActive });
    if (res.success) {
      toast.success(seq.isActive ? '已暂停' : '已启用');
      void load();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此序列？')) return;
    const res = await deleteTutorialEmailSequence(id);
    if (res.success) {
      toast.success('已删除');
      void load();
    }
  };

  const triggerTypeLabel: Record<string, string> = {
    registration: '注册后自动',
    manual: '手动触发',
    'feature-release': '版本发布',
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          共 {sequences.length} 个序列
        </span>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus size={14} /> 新建序列
        </Button>
      </div>

      {showCreate && (
        <GlassCard animated className="p-4">
          <SequenceForm
            onSubmit={handleCreate}
            onCancel={() => setShowCreate(false)}
          />
        </GlassCard>
      )}

      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : sequences.length === 0 ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
          暂无序列，点击"新建序列"开始
        </div>
      ) : (
        sequences.map((seq) => (
          <GlassCard key={seq.id} animated className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: seq.isActive ? 'var(--color-success)' : 'var(--text-muted)' }}
                />
                <div>
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {seq.name}
                    <span className="ml-2 text-xs font-mono px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                      {seq.sequenceKey}
                    </span>
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {triggerTypeLabel[seq.triggerType] || seq.triggerType} · {seq.steps.length} 个步骤
                    {seq.description && ` · ${seq.description}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggle(seq)}
                  className="p-1.5 rounded-md transition-colors hover:opacity-80"
                  style={{ color: seq.isActive ? 'var(--color-success)' : 'var(--text-muted)' }}
                  title={seq.isActive ? '暂停' : '启用'}
                >
                  {seq.isActive ? <Play size={14} /> : <Pause size={14} />}
                </button>
                <button
                  onClick={() => setExpandedId(expandedId === seq.id ? null : seq.id)}
                  className="p-1.5 rounded-md transition-colors hover:opacity-80"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {expandedId === seq.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </button>
                <button
                  onClick={() => handleDelete(seq.id)}
                  className="p-1.5 rounded-md transition-colors hover:opacity-80"
                  style={{ color: 'var(--color-danger)' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {expandedId === seq.id && (
              <div className="mt-3 pt-3 space-y-2" style={{ borderTop: '1px solid var(--border-default)' }}>
                {seq.steps.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无步骤</div>
                ) : (
                  seq.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs p-2 rounded"
                      style={{ background: 'var(--bg-base)' }}>
                      <Clock size={12} style={{ color: 'var(--text-muted)' }} />
                      <span style={{ color: 'var(--text-secondary)' }}>
                        Day {step.dayOffset}
                      </span>
                      <span style={{ color: 'var(--text-primary)' }}>
                        {step.subject}
                      </span>
                      <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
                        {step.templateId}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </GlassCard>
        ))
      )}
    </div>
  );
}

function SequenceForm({ onSubmit, onCancel }: {
  onSubmit: (data: { sequenceKey: string; name: string; description?: string; triggerType?: string; steps?: TutorialEmailStep[] }) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [trigger, setTrigger] = useState('manual');

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>新建邮件序列</div>
      <div className="grid grid-cols-2 gap-3">
        <input
          placeholder="序列 Key（如 onboarding）"
          value={key} onChange={(e) => setKey(e.target.value)}
          className="px-3 py-2 text-sm rounded-md"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
        />
        <input
          placeholder="序列名称"
          value={name} onChange={(e) => setName(e.target.value)}
          className="px-3 py-2 text-sm rounded-md"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
        />
      </div>
      <input
        placeholder="描述（可选）"
        value={desc} onChange={(e) => setDesc(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      />
      <select
        value={trigger} onChange={(e) => setTrigger(e.target.value)}
        className="px-3 py-2 text-sm rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      >
        <option value="manual">手动触发</option>
        <option value="registration">注册后自动</option>
        <option value="feature-release">版本发布</option>
      </select>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" onClick={() => onSubmit({ sequenceKey: key, name, description: desc || undefined, triggerType: trigger })}>
          创建
        </Button>
      </div>
    </div>
  );
}

// ========== Templates Tab ==========

function TemplatesTab() {
  const [templates, setTemplates] = useState<TutorialEmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTutorialEmailTemplates();
    if (res.success) setTemplates(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (data: { name: string; htmlContent: string }) => {
    const res = await createTutorialEmailTemplate(data);
    if (res.success) {
      toast.success('模板创建成功');
      setShowCreate(false);
      void load();
    } else {
      toast.error(res.error?.message || '创建失败');
    }
  };

  const handleUpdate = async (id: string, data: { name?: string; htmlContent?: string }) => {
    const res = await updateTutorialEmailTemplate(id, data);
    if (res.success) {
      toast.success('已保存');
      setEditingId(null);
      void load();
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此模板？')) return;
    const res = await deleteTutorialEmailTemplate(id);
    if (res.success) {
      toast.success('已删除');
      void load();
    }
  };

  const handleTestSend = async (templateId: string) => {
    const email = prompt('输入测试邮箱地址：');
    if (!email) return;
    const res = await testSendTutorialEmail({ email, templateId });
    if (res.success && res.data.success) {
      toast.success('测试邮件已发送');
    } else {
      toast.error('发送失败，请检查 SMTP 配置');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          共 {templates.length} 个模板
        </span>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus size={14} /> 新建模板
        </Button>
      </div>

      {showCreate && (
        <GlassCard animated className="p-4">
          <TemplateForm
            onSubmit={handleCreate}
            onCancel={() => setShowCreate(false)}
          />
        </GlassCard>
      )}

      {/* Preview modal - 使用 sandbox iframe 隔离 HTML 内容 */}
      {previewHtml && (
        <div className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={() => setPreviewHtml(null)}>
          <div className="max-w-2xl w-full max-h-[80vh] rounded-lg overflow-hidden"
            style={{ background: 'white' }}
            onClick={(e) => e.stopPropagation()}>
            <iframe
              srcDoc={previewHtml}
              sandbox=""
              className="w-full border-0"
              style={{ height: '70vh' }}
              title="邮件模板预览"
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : templates.length === 0 ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
          暂无模板，点击"新建模板"开始
        </div>
      ) : (
        templates.map((tpl) => (
          <GlassCard key={tpl.id} animated className="p-4">
            {editingId === tpl.id ? (
              <TemplateForm
                initial={tpl}
                onSubmit={(data) => handleUpdate(tpl.id, data)}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {tpl.name}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    ID: {tpl.id} · 变量: {tpl.variables.length > 0 ? tpl.variables.join(', ') : '无'}
                    · {new Date(tpl.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPreviewHtml(tpl.htmlContent)}
                    className="p-1.5 rounded-md transition-colors hover:opacity-80"
                    style={{ color: 'var(--text-secondary)' }}
                    title="预览"
                  >
                    <Eye size={14} />
                  </button>
                  <button
                    onClick={() => handleTestSend(tpl.id)}
                    className="p-1.5 rounded-md transition-colors hover:opacity-80"
                    style={{ color: 'var(--color-info)' }}
                    title="测试发送"
                  >
                    <Send size={14} />
                  </button>
                  <button
                    onClick={() => setEditingId(tpl.id)}
                    className="p-1.5 rounded-md transition-colors hover:opacity-80"
                    style={{ color: 'var(--text-secondary)' }}
                    title="编辑"
                  >
                    <FileText size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(tpl.id)}
                    className="p-1.5 rounded-md transition-colors hover:opacity-80"
                    style={{ color: 'var(--color-danger)' }}
                    title="删除"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )}
          </GlassCard>
        ))
      )}
    </div>
  );
}

function TemplateForm({ initial, onSubmit, onCancel }: {
  initial?: TutorialEmailTemplate;
  onSubmit: (data: { name: string; htmlContent: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [html, setHtml] = useState(initial?.htmlContent || getDefaultTemplate());

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
        {initial ? '编辑模板' : '新建邮件模板'}
      </div>
      <input
        placeholder="模板名称"
        value={name} onChange={(e) => setName(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      />
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        支持变量：{'{{userName}}'}, {'{{productName}}'}, {'{{stepNumber}}'}, {'{{totalSteps}}'}
      </div>
      <textarea
        value={html} onChange={(e) => setHtml(e.target.value)}
        rows={16}
        className="w-full px-3 py-2 text-xs font-mono rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" onClick={() => onSubmit({ name, htmlContent: html })}>
          {initial ? '保存' : '创建'}
        </Button>
      </div>
    </div>
  );
}

// ========== Assets Tab ==========

function AssetsTab() {
  const [assets, setAssets] = useState<TutorialEmailAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTutorialEmailAssets();
    if (res.success) setAssets(res.data.items);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (data: { fileName: string; fileUrl: string; tags?: string[] }) => {
    const res = await createTutorialEmailAsset(data);
    if (res.success) {
      toast.success('素材添加成功');
      setShowCreate(false);
      void load();
    } else {
      toast.error(res.error?.message || '添加失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此素材？')) return;
    const res = await deleteTutorialEmailAsset(id);
    if (res.success) {
      toast.success('已删除');
      void load();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          共 {assets.length} 个素材
        </span>
        <Button onClick={() => setShowCreate(true)} size="sm">
          <Plus size={14} /> 添加素材
        </Button>
      </div>

      {showCreate && (
        <GlassCard animated className="p-4">
          <AssetForm onSubmit={handleCreate} onCancel={() => setShowCreate(false)} />
        </GlassCard>
      )}

      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : assets.length === 0 ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
          暂无素材，点击"添加素材"上传截图 URL
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {assets.map((asset) => (
            <GlassCard key={asset.id} animated className="p-3">
              <div className="aspect-video rounded-md overflow-hidden mb-2"
                style={{ background: 'var(--bg-base)' }}>
                <img
                  src={asset.fileUrl}
                  alt={asset.fileName}
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
              <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                {asset.fileName}
              </div>
              <div className="flex items-center justify-between mt-1">
                <div className="flex gap-1">
                  {asset.tags.map((tag) => (
                    <span key={tag} className="text-[10px] px-1 py-0.5 rounded"
                      style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                      {tag}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => handleDelete(asset.id)}
                  className="p-1 rounded-md transition-colors hover:opacity-80"
                  style={{ color: 'var(--color-danger)' }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetForm({ onSubmit, onCancel }: {
  onSubmit: (data: { fileName: string; fileUrl: string; tags?: string[] }) => void;
  onCancel: () => void;
}) {
  const [fileName, setFileName] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [tags, setTags] = useState('');

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>添加截图素材</div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        将截图上传到 CDN/OSS 后，在此处记录 URL
      </div>
      <input
        placeholder="文件名（如 day1-quickstart.png）"
        value={fileName} onChange={(e) => setFileName(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      />
      <input
        placeholder="CDN/OSS 公网 URL"
        value={fileUrl} onChange={(e) => setFileUrl(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      />
      <input
        placeholder="标签（逗号分隔，如 v2.0, quickstart）"
        value={tags} onChange={(e) => setTags(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-md"
        style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
      />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
        <Button size="sm" onClick={() => onSubmit({
          fileName,
          fileUrl,
          tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        })}>
          添加
        </Button>
      </div>
    </div>
  );
}

// ========== Enrollments Tab ==========

function EnrollmentsTab() {
  const [enrollments, setEnrollments] = useState<TutorialEmailEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [sequences, setSequences] = useState<TutorialEmailSequence[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await listTutorialEmailEnrollments(statusFilter ? { status: statusFilter } : undefined);
    if (res.success) setEnrollments(res.data.items);
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    listTutorialEmailSequences().then((res) => {
      if (res.success) setSequences(res.data.items);
    });
  }, []);

  const handleBatchEnroll = async () => {
    if (sequences.length === 0) {
      toast.error('请先创建邮件序列');
      return;
    }
    const seqKey = prompt(
      `请输入要批量注册的序列 Key：\n可选: ${sequences.map((s) => s.sequenceKey).join(', ')}`,
      sequences[0]?.sequenceKey,
    );
    if (!seqKey) return;
    if (!confirm(`将为所有有邮箱的活跃用户注册序列 "${seqKey}"，继续？`)) return;
    const res = await batchEnrollTutorialEmail({ sequenceKey: seqKey });
    if (res.success) {
      toast.success(`已注册 ${res.data.enrolled} 人，跳过 ${res.data.skipped} 人`);
      void load();
    } else {
      toast.error(res.error?.message || '批量注册失败');
    }
  };

  const handleUnsubscribe = async (id: string) => {
    const res = await unsubscribeTutorialEmailEnrollment(id);
    if (res.success) {
      toast.success('已退订');
      void load();
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'active': return <Clock size={12} style={{ color: 'var(--color-info)' }} />;
      case 'completed': return <CheckCircle size={12} style={{ color: 'var(--color-success)' }} />;
      case 'unsubscribed': return <XCircle size={12} style={{ color: 'var(--text-muted)' }} />;
      default: return null;
    }
  };

  const statusLabel: Record<string, string> = {
    active: '进行中',
    completed: '已完成',
    unsubscribed: '已退订',
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2 py-1 text-xs rounded-md"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
          >
            <option value="">全部状态</option>
            <option value="active">进行中</option>
            <option value="completed">已完成</option>
            <option value="unsubscribed">已退订</option>
          </select>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            共 {enrollments.length} 条
          </span>
        </div>
        <Button onClick={handleBatchEnroll} size="sm">
          <Users size={14} /> 批量注册
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>加载中...</div>
      ) : enrollments.length === 0 ? (
        <div className="text-center py-8" style={{ color: 'var(--text-muted)' }}>
          暂无发送记录
        </div>
      ) : (
        <div className="space-y-2">
          {enrollments.map((enr) => (
            <GlassCard key={enr.id} animated className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {statusIcon(enr.status)}
                  <div>
                    <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      {enr.email}
                      <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {enr.sequenceKey}
                      </span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {statusLabel[enr.status] || enr.status}
                      · 步骤 {enr.currentStepIndex + 1}
                      · 已发送 {enr.sentHistory.filter((s) => s.success).length} 封
                      {enr.nextSendAt && ` · 下次: ${new Date(enr.nextSendAt).toLocaleString()}`}
                    </div>
                  </div>
                </div>
                {enr.status === 'active' && (
                  <button
                    onClick={() => handleUnsubscribe(enr.id)}
                    className="text-xs px-2 py-1 rounded-md"
                    style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-default)' }}
                  >
                    退订
                  </button>
                )}
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}

// ========== Default Template ==========

function getDefaultTemplate(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{productName}} 教程</title>
</head>
<body style="margin:0; padding:0; background-color:#f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px; margin:0 auto; background-color:#ffffff;">
    <!-- Header -->
    <tr>
      <td style="padding:32px 24px; text-align:center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
        <h1 style="color:#ffffff; margin:0; font-size:24px;">{{productName}}</h1>
        <p style="color:rgba(255,255,255,0.8); margin:8px 0 0; font-size:14px;">Step {{stepNumber}} of {{totalSteps}}</p>
      </td>
    </tr>

    <!-- Body -->
    <tr>
      <td style="padding:32px 24px;">
        <p style="font-size:16px; color:#333; margin:0 0 16px;">Hi {{userName}},</p>
        <p style="font-size:14px; color:#666; line-height:1.6; margin:0 0 24px;">
          Welcome to your tutorial! Here's what you'll learn today...
        </p>

        <!-- Screenshot placeholder -->
        <div style="background:#f0f0f0; border-radius:8px; padding:40px; text-align:center; margin:0 0 24px;">
          <p style="color:#999; font-size:14px; margin:0;">[ Insert screenshot here ]</p>
        </div>

        <!-- CTA Button -->
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
          <tr>
            <td style="background:#667eea; border-radius:6px;">
              <a href="#" style="display:inline-block; padding:12px 32px; color:#ffffff; text-decoration:none; font-size:14px; font-weight:600;">
                Start Learning
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding:24px; text-align:center; border-top:1px solid #eee;">
        <p style="font-size:12px; color:#999; margin:0;">
          You're receiving this because you signed up for {{productName}}.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
