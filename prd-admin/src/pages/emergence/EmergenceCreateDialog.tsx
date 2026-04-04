import { useState, useCallback, useRef } from 'react';
import { createEmergenceTree, listEmergenceTrees } from '@/services';
import { TreePine, X, Upload, FileText, Loader2, Keyboard } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { glassPanel } from '@/lib/glassStyles';
import { GlassCard } from '@/components/design/GlassCard';

interface Props {
  onClose: () => void;
  onCreated: (treeId: string) => void;
  /** 从文档空间跳转来时预填的种子内容 */
  initialSeedContent?: string;
  initialSeedSourceType?: string;
  initialSeedSourceId?: string;
}

type InputMode = 'upload' | 'select' | 'text';

const ACCEPT_TYPES = '.md,.txt,.pdf,.doc,.docx,.json,.yaml,.yml';

/** 读取文件文本内容 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function EmergenceCreateDialog({ onClose, onCreated, initialSeedContent, initialSeedSourceType, initialSeedSourceId }: Props) {
  const [title, setTitle] = useState(initialSeedContent ?? '');
  const [seedContent, setSeedContent] = useState(initialSeedContent ?? '');
  const [seedSourceType, setSeedSourceType] = useState<string>(initialSeedSourceType ?? 'text');
  const [injectSystem, setInjectSystem] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 输入模式
  const [activeMode, setActiveMode] = useState<InputMode>('upload');

  // 文件上传
  const [dragging, setDragging] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 选择已有文档（简化：直接从涌现树历史中选）
  // 后续可扩展为从 DocumentStore 选择

  // ── 文件处理 ──
  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const text = await readFileAsText(file);
      if (!text.trim()) {
        setError('文件内容为空');
        setUploading(false);
        return;
      }
      setSeedContent(text.trim());
      setUploadedFileName(file.name);
      setSeedSourceType('document');
      // 自动提取标题
      if (!title.trim()) {
        const name = file.name.replace(/\.[^.]+$/, '');
        setTitle(name);
      }
    } catch {
      setError('文件读取失败，请检查文件格式');
    }
    setUploading(false);
  }, [title]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragging(false);
    dragCounter.current = 0;
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // ── 创建 ──
  const handleCreate = async () => {
    if (!seedContent.trim()) {
      setError('种子内容不能为空，请上传文档或手动输入');
      return;
    }
    setLoading(true);
    setError('');
    const res = await createEmergenceTree({
      title: title.trim() || undefined,
      seedContent: seedContent.trim(),
      seedSourceType,
      seedSourceId: initialSeedSourceId ?? undefined,
      injectSystemCapabilities: injectSystem,
    });
    if (res.success) {
      onCreated(res.data.tree.id);
    } else {
      setError(res.error?.message ?? '创建失败');
    }
    setLoading(false);
  };

  // ── 模式切换 Tab ──
  const modes: { key: InputMode; label: string; icon: typeof Upload }[] = [
    { key: 'upload', label: '上传文档', icon: Upload },
    { key: 'select', label: '选择模板', icon: FileText },
    { key: 'text', label: '手动输入', icon: Keyboard },
  ];

  // 预设模板
  const templates = [
    { title: '产品功能探索', content: '当前产品已有基础 CRUD 功能，需要探索下一步做什么能力来提升用户价值和留存。' },
    { title: '技术架构演进', content: '当前系统架构已支撑基本业务，需要探索在性能、可扩展性、可观测性方面的下一步演进方向。' },
    { title: '竞品对标分析', content: '需要对标市面主流竞品，分析当前产品的功能差距和差异化机会。' },
    { title: '用户体验优化', content: '用户反馈集中在操作复杂、等待时间长、找不到功能入口等问题，需要涌现优化方案。' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="w-[520px] max-w-[92vw] rounded-[16px] p-6" style={glassPanel}>
        {/* 标题 */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.12)' }}>
              <TreePine size={15} style={{ color: 'rgba(147,51,234,0.85)' }} />
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              新建涌现树
            </span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 标题输入 */}
        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
            标题（可选，自动从种子内容提取）
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="如：文档空间功能涌现"
            className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* 种子内容 — 三通道切换 */}
        <div className="mb-4">
          <label className="block text-[12px] mb-2" style={{ color: 'var(--text-muted)' }}>
            种子内容 — 涌现树的第一座基石
          </label>

          {/* 模式切换 Tab */}
          <div className="flex gap-1 mb-3 p-1 rounded-[10px]"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {modes.map(m => {
              const isActive = activeMode === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setActiveMode(m.key)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-[8px] text-[11px] font-semibold cursor-pointer transition-all duration-200"
                  style={{
                    background: isActive ? 'rgba(147,51,234,0.1)' : 'transparent',
                    border: isActive ? '1px solid rgba(147,51,234,0.2)' : '1px solid transparent',
                    color: isActive ? 'rgba(147,51,234,0.9)' : 'var(--text-muted)',
                  }}
                >
                  <m.icon size={12} /> {m.label}
                </button>
              );
            })}
          </div>

          {/* 上传文档模式 */}
          {activeMode === 'upload' && (
            <div
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className="relative"
            >
              <input ref={fileInputRef} type="file" className="hidden" accept={ACCEPT_TYPES}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />

              {uploadedFileName ? (
                /* 已上传文件 */
                <div className="surface-inset rounded-[10px] p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-[10px] flex items-center justify-center"
                      style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.12)' }}>
                      <FileText size={18} style={{ color: 'rgba(34,197,94,0.85)' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {uploadedFileName}
                      </p>
                      <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        已提取 {seedContent.length} 个字符
                      </p>
                    </div>
                    <Button variant="ghost" size="xs" onClick={() => {
                      setUploadedFileName(''); setSeedContent(''); setSeedSourceType('text');
                    }}>
                      重选
                    </Button>
                  </div>
                </div>
              ) : (
                /* 拖拽/点击上传区域 */
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-full py-8 rounded-[10px] flex flex-col items-center justify-center gap-2 cursor-pointer transition-all duration-200"
                  style={{
                    background: dragging ? 'rgba(147,51,234,0.06)' : 'rgba(255,255,255,0.02)',
                    border: `1.5px dashed ${dragging ? 'rgba(147,51,234,0.4)' : 'rgba(255,255,255,0.12)'}`,
                  }}
                >
                  {uploading ? (
                    <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                  ) : (
                    <>
                      <Upload size={20} style={{ color: dragging ? 'rgba(147,51,234,0.8)' : 'var(--text-muted)' }} />
                      <span className="text-[12px]" style={{ color: dragging ? 'rgba(147,51,234,0.8)' : 'var(--text-muted)' }}>
                        {dragging ? '释放文件' : '拖拽文件到此处，或点击选择'}
                      </span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                        支持 Markdown / TXT / PDF / Word / JSON / YAML
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* 选择模板模式 */}
          {activeMode === 'select' && (
            <div className="grid grid-cols-2 gap-2">
              {templates.map(t => (
                <button
                  key={t.title}
                  onClick={() => {
                    setSeedContent(t.content);
                    setTitle(t.title);
                    setSeedSourceType('text');
                  }}
                  className="surface-row p-3 rounded-[10px] text-left cursor-pointer transition-all duration-200"
                  style={{
                    border: seedContent === t.content
                      ? '1px solid rgba(147,51,234,0.3)'
                      : '1px solid rgba(255,255,255,0.06)',
                    background: seedContent === t.content
                      ? 'rgba(147,51,234,0.06)'
                      : 'rgba(255,255,255,0.02)',
                  }}
                >
                  <p className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                    {t.title}
                  </p>
                  <p className="text-[10px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>
                    {t.content.slice(0, 60)}…
                  </p>
                </button>
              ))}
            </div>
          )}

          {/* 手动输入模式 */}
          {activeMode === 'text' && (
            <textarea
              value={seedContent}
              onChange={e => { setSeedContent(e.target.value); setSeedSourceType('text'); }}
              placeholder={'输入一段文档、产品方案、功能标题、或一段对话…'}
              rows={5}
              className="w-full px-3 py-2.5 rounded-[10px] text-[13px] outline-none resize-y leading-[1.6] transition-colors duration-200"
              style={{
                background: 'var(--input-bg, rgba(255,255,255,0.05))',
                border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
                color: 'var(--text-primary)',
              }}
            />
          )}

          {/* 种子预览（上传或选择后显示） */}
          {seedContent && activeMode !== 'text' && (
            <div className="mt-2 p-2.5 rounded-[8px] max-h-[80px] overflow-y-auto"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-[11px] leading-[1.5]" style={{ color: 'var(--text-muted)' }}>
                {seedContent.slice(0, 300)}{seedContent.length > 300 ? '…' : ''}
              </p>
            </div>
          )}
        </div>

        {/* 结合本系统能力开关 */}
        <div className="mb-4 flex items-center justify-between p-3 rounded-[10px]"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div>
            <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              结合本系统能力
            </p>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              开启后 AI 会参考本系统已有的 API、模型、组件进行涌现
            </p>
          </div>
          <button
            onClick={() => setInjectSystem(!injectSystem)}
            className="w-10 h-[22px] rounded-full cursor-pointer transition-all duration-200 flex-shrink-0"
            style={{
              background: injectSystem ? 'rgba(34,197,94,0.5)' : 'rgba(255,255,255,0.1)',
              border: `1px solid ${injectSystem ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.1)'}`,
              position: 'relative',
            }}
          >
            <div
              className="w-4 h-4 rounded-full absolute top-[2px] transition-all duration-200"
              style={{
                left: injectSystem ? 21 : 2,
                background: injectSystem ? '#fff' : 'rgba(255,255,255,0.4)',
              }}
            />
          </button>
        </div>

        {/* 错误提示 */}
        {error && (
          <p className="text-[12px] mb-3" style={{ color: 'rgba(239,68,68,0.9)' }}>{error}</p>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleCreate} disabled={loading || uploading}>
            {loading ? '创建中…' : '开始涌现'}
          </Button>
        </div>
      </div>
    </div>
  );
}
