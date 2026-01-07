import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { generateArticleMarkers, exportArticle, updateImageMasterWorkspace, getImageMasterWorkspaceDetail } from '@/services';
import { Wand2, Download, Sparkles, FileText, Plus, Trash2, Edit2, Upload, Eye } from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightMarkers, extractMarkers, type ArticleMarker } from '@/lib/articleMarkerExtractor';
import { useDebounce } from '@/hooks/useDebounce';
import { systemDialog } from '@/lib/systemDialog';

type WorkflowPhase = 'upload' | 'editing' | 'markers-generated' | 'images-generating' | 'images-generated';

const PRD_MD_STYLE = `
  .prd-md { font-size: 13px; line-height: 1.65; color: var(--text-secondary); white-space: normal; word-break: break-word; }
  .prd-md h1,.prd-md h2,.prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 14px 0 8px; }
  .prd-md h1 { font-size: 18px; }
  .prd-md h2 { font-size: 16px; }
  .prd-md h3 { font-size: 14px; }
  .prd-md p { margin: 8px 0; }
  .prd-md ul,.prd-md ol { margin: 8px 0; padding-left: 18px; }
  .prd-md li { margin: 4px 0; }
  .prd-md hr { border: 0; border-top: 1px solid rgba(255,255,255,0.10); margin: 12px 0; }
  .prd-md blockquote { margin: 10px 0; padding: 6px 10px; border-left: 3px solid rgba(231,206,151,0.35); background: rgba(231,206,151,0.06); color: rgba(231,206,151,0.92); border-radius: 10px; }
  .prd-md a { color: rgba(147, 197, 253, 0.95); text-decoration: underline; }
  .prd-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 6px; border-radius: 8px; }
  .prd-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px; overflow: auto; }
  .prd-md pre code { background: transparent; border: 0; padding: 0; }
  .prd-md table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .prd-md th,.prd-md td { border: 1px solid rgba(255,255,255,0.10); padding: 6px 8px; vertical-align: top; }
  .prd-md th { color: var(--text-primary); background: rgba(255,255,255,0.03); }
`;

// 用户自定义提示词模板类型
type PromptTemplate = {
  id: string;
  title: string;
  content: string;
  isSystem?: boolean;
};

