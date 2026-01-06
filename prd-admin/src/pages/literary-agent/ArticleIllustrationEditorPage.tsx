import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { generateArticleMarkers, exportArticle, updateImageMasterWorkspace, getImageMasterWorkspaceDetail } from '@/services';
import { Wand2, Download, Sparkles, FileText, Plus, Trash2, Edit2, RefreshCw } from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { highlightMarkers, extractMarkers, type ArticleMarker } from '@/lib/articleMarkerExtractor';
import { useDebounce } from '@/hooks/useDebounce';
import { systemDialog } from '@/lib/systemDialog';

type WorkflowPhase = 'editing' | 'markers-generated' | 'images-generating' | 'images-generated';

// 用户自定义提示词模板类型
type PromptTemplate = {
  id: string;
  title: string;
  content: string;
  isSystem?: boolean;
};

// 默认提示词（从 article-image-format.mdc 读取）
const DEFAULT_PROMPT_CONTENT = `---
globs: *.md
description: 文章写作中插入图片的标准格式规范
---

# 文章图片插入格式规范

## 图片插入标准格式

在文章的关键章节之间需要插入相应的图片时，使用以下标准格式：

\`\`\`
[插图] : 提示词xxxxxx
\`\`\`

## 图片要求规范

### 基本参数
- **尺寸规格**：1024*1024像素
- **风格要求**：扁平化商业风格插画
- **色彩搭配**：符合商业文档的专业性要求

### 提示词编写指导

提示词应该包含以下要素：
1. **场景描述**：清晰描述图片要表达的核心概念
2. **风格指定**：扁平化商业风格插画
3. **尺寸要求**：1024x1024
4. **色彩倾向**：专业、简洁的商业配色
5. **具体文字信息**：必须明确指出图片中需要显示的具体文字内容
6. **企业标识信息**：如涉及企业标志或团队信息，需明确标注

### 示例格式

#### 基础场景示例
\`\`\`markdown
[插图] : 1024x1024扁平化商业风格插画，展示团队协作场景，多个商务人士围绕会议桌讨论，背景是现代办公环境，使用蓝色和灰色为主色调，体现专业和效率
\`\`\`

#### 包含具体文字的示例
\`\`\`markdown
[插图] : 1024x1024扁平化商业风格插画，展示Cursor的四个输入接口，四个标签页分别标注"Chat"、"Doc"、"Rule"、"Memory"，每个标签用不同颜色区分，整体界面采用现代科技风格，使用蓝色渐变背景
\`\`\`

## 插入位置建议

### 适合插图的关键位置
- 章节开头：概念引入时
- 核心思想阐述：复杂概念需要可视化时  
- 方法论介绍：流程步骤说明时
- 案例分析：具体场景描述时
- 总结段落：要点梳理时

### 不建议插图的位置
- 纯文字描述段落中间
- 代码示例附近
- 表格数据展示区域`;

export default function ArticleIllustrationEditorPage({ workspaceId }: { workspaceId: string }) {
  const [articleContent, setArticleContent] = useState('');
  const [articleWithMarkers, setArticleWithMarkers] = useState('');
  const [phase, setPhase] = useState<WorkflowPhase>('editing');
  const [generating, setGenerating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  
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
  }, [workspaceId]);

  async function loadWorkspace() {
    try {
      const res = await getImageMasterWorkspaceDetail({ id: workspaceId });
      if (res.success && res.data?.workspace) {
        const ws = res.data.workspace;
        setArticleContent(ws.articleContent || '');
        setArticleWithMarkers(ws.articleContentWithMarkers || '');
        
        // 如果有生成的内容，提取标记
        if (ws.articleContentWithMarkers) {
          const extracted = extractMarkers(ws.articleContentWithMarkers);
          setMarkers(extracted);
          if (extracted.length > 0) {
            setPhase('markers-generated');
          }
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
    } catch (error) {
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
    } catch (error) {
      await systemDialog.alert('导出失败');
    }
  };

  // 创建新提示词模板
  const [creatingPrompt, setCreatingPrompt] = useState<{ title: string; content: string } | null>(null);

  const handleCreatePrompt = () => {
    setCreatingPrompt({
      title: '',
      content: DEFAULT_PROMPT_CONTENT, // 预填充默认内容
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
            {phase !== 'editing' && (
              <Button size="sm" variant="secondary" onClick={() => setPhase('editing')}>
                <FileText size={14} />
                继续编辑
              </Button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {phase === 'editing' ? (
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
            ) : (
              <div className="p-4">
                <div className="prose prose-sm max-w-none dark:prose-invert" style={{ color: 'var(--text-primary)' }}>
                  <ReactMarkdown>{articleWithMarkers || articleContent}</ReactMarkdown>
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
                        ? 'linear-gradient(135deg, var(--accent-primary-alpha) 0%, color-mix(in srgb, var(--accent-primary) 15%, transparent) 100%)'
                        : 'var(--bg-elevated)',
                      border: selectedPrompt?.id === prompt.id 
                        ? '2px solid var(--accent-primary)' 
                        : '1px solid var(--border-subtle)',
                      boxShadow: selectedPrompt?.id === prompt.id 
                        ? '0 4px 12px rgba(0, 0, 0, 0.15), 0 0 0 3px color-mix(in srgb, var(--accent-primary) 20%, transparent)'
                        : 'none',
                      transform: selectedPrompt?.id === prompt.id ? 'translateY(-2px)' : 'none',
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
