import { useState, useCallback, useRef, useEffect } from 'react';
import { createEmergenceTree, getDocumentContent } from '@/services';
import { TreePine, X, Upload, FileText, Keyboard } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';

interface Props {
  onClose: () => void;
  onCreated: (treeId: string) => void;
  /** 从文档空间跳转来时预填的标题 */
  initialSeedTitle?: string;
  initialSeedSourceType?: string;
  /** 文档条目 ID — 有值时自动拉取文档全文作为种子 */
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

export function EmergenceCreateDialog({ onClose, onCreated, initialSeedTitle, initialSeedSourceType, initialSeedSourceId }: Props) {
  const [title, setTitle] = useState(initialSeedTitle ?? '');
  const [seedContent, setSeedContent] = useState('');
  const [seedSourceType, setSeedSourceType] = useState<string>(initialSeedSourceType ?? 'text');
  const [injectSystem, setInjectSystem] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fetchingDoc, setFetchingDoc] = useState(false);

  // 输入模式 — 从文档跳转来时自动切到手动输入模式
  const [activeMode, setActiveMode] = useState<InputMode>(initialSeedSourceId ? 'text' : 'upload');

  // 从文档空间跳转来时，自动拉取文档全文
  useEffect(() => {
    if (!initialSeedSourceId) return;
    setFetchingDoc(true);
    (async () => {
      const res = await getDocumentContent(initialSeedSourceId);
      if (res.success && res.data.content) {
        setSeedContent(res.data.content);
        if (!title && res.data.title) setTitle(res.data.title);
      } else {
        setError('无法加载文档内容，请手动输入');
      }
      setFetchingDoc(false);
    })();
  }, [initialSeedSourceId]);

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
    <div className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="surface-popover w-[520px] max-w-[92vw] rounded-[16px] p-6">
        {/* 标题 */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="surface-action-accent flex h-8 w-8 items-center justify-center rounded-[10px]">
              <TreePine size={15} />
            </div>
            <span className="text-[15px] font-semibold text-token-primary">
              新建涌现树
            </span>
          </div>
          <button onClick={onClose}
            className="hover-bg-soft flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted transition-colors duration-200 hover:text-token-primary">
            <X size={15} />
          </button>
        </div>

        {/* 标题输入 */}
        <div className="mb-4">
          <label className="mb-1.5 block text-[12px] text-token-muted">
            标题（可选，自动从种子内容提取）
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="如：文档空间功能涌现"
            className="prd-field h-9 w-full rounded-[10px] px-3 text-[13px] outline-none transition-colors duration-200"
          />
        </div>

        {/* 种子内容 — 三通道切换 */}
        <div className="mb-4">
          <label className="mb-2 block text-[12px] text-token-muted">
            种子内容 — 涌现树的第一座基石
          </label>

          {/* 模式切换 Tab */}
          <div className="surface-inset mb-3 flex gap-1 rounded-[10px] p-1">
            {modes.map(m => {
              const isActive = activeMode === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setActiveMode(m.key)}
                  className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[8px] py-1.5 text-[11px] font-semibold transition-all duration-200 ${
                    isActive ? 'surface-action-accent' : 'text-token-muted hover-bg-soft'
                  }`}
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
                    <div className="surface-action-success flex h-10 w-10 items-center justify-center rounded-[10px]">
                      <FileText size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-[13px] font-semibold text-token-primary">
                        {uploadedFileName}
                      </p>
                      <p className="text-[11px] text-token-muted">
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
                    <MapSpinner size={20} />
                  ) : (
                    <>
                      <Upload size={20} style={{ color: dragging ? 'rgba(147,51,234,0.8)' : 'var(--text-muted)' }} />
                      <span className="text-[12px]" style={{ color: dragging ? 'rgba(147,51,234,0.8)' : 'var(--text-muted)' }}>
                        {dragging ? '释放文件' : '拖拽文件到此处，或点击选择'}
                      </span>
                      <span className="text-[10px] text-token-muted opacity-60">
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
                  className={`cursor-pointer rounded-[10px] p-3 text-left transition-all duration-200 ${
                    seedContent === t.content ? 'surface-action-accent' : 'surface-row'
                  }`}
                >
                  <p className="mb-1 text-[12px] font-semibold text-token-primary">
                    {t.title}
                  </p>
                  <p className="text-[10px] leading-[1.5] text-token-muted">
                    {t.content.slice(0, 60)}…
                  </p>
                </button>
              ))}
            </div>
          )}

          {/* 手动输入模式 */}
          {activeMode === 'text' && (
            fetchingDoc ? (
              <div className="surface-inset rounded-[10px]">
                <MapSectionLoader text="正在加载文档内容…" />
              </div>
            ) : (
              <textarea
                value={seedContent}
                onChange={e => { setSeedContent(e.target.value); setSeedSourceType('text'); }}
                placeholder={'输入一段文档、产品方案、功能标题、或一段对话…'}
                rows={seedContent.length > 500 ? 8 : 5}
                className="prd-field w-full resize-y rounded-[10px] px-3 py-2.5 text-[13px] leading-[1.6] outline-none transition-colors duration-200"
              />
            )
          )}

          {/* 种子预览（上传或选择后显示） */}
          {seedContent && activeMode !== 'text' && (
            <div className="surface-inset mt-2 max-h-[80px] overflow-y-auto rounded-[8px] p-2.5">
              <p className="text-[11px] leading-[1.5] text-token-muted">
                {seedContent.slice(0, 300)}{seedContent.length > 300 ? '…' : ''}
              </p>
            </div>
          )}
        </div>

        {/* 结合本系统能力开关 */}
        <div className="surface-inset mb-4 flex items-center justify-between rounded-[10px] p-3">
          <div>
            <p className="text-[12px] font-semibold text-token-primary">
              结合本系统能力
            </p>
            <p className="mt-0.5 text-[10px] text-token-muted">
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
          <p className="surface-state-danger mb-3 rounded-[8px] px-3 py-2 text-[12px]">{error}</p>
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