export default function ArticleIllustrationEditorPage({ workspaceId }: { workspaceId: string }) {
  const [articleContent, setArticleContent] = useState('');
  const [articleWithMarkers, setArticleWithMarkers] = useState('');
  const [phase, setPhase] = useState<WorkflowPhase>('upload');
  const [generating, setGenerating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  
  // 文件上传相关状态
  const [uploadedFileName, setUploadedFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 编辑模式下的预览状态
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  
  // 提取的标记列表
  const [markers, setMarkers] = useState<ArticleMarker[]>([]);
  
  // 提示词模板管理（只有用户模板）
  const [userPrompts, setUserPrompts] = useState<PromptTemplate[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptTemplate | null>(null);

  // 所有提示词（只有用户模板）
  const allPrompts = userPrompts;

  // 自动保存：3秒防抖
  const debouncedArticleContent = useDebounce(articleContent, 3000);

  // 加载工作空间数据
  useEffect(() => {
    void loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  async function loadWorkspace() {
    try {
      const res = await getImageMasterWorkspaceDetail({ id: workspaceId });
      if (res.success && res.data?.workspace) {
        const ws = res.data.workspace;
        const content = ws.articleContent || '';
        setArticleContent(content);
        setArticleWithMarkers(ws.articleContentWithMarkers || '');
        
        // 如果有生成的内容，提取标记
        if (ws.articleContentWithMarkers) {
          const extracted = extractMarkers(ws.articleContentWithMarkers);
          setMarkers(extracted);
          if (extracted.length > 0) {
            setPhase('markers-generated');
          }
        } else if (content) {
          // 如果有内容但没有生成标记，直接进入编辑模式并显示预览
          setUploadedFileName('已上传的文章.md');
          setPhase('editing');
          setIsPreviewMode(true);
        }
        
        // 加载用户自定义提示词（全局共享）
        const saved = localStorage.getItem('literary-prompts-global');
        if (saved) {
          try {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
              setUserPrompts(parsed);
              // 如果有提示词但没有选中，自动选中第一个
              if (parsed.length > 0 && !selectedPrompt) {
                setSelectedPrompt(parsed[0]);
              }
            }
          } catch (e) {
            console.error('Failed to parse saved prompts:', e);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load workspace:', error);
    }
  }

  // 保存用户提示词到 localStorage（全局共享，不按 workspaceId 隔离）
  const saveUserPrompts = useCallback((prompts: PromptTemplate[]) => {
    localStorage.setItem('literary-prompts-global', JSON.stringify(prompts));
    setUserPrompts(prompts);
  }, []);

  useEffect(() => {
    if (debouncedArticleContent && workspaceId && phase === 'editing') {
      void saveArticleContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedArticleContent]);

  async function saveArticleContent() {
    try {
      await updateImageMasterWorkspace({
        id: workspaceId,
        articleContent: debouncedArticleContent,
        idempotencyKey: `save-article-${workspaceId}-${Date.now()}`,
      });
    } catch (error) {
      console.error('自动保存失败:', error);
    }
  }

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setArticleContent(e.target.value);
  }, []);

  // 文件上传处理
  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name;
    
    try {
      const text = await file.text();
      setArticleContent(text);
      setUploadedFileName(fileName);
      
      // 保存到后端
      await updateImageMasterWorkspace({
        id: workspaceId,
        articleContent: text,
        idempotencyKey: `upload-article-${workspaceId}-${Date.now()}`,
      });
      
      // 上传后直接进入编辑模式并启用预览
      setPhase('editing');
      setIsPreviewMode(true);
    } catch {
      await systemDialog.alert('文件读取失败');
    }
    
    // 重置 input，允许重新上传同一文件
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [workspaceId]);

  // 点击上传按钮
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 进入编辑模式
  const handleEnterEditMode = useCallback(() => {
    setPhase('editing');
    setIsPreviewMode(false);
  }, []);

  const handleGenerateMarkers = async () => {
    if (!articleContent.trim()) {
      await systemDialog.alert('请先输入文章内容');
      return;
    }

    if (!selectedPrompt) {
      await systemDialog.alert('请先选择一个提示词模板');
      return;
    }

    // 使用选中的提示词作为系统提示词
    const systemPrompt = selectedPrompt.content;

    setGenerating(true);
    setArticleWithMarkers(articleContent); // 初始显示原文
    setMarkers([]);
    
    try {
      // 使用 SSE 流式接口
      const stream = generateArticleMarkers({
        id: workspaceId,
        articleContent,
        userInstruction: systemPrompt, // 将选中的提示词作为系统提示词
        idempotencyKey: `gen-markers-${Date.now()}`,
      });

      let fullText = '';
      
      for await (const chunk of stream) {
        if (chunk.type === 'chunk' && chunk.text) {
          fullText += chunk.text;
          // 流式输出到 textarea（更新 articleContent）
          setArticleContent(fullText);
        } else if (chunk.type === 'done' && chunk.fullText) {
          fullText = chunk.fullText;
          setArticleContent(fullText);
          setArticleWithMarkers(fullText);
          
          // 提取标记
          const extracted = extractMarkers(fullText);
          setMarkers(extracted);
          
          // 保存到后端（保存AI生成的完整内容）
          await updateImageMasterWorkspace({
            id: workspaceId,
            articleContent: fullText, // 保存生成后的完整内容
            idempotencyKey: `save-markers-${Date.now()}`,
          });
          
          setPhase('markers-generated');
        } else if (chunk.type === 'error') {
          throw new Error(chunk.message || '生成失败');
        }
      }
    } catch (error) {
      console.error('Generate markers error:', error);
      await systemDialog.alert({ 
        title: '生成失败', 
        message: error instanceof Error ? error.message : '未知错误' 
      });
      setMarkers([]);
    } finally {
      setGenerating(false);
    }
  };

  const handleBatchGenerate = async () => {
    setPhase('images-generating');
    try {
      // TODO: 实现批量生图逻辑
      // 1. 串行调用图片生成接口
      // 2. 更新进度
      
      // 临时：模拟延迟
      await new Promise((resolve) => setTimeout(resolve, 2000));
      setPhase('images-generated');
    } catch {
      await systemDialog.alert('生图失败');
      setPhase('markers-generated');
    }
  };

  const handleExport = async (useCdn: boolean) => {
    try {
      const response = await exportArticle({
        id: workspaceId,
        useCdn,
        exportFormat: 'markdown',
      });

      if (!response.success) {
        await systemDialog.alert({ title: '导出失败', message: response.error?.message || '未知错误' });
        return;
      }

      // TODO: 处理导出结果（下载文件或显示内容）
      setExportOpen(false);
    } catch {
      await systemDialog.alert('导出失败');
    }
  };

  // 创建新提示词模板
  const [creatingPrompt, setCreatingPrompt] = useState<{ title: string; content: string } | null>(null);

  const handleCreatePrompt = () => {
    setCreatingPrompt({
      title: '',
      content: '',
    });
  };

  const handleSaveNewPrompt = () => {
    if (!creatingPrompt) return;

    const newPrompt: PromptTemplate = {
      id: `user-${Date.now()}`,
      title: creatingPrompt.title,
      content: creatingPrompt.content,
      isSystem: false,
    };

    const updated = [...userPrompts, newPrompt];
    saveUserPrompts(updated);
    setSelectedPrompt(newPrompt);
    setCreatingPrompt(null);
  };

  const handleCancelCreate = () => {
    setCreatingPrompt(null);
  };

  // 编辑提示词模板
  const [editingPrompt, setEditingPrompt] = useState<{ id: string; title: string; content: string } | null>(null);

  const handleEditPrompt = (prompt: PromptTemplate) => {
    setEditingPrompt({
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
    });
  };

  const handleSaveEdit = () => {
    if (!editingPrompt) return;

    const updated = userPrompts.map((p) =>
      p.id === editingPrompt.id ? { ...p, title: editingPrompt.title, content: editingPrompt.content } : p
    );
    saveUserPrompts(updated);
    
    if (selectedPrompt?.id === editingPrompt.id) {
      setSelectedPrompt({ ...selectedPrompt, title: editingPrompt.title, content: editingPrompt.content });
    }
    
    setEditingPrompt(null);
  };

  const handleCancelEdit = () => {
    setEditingPrompt(null);
  };

  // 删除提示词模板
  const handleDeletePrompt = async (prompt: PromptTemplate) => {
    if (prompt.isSystem) {
      await systemDialog.alert('系统预置模板不可删除');
      return;
    }

    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除模板「${prompt.title}」吗？`,
      tone: 'danger',
    });
    if (!ok) return;

    const updated = userPrompts.filter((p) => p.id !== prompt.id);
    saveUserPrompts(updated);
    
    if (selectedPrompt?.id === prompt.id) {
      setSelectedPrompt(updated.length > 0 ? updated[0] : null);
    }
  };

  const buttonConfig = [
    {
      label: '生成配图标记',
      action: handleGenerateMarkers,
      icon: Wand2,
      disabled: !articleContent.trim() || !selectedPrompt,
      show: phase === 'editing',
    },
    {
      label: '一键生图',
      action: handleBatchGenerate,
      icon: Sparkles,
      disabled: false,
      show: phase === 'markers-generated',
    },
    {
      label: '生成中...',
      action: async () => {},
      icon: Sparkles,
      disabled: true,
      show: phase === 'images-generating',
    },
    {
      label: '一键导出',
      action: () => setExportOpen(true),
      icon: Download,
      disabled: false,
      show: phase === 'images-generated',
    },
  ];

  const activeButton = buttonConfig.find((btn) => btn.show);

  return (
    <div className="h-full min-h-0 flex gap-4">
      {/* 左侧：文章编辑器 */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <Card className="flex-1 min-h-0 flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              文章内容 {phase === 'editing' && <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>(自动保存)</span>}
            </div>
            <div className="flex items-center gap-2">
              {phase === 'editing' && (
                <Button 
                  size="sm" 
                  variant={isPreviewMode ? 'primary' : 'secondary'} 
                  onClick={() => setIsPreviewMode(!isPreviewMode)}
                >
                  <Eye size={14} />
                  {isPreviewMode ? '编辑' : '预览'}
                </Button>
              )}
              {phase === 'upload' && uploadedFileName && (
                <Button size="sm" variant="primary" onClick={handleEnterEditMode}>
                  <Edit2 size={14} />
                  编辑
                </Button>
              )}
              {phase !== 'editing' && phase !== 'upload' && (
                <Button size="sm" variant="secondary" onClick={handleEnterEditMode}>
                  <FileText size={14} />
                  继续编辑
                </Button>
              )}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <style>{PRD_MD_STYLE}</style>
            {/* 上传阶段：显示上传区域或已上传文件信息 */}
            {phase === 'upload' && !uploadedFileName && (
              <div className="h-full flex flex-col items-center justify-center p-8">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="text-center">
                  <Upload size={48} className="mx-auto mb-4" style={{ color: 'var(--text-muted)' }} />
                  <div className="text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
                    上传文章文件
                  </div>
                  <Button variant="primary" onClick={handleUploadClick}>
                    <Upload size={16} />
                    选择文件
                  </Button>
                  <div className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
                    支持 .md 和 .txt 格式
                  </div>
                </div>
              </div>
            )}
            
            {/* 上传阶段：已有文件 */}
            {phase === 'upload' && uploadedFileName && (
              <div className="h-full flex flex-col items-center justify-center p-8">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="text-center">
                  <FileText size={48} className="mx-auto mb-4" style={{ color: 'var(--accent-primary)' }} />
                  <div className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>
                    {uploadedFileName}
                  </div>
                  <div className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                    {articleContent.length} 字符
                  </div>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={handleUploadClick}>
                      <Upload size={16} />
                      重新上传
                    </Button>
                    <Button variant="primary" onClick={handleEnterEditMode}>
                      <Edit2 size={16} />
                      开始编辑
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 编辑阶段 */}
            {phase === 'editing' && !isPreviewMode && (
              <textarea
                value={articleContent}
                onChange={handleContentChange}
                placeholder="在此输入文章内容，支持 Markdown 格式..."
                className="w-full h-full p-4 resize-none font-mono text-sm"
                style={{
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  outline: 'none',
                }}
              />
            )}
            
            {/* 编辑阶段：预览模式 */}
            {phase === 'editing' && isPreviewMode && (
              <div className="p-4">
                <div className="prd-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{articleContent}</ReactMarkdown>
                </div>
              </div>
            )}

            {/* 其他阶段：显示渲染内容 */}
            {phase !== 'editing' && phase !== 'upload' && (
              <div className="p-4">
                <div className="prd-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{articleWithMarkers || articleContent}</ReactMarkdown>
                </div>
                {phase === 'markers-generated' && articleWithMarkers && (
                  <div className="mt-4 p-3 rounded" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                    <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                      配图标记预览（黄色高亮部分）
                    </div>
                    <div className="text-sm whitespace-pre-wrap">{highlightMarkers(articleWithMarkers)}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 右侧：工作台 */}
      <div className="w-96 flex flex-col gap-4">
        {/* 顶部操作按钮 */}
        <Card>
          {activeButton && (
            <Button
              variant="primary"
              className="w-full"
              onClick={() => void activeButton.action()}
              disabled={generating || activeButton.disabled}
            >
              <activeButton.icon size={16} />
              {generating ? '生成中...' : activeButton.label}
            </Button>
          )}
        </Card>

        {/* 提示词模板选择（仅在 editing 阶段显示） */}
        {phase === 'editing' && (
          <Card className="flex-1 min-h-0 flex flex-col">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                选择提示词模板
              </div>
              <Button size="sm" variant="secondary" onClick={handleCreatePrompt}>
                <Plus size={14} />
                新建
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {allPrompts.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-sm mb-2" style={{ color: 'var(--text-muted)' }}>
                    还没有提示词模板
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    点击右上角「新建」创建第一个模板
                  </div>
                </div>
              ) : (
                allPrompts.map((prompt) => (
                  <div
                    key={prompt.id}
                    className="p-3 rounded transition-all"
                    style={{
                      background: selectedPrompt?.id === prompt.id 
                        ? 'linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 22%, transparent) 0%, color-mix(in srgb, var(--accent-primary) 10%, transparent) 100%)'
                        : 'var(--bg-elevated)',
                      border: selectedPrompt?.id === prompt.id 
                        ? '3px solid var(--accent-primary)' 
                        : '1px solid var(--border-subtle)',
                      boxShadow: selectedPrompt?.id === prompt.id 
                        ? '0 10px 24px rgba(0, 0, 0, 0.28), 0 0 0 6px color-mix(in srgb, var(--accent-primary) 22%, transparent), 0 0 22px color-mix(in srgb, var(--accent-primary) 28%, transparent)'
                        : '0 0 0 rgba(0,0,0,0)',
                      transform: selectedPrompt?.id === prompt.id ? 'translateY(-3px)' : 'translateY(0px)',
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <button
                        onClick={() => setSelectedPrompt(prompt)}
                        className="flex-1 text-left"
                      >
                        <div className="text-sm font-semibold mb-1 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                          {prompt.title}
                          {selectedPrompt?.id === prompt.id && (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ 
                              background: 'var(--accent-primary)', 
                              color: 'white' 
                            }}>
                              已选中
                            </span>
                          )}
                        </div>
                        <div className="text-xs line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                          {prompt.content.slice(0, 80)}...
                        </div>
                      </button>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleEditPrompt(prompt)}
                          className="p-1 rounded hover:bg-white/10 transition-colors"
                          style={{ color: 'var(--text-muted)' }}
                          title="编辑"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => void handleDeletePrompt(prompt)}
                          className="p-1 rounded hover:bg-white/10 transition-colors"
                          style={{ color: 'var(--text-muted)' }}
                          title="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        )}

        {/* 提取的配图标记列表（markers-generated 阶段显示） */}
        {phase === 'markers-generated' && (
          <Card className="flex-1 min-h-0 flex flex-col">
            <div className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              配图标记列表 ({markers.length})
            </div>
            <div className="flex-1 min-h-0 overflow-auto space-y-2">
              {markers.map((marker) => (
                <div
                  key={marker.index}
                  className="p-3 rounded"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
                    配图 {marker.index + 1}
                  </div>
                  <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                    {marker.text}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              点击"一键生图"开始生成所有配图
            </div>
          </Card>
        )}

        {/* 生成的图片列表（images-generating 和 images-generated 阶段显示） */}
        {(phase === 'images-generating' || phase === 'images-generated') && (
          <Card className="flex-1 min-h-0 overflow-auto">
            <div className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              生成的配图
            </div>
            <div className="space-y-3">
              {phase === 'images-generating' ? (
                <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  <Sparkles size={32} className="mx-auto mb-2 animate-pulse" />
                  正在生成配图...
                </div>
              ) : (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  暂无图片（功能开发中）
                </div>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* 导出对话框 */}
      <Dialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="导出文章"
        description="选择图片存储方式"
        content={
          <div className="p-4 space-y-3">
            <Button variant="primary" className="w-full" onClick={() => void handleExport(true)}>
              导出（使用 CDN 图片链接）
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => void handleExport(false)}>
              导出（下载图片到本地）
            </Button>
          </div>
        }
      />

      {/* 新建提示词对话框 */}
      <Dialog
        open={!!creatingPrompt}
        onOpenChange={(open) => !open && handleCancelCreate()}
        title="新建提示词模板"
        description="输入模板名称和内容"
        content={
          creatingPrompt ? (
            <div className="p-4 space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                  模板名称
                </label>
                <input
                  type="text"
                  value={creatingPrompt.title}
                  onChange={(e) => setCreatingPrompt({ ...creatingPrompt, title: e.target.value })}
                  placeholder="例如：产品介绍"
                  className="w-full p-2 text-sm rounded"
                  style={{
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-subtle)',
                    outline: 'none',
                  }}
                  autoFocus
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                  模板内容
                </label>
                <textarea
                  value={creatingPrompt.content}
                  onChange={(e) => setCreatingPrompt({ ...creatingPrompt, content: e.target.value })}
                  placeholder="请输入提示词模板内容（所有文学创作 Agent 全局共享）..."
                  rows={12}
                  className="w-full p-2 text-sm resize-none font-mono rounded"
                  style={{
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-subtle)',
                    outline: 'none',
                  }}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" onClick={handleCancelCreate}>
                  取消
                </Button>
                <Button 
                  variant="primary" 
                  onClick={handleSaveNewPrompt}
                  disabled={!creatingPrompt.title.trim() || !creatingPrompt.content.trim()}
                >
                  确认
                </Button>
              </div>
            </div>
          ) : null
        }
      />

      {/* 编辑提示词对话框 */}
      <Dialog
        open={!!editingPrompt}
        onOpenChange={(open) => !open && handleCancelEdit()}
        title="编辑提示词模板"
        description="同时编辑标题和内容"
        content={
          editingPrompt ? (
            <div className="p-4 space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                  模板标题
                </label>
                <input
                  type="text"
                  value={editingPrompt.title}
                  onChange={(e) => setEditingPrompt({ ...editingPrompt, title: e.target.value })}
                  placeholder="输入模板标题..."
                  className="w-full p-2 text-sm rounded"
                  style={{
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-subtle)',
                    outline: 'none',
                  }}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                  模板内容
                </label>
                <textarea
                  value={editingPrompt.content}
                  onChange={(e) => setEditingPrompt({ ...editingPrompt, content: e.target.value })}
                  placeholder="输入模板内容..."
                  rows={12}
                  className="w-full p-2 text-sm resize-none font-mono rounded"
                  style={{
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-subtle)',
                    outline: 'none',
                  }}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" onClick={handleCancelEdit}>
                  取消
                </Button>
                <Button 
                  variant="primary" 
                  onClick={handleSaveEdit}
                  disabled={!editingPrompt.title.trim() || !editingPrompt.content.trim()}
                >
                  保存
                </Button>
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
}
