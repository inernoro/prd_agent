import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ImagePreviewDialog } from '@/components/ui/ImagePreviewDialog';
import { WatermarkSettingsPanel } from '@/components/watermark/WatermarkSettingsPanel';
import { WorkflowProgressBar } from '@/components/ui/WorkflowProgressBar';
import {
  createImageGenRun,
  generateArticleMarkers,
  getImageMasterWorkspaceDetail,
  getModels,
  planImageGen,
  streamImageGenRunWithRetry,
  updateImageMasterWorkspace,
  updateArticleMarker,
  uploadImageMasterWorkspaceAsset,
  listLiteraryPrompts,
  createLiteraryPrompt,
  updateLiteraryPrompt,
  deleteLiteraryPrompt,
  getWatermark,
} from '@/services';
import { Wand2, Download, Sparkles, FileText, Plus, Trash2, Edit2, Upload, Eye, Check, Copy, DownloadCloud, MapPin } from 'lucide-react';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { extractMarkers, type ArticleMarker } from '@/lib/articleMarkerExtractor';
import { useDebounce } from '@/hooks/useDebounce';
import { PrdPetalBreathingLoader } from '@/components/ui/PrdPetalBreathingLoader';
import { systemDialog } from '@/lib/systemDialog';
import type { Model } from '@/types/admin';
import type { ImageGenPlanItem } from '@/services/contracts/imageGen';

// 3 个状态：0=upload, 1=editing, 2=markersGenerated
type WorkflowPhase = 0 | 1 | 2;

type MarkerRunStatus = 'idle' | 'parsing' | 'parsed' | 'running' | 'done' | 'error';

type MarkerRunItem = {
  markerIndex: number;
  markerText: string; // 原始（从文章提取）文本
  draftText: string; // 用户可编辑（用于重新生成）
  planItem?: ImageGenPlanItem | null;
  status: MarkerRunStatus;
  runId?: string | null;
  base64?: string | null;
  url?: string | null;
  assetUrl?: string | null;
  errorMessage?: string | null;
};

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
  .prd-md .prd-md-marker {
    background: rgba(245, 158, 11, 0.22);
    border: 1px solid rgba(245, 158, 11, 0.32);
    color: rgba(255,255,255,0.92);
    padding: 0 4px;
    border-radius: 6px;
  }
`;

// 用户自定义提示词模板类型（对应后端 LiteraryPrompt）
type PromptTemplate = {
  id: string;
  title: string;
  content: string;
  isSystem?: boolean;
  scenarioType?: string | null;
  order?: number;
};

export default function ArticleIllustrationEditorPage({ workspaceId }: { workspaceId: string }) {
  const [articleContent, setArticleContent] = useState('');
  const [articleWithMarkers, setArticleWithMarkers] = useState('');
  const [articleWithImages, setArticleWithImages] = useState('');
  const [phase, setPhase] = useState<WorkflowPhase>(0); // 0=upload
  const [generating, setGenerating] = useState(false);
  const [markerStreaming, setMarkerStreaming] = useState(false);
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewIndex, setImagePreviewIndex] = useState(0);
  const [watermarkEnabled, setWatermarkEnabled] = useState(false);
  
  // 文件上传相关状态
  const [uploadedFileName, setUploadedFileName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  
  // 提取的标记列表
  const [markers, setMarkers] = useState<ArticleMarker[]>([]);

  // 生图模型（自动选择 isImageGen=true 的最优先）
  const [imageGenModel, setImageGenModel] = useState<Model | null>(null);
  const [imageGenModelError, setImageGenModelError] = useState<string | null>(null);

  // 右侧每条配图的运行状态（逐条 parse + gen）
  const [markerRunItems, setMarkerRunItems] = useState<MarkerRunItem[]>([]);
  const [markerRunItemsRestored, setMarkerRunItemsRestored] = useState(false); // 标记是否已从后端恢复

  const genAbortRef = useRef<AbortController | null>(null);
  const markerListRef = useRef<HTMLDivElement>(null); // 配图列表容器的 ref
  const articlePreviewRef = useRef<HTMLDivElement>(null); // 文章预览区域的 ref
  const isStreamingRef = useRef<boolean>(false); // 标记是否正在流式输出
  
  // 当配图列表增加时，只在流式输出过程中自动滚动到底部
  useEffect(() => {
    if (isStreamingRef.current && markerListRef.current && markerRunItems.length > 0) {
      markerListRef.current.scrollTop = markerListRef.current.scrollHeight;
    }
  }, [markerRunItems.length]);
  
  // 当文章内容更新时，只在流式输出过程中自动滚动到底部
  useEffect(() => {
    if (isStreamingRef.current && articlePreviewRef.current && articleWithMarkers) {
      articlePreviewRef.current.scrollTop = articlePreviewRef.current.scrollHeight;
    }
  }, [articleWithMarkers]);
  
  // 提示词模板管理（只有用户模板）
  const [userPrompts, setUserPrompts] = useState<PromptTemplate[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptTemplate | null>(null);

  // 所有提示词（只有用户模板）
  const allPrompts = userPrompts;

  // 自动保存：3秒防抖（仅在允许编辑时启用；当前页面已移除手动编辑入口，保留逻辑以兼容未来扩展）
  const debouncedArticleContent = useDebounce(articleContent, 3000);

  // 加载工作空间数据
  useEffect(() => {
    void loadWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // 自动选择生图模型（参照实验室：自动用系统启用的 isImageGen 模型）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setImageGenModelError(null);
      const res = await getModels();
      if (cancelled) return;
      if (!res.success) {
        setImageGenModel(null);
        setImageGenModelError(res.error?.message || '加载生图模型失败');
        return;
      }
      const list = (res.data ?? []).filter((m) => Boolean(m.enabled) && Boolean(m.isImageGen));
      if (list.length === 0) {
        setImageGenModel(null);
        setImageGenModelError('未找到启用的生图模型（请在「模型管理」里设置 isImageGen）');
        return;
      }
      list.sort((a, b) => {
        const ap = typeof a.priority === 'number' ? a.priority : 1e9;
        const bp = typeof b.priority === 'number' ? b.priority : 1e9;
        if (ap !== bp) return ap - bp;
        return String(a.modelName || a.name || '').localeCompare(String(b.modelName || b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
      });
      setImageGenModel(list[0] ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getWatermark();
      if (cancelled) return;
      if (res?.success) {
        setWatermarkEnabled(Boolean(res.data?.enabled ?? res.data?.spec?.enabled));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadWorkspace() {
    try {
      const res = await getImageMasterWorkspaceDetail({ id: workspaceId });
      if (res.success && res.data?.workspace) {
        const ws = res.data.workspace;
        const content = ws.articleContent || '';
        setArticleContent(content);
        setArticleWithMarkers(ws.articleContentWithMarkers || '');
        setArticleWithImages('');
        
        // 优先以服务端 workflow.phase 为准（保证刷新可恢复/不可跳未来）
        const workflowPhase = ws.articleWorkflow?.phase;
        if (workflowPhase) {
          setPhase(workflowPhase as WorkflowPhase);
        } else {
          // 兼容旧数据：无 workflow 时按原逻辑推导
          if (ws.articleContentWithMarkers) {
            const extracted = extractMarkers(ws.articleContentWithMarkers);
            setMarkers(extracted);
            if (extracted.length > 0) {
              setPhase(2); // MarkersGenerated
            }
          } else if (content) {
            setUploadedFileName('已上传的文章.md');
            setPhase(1); // Editing
          }
        }
        
        // 如果有生成的内容，提取标记（用于右侧列表）
        if (ws.articleContentWithMarkers) {
          const extracted = extractMarkers(ws.articleContentWithMarkers);
          setMarkers(extracted);
        }
        
        // 新增：从 workflow.markers 恢复右侧运行状态
        if (ws.articleWorkflow?.markers && ws.articleWorkflow.markers.length > 0) {
          const restoredItems: MarkerRunItem[] = ws.articleWorkflow.markers.map((m: any) => ({
            markerIndex: m.index,
            markerText: m.text || '',
            draftText: m.draftText || m.text || '',
            status: (m.status || 'idle') as MarkerRunStatus,
            // 恢复 planItem（意图解析结果）
            planItem: m.planItem ? {
              prompt: m.planItem.prompt || '',
              count: m.planItem.count || 1,
              size: m.planItem.size || undefined,
            } : null,
            runId: m.runId || null,
            // 恢复图片数据（只使用 URL，不使用 base64 以减少存储压力）
            base64: null, // 前端不从后端恢复 base64
            url: m.url || null,
            assetUrl: m.assetId ? (res.data.assets?.find((a: any) => a.id === m.assetId)?.url || null) : null,
            errorMessage: m.errorMessage || null,
          }));
          setMarkerRunItems(restoredItems);
          setMarkerRunItemsRestored(true); // 标记已恢复
        }
        
        // 加载文学创作提示词（从后端）
        await loadLiteraryPrompts();
      }
    } catch (error) {
      console.error('Failed to load workspace:', error);
    }
  }

  // markers 变化时：初始化/对齐右侧运行状态列表（保持用户已编辑内容）
  useEffect(() => {
    // 如果已经从后端恢复过状态，就不要重新初始化
    if (markerRunItemsRestored) {
      setMarkerRunItemsRestored(false); // 重置标志位，下次 markers 变化时正常处理
      return;
    }
    
    setMarkerRunItems((prev) => {
      const prevByIdx = new Map(prev.map((x) => [x.markerIndex, x]));
      const next: MarkerRunItem[] = markers.map((m) => {
        const old = prevByIdx.get(m.index);
        const markerText = String(m.text || '').trim();
        if (old) {
          return {
            ...old,
            markerText,
            draftText: old.draftText || markerText,
          };
        }
        return {
          markerIndex: m.index,
          markerText,
          draftText: markerText,
          status: 'idle',
          planItem: null,
          runId: null,
          base64: null,
          url: null,
          assetUrl: null,
          errorMessage: null,
        };
      });
      return next;
    });
  }, [markers, markerRunItemsRestored]);

  // 加载文学创作提示词（从后端）
  const loadLiteraryPrompts = useCallback(async () => {
    try {
      const res = await listLiteraryPrompts({ scenarioType: 'article-illustration' });
      if (res.success && res.data?.items) {
        const prompts: PromptTemplate[] = res.data.items.map((p: { id: string; title: string; content: string; isSystem?: boolean; scenarioType?: string | null; order?: number }) => ({
          id: p.id,
          title: p.title,
          content: p.content,
          isSystem: p.isSystem,
          scenarioType: p.scenarioType,
          order: p.order,
        }));
        setUserPrompts(prompts);
        // 如果有提示词但没有选中，自动选中第一个
        if (prompts.length > 0 && !selectedPrompt) {
          setSelectedPrompt(prompts[0]);
        }
      }
    } catch (error) {
      console.error('Failed to load literary prompts:', error);
    }
  }, [selectedPrompt]);

  const isBusy = generating || markerStreaming;

  useEffect(() => {
    if (debouncedArticleContent && workspaceId && phase === 1 && !isBusy) { // Editing
      void saveArticleContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedArticleContent, isBusy]);

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

  // 文件上传处理
  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name;
    
    try {
      const text = await file.text();
      setArticleContent(text);
      setUploadedFileName(fileName);
      
      // 保存到后端（提交型操作：会触发 version++，清空后续阶段）
      await updateImageMasterWorkspace({
        id: workspaceId,
        articleContent: text,
        idempotencyKey: `upload-article-${workspaceId}-${Date.now()}`,
      });
      
      // 上传后直接进入编辑模式并启用预览
      setPhase(1); // Editing
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

  // 拖拽处理函数
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    // 检查文件类型
    const fileName = file.name.toLowerCase();
    if (!fileName.endsWith('.md') && !fileName.endsWith('.txt')) {
      await systemDialog.alert('仅支持 .md 和 .txt 格式的文件');
      return;
    }

    try {
      const text = await file.text();
      setArticleContent(text);
      setUploadedFileName(file.name);
      
      // 保存到后端
      await updateImageMasterWorkspace({
        id: workspaceId,
        articleContent: text,
        idempotencyKey: `upload-article-${workspaceId}-${Date.now()}`,
      });
      
      // 上传后直接进入编辑模式
      setPhase(1); // Editing
    } catch {
      await systemDialog.alert('文件读取失败');
    }
  }, [workspaceId]);

  // 进入预览阶段（保留 phase=editing，表示“已上传可生成标记”）
  const handleEnterPreview = useCallback(() => {
    setPhase(1); // Editing
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

    setMarkerStreaming(true);
    isStreamingRef.current = true; // 标记开始流式输出
    // 3 状态模式：生成标记时直接跳到 MarkersGenerated，流式更新内容
    setPhase(2); // MarkersGenerated
    setArticleWithMarkers(''); // 初始为空，流式逐步填充
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
      let currentLineBuffer = ''; // 当前行缓冲区
      const extractedMarkers: ArticleMarker[] = []; // 已提取的标记
      
      for await (const chunk of stream) {
        if ((chunk.type === 'chunk' || chunk.type === 'delta') && chunk.text) {
          fullText += chunk.text;
          currentLineBuffer += chunk.text;
          
          // 检查是否有完整的行（以 \n 结尾）
          if (currentLineBuffer.includes('\n')) {
            const lines = currentLineBuffer.split('\n');
            // 最后一个元素是不完整的行（或空字符串），保留在缓冲区
            currentLineBuffer = lines.pop() || '';
            
            // 处理所有完整的行
            for (const line of lines) {
              // 对这一行进行标记匹配
              const markerRegex = /\[插图\]\s*:\s*(.+)/;
              const match = markerRegex.exec(line);
              
              if (match) {
                const markerText = match[1].trim();
                
                // 只有当 markerText 不为空时才添加
                if (markerText.length > 0) {
                  const markerIndex = extractedMarkers.length;
                  extractedMarkers.push({
                    index: markerIndex,
                    text: markerText,
                    startPos: -1, // 流式输出时不需要精确位置
                    endPos: -1,
                  });
                  
                  // 更新 UI
                  setMarkers([...extractedMarkers]);
                  
                  // 添加到运行列表（状态为 parsing，立即触发意图解析）
                  setMarkerRunItems((prev) => {
                    if (prev.some((x) => x.markerIndex === markerIndex)) {
                      return prev;
                    }
                    return [
                      ...prev,
                      {
                        markerIndex,
                        markerText,
                        draftText: markerText,
                        status: 'parsing' as MarkerRunStatus,
                      },
                    ];
                  });
                  
                  // 立即触发意图解析（不等待流式输出完成）
                  void (async () => {
                    try {
                      const planRes = await planImageGen({
                        text: markerText,
                        maxItems: 1,
                      });
                      
                      if (planRes.success && planRes.data?.items?.[0]) {
                        const planItem = planRes.data.items[0];
                        
                        setMarkerRunItems((prev) =>
                          prev.map((x) =>
                            x.markerIndex === markerIndex
                              ? { ...x, status: 'parsed' as MarkerRunStatus, planItem }
                              : x
                          )
                        );
                        
                        // 保存意图解析结果到后端
                        await updateMarkerStatus(markerIndex, {
                          status: 'parsed',
                          draftText: planItem.prompt,
                          planItem: {
                            prompt: planItem.prompt,
                            count: planItem.count,
                            size: planItem.size,
                          },
                        });
                      } else {
                        setMarkerRunItems((prev) =>
                          prev.map((x) =>
                            x.markerIndex === markerIndex
                              ? {
                                  ...x,
                                  status: 'error' as MarkerRunStatus,
                                  errorMessage: planRes.error?.message || '意图解析失败',
                                }
                              : x
                          )
                        );
                      }
                    } catch (error) {
                      console.error('Plan image gen error:', error);
                      setMarkerRunItems((prev) =>
                        prev.map((x) =>
                          x.markerIndex === markerIndex
                            ? {
                                ...x,
                                status: 'error' as MarkerRunStatus,
                                errorMessage: error instanceof Error ? error.message : '意图解析失败',
                              }
                            : x
                        )
                      );
                    }
                  })();
                }
              }
            }
          }
          
          // 使用 flushSync 强制立即刷新，绕过 React 18 的自动批处理
          flushSync(() => {
            setArticleWithMarkers(fullText);
          });
          
          // 人工延迟 10ms，让用户能看到流式渲染效果（配合后端 10ms 延迟）
          await new Promise(resolve => setTimeout(resolve, 10));
        } else if (chunk.type === 'done' && chunk.fullText) {
          fullText = chunk.fullText;
          setArticleWithMarkers(fullText);
          
          // 提取标记（确保最终状态一致）
          const extracted = extractMarkers(fullText);
          setMarkers(extracted);
          
          // 对于那些还没有被处理的标记（状态为 pending），触发意图解析
          // 注意：流式输出过程中已经处理过的标记（parsing/parsed/error）不需要重复处理
          extracted.forEach((marker) => {
            const markerIndex = marker.index;
            const markerText = marker.text;
            
            setMarkerRunItems((prev) => {
              const existingItem = prev.find((x) => x.markerIndex === markerIndex);
              
              // 如果已经存在且不是 idle 状态，说明已经在流式输出时处理过了，跳过
              if (existingItem && existingItem.status !== 'idle') {
                return prev;
              }
              
              // 如果不存在或状态为 pending，则触发意图解析
              if (!existingItem) {
                // 添加新项并触发解析
                const newPrev = [
                  ...prev,
                  {
                    markerIndex,
                    markerText,
                    draftText: markerText,
                    status: 'parsing' as MarkerRunStatus,
                  },
                ];
                
                // 异步调用意图解析
                void (async () => {
                  try {
                    const planRes = await planImageGen({
                      text: markerText,
                      maxItems: 1,
                    });
                    
                    if (planRes.success && planRes.data?.items?.[0]) {
                      const planItem = planRes.data.items[0];
                      
                      setMarkerRunItems((p) =>
                        p.map((x) =>
                          x.markerIndex === markerIndex
                            ? { ...x, status: 'parsed' as MarkerRunStatus, planItem }
                            : x
                        )
                      );
                      await updateMarkerStatus(markerIndex, {
                        status: 'parsed',
                        draftText: planItem.prompt,
                        planItem: {
                          prompt: planItem.prompt,
                          count: planItem.count,
                          size: planItem.size,
                        },
                      });
                    } else {
                      setMarkerRunItems((p) =>
                        p.map((x) =>
                          x.markerIndex === markerIndex
                            ? {
                                ...x,
                                status: 'error' as MarkerRunStatus,
                                errorMessage: planRes.error?.message || '意图解析失败',
                              }
                            : x
                        )
                      );
                    }
                  } catch (error) {
                    console.error('Plan image gen error:', error);
                    setMarkerRunItems((p) =>
                      p.map((x) =>
                        x.markerIndex === markerIndex
                          ? {
                              ...x,
                              status: 'error' as MarkerRunStatus,
                              errorMessage: error instanceof Error ? error.message : '意图解析失败',
                            }
                          : x
                      )
                    );
                  }
                })();
                
                return newPrev;
              } else {
                // 状态为 pending，更新为 parsing 并触发解析
                const updatedPrev = prev.map((x) =>
                  x.markerIndex === markerIndex
                    ? { ...x, markerText, draftText: markerText, status: 'parsing' as MarkerRunStatus }
                    : x
                );
                
                // 异步调用意图解析
                void (async () => {
                  try {
                    const planRes = await planImageGen({
                      text: markerText,
                      maxItems: 1,
                    });
                    
                    if (planRes.success && planRes.data?.items?.[0]) {
                      const planItem = planRes.data.items[0];
                      
                      setMarkerRunItems((p) =>
                        p.map((x) =>
                          x.markerIndex === markerIndex
                            ? { ...x, status: 'parsed' as MarkerRunStatus, planItem }
                            : x
                        )
                      );
                      await updateMarkerStatus(markerIndex, {
                        status: 'parsed',
                        draftText: planItem.prompt,
                        planItem: {
                          prompt: planItem.prompt,
                          count: planItem.count,
                          size: planItem.size,
                        },
                      });
                    } else {
                      setMarkerRunItems((p) =>
                        p.map((x) =>
                          x.markerIndex === markerIndex
                            ? {
                                ...x,
                                status: 'error' as MarkerRunStatus,
                                errorMessage: planRes.error?.message || '意图解析失败',
                              }
                            : x
                        )
                      );
                    }
                  } catch (error) {
                    console.error('Plan image gen error:', error);
                    setMarkerRunItems((p) =>
                      p.map((x) =>
                        x.markerIndex === markerIndex
                          ? {
                              ...x,
                              status: 'error' as MarkerRunStatus,
                              errorMessage: error instanceof Error ? error.message : '意图解析失败',
                            }
                          : x
                      )
                    );
                  }
                })();
                
                return updatedPrev;
              }
            });
          });
          
          // 提交型操作成功：更新阶段
          setPhase(2); // MarkersGenerated
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
      setPhase(1); // Editing
    } finally {
      setMarkerStreaming(false);
      isStreamingRef.current = false; // 标记流式输出结束
    }
  };

  const parseSizeFromText = (text: string): string | null => {
    // 允许：1080x608 / 1024x1024 等
    const m = /(\d{3,4}\s*x\s*\d{3,4})/i.exec(text);
    if (!m) return null;
    return m[1].replace(/\s+/g, '').toLowerCase();
  };

  const safeJsonParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  // markerRunItems 的最新快照（用于批量流程读写）
  const markerRunItemsRef = useRef<MarkerRunItem[]>([]);
  useEffect(() => {
    markerRunItemsRef.current = markerRunItems;
  }, [markerRunItems]);

  const buildPreviewMarkdownWithImages = useCallback(
    (items: MarkerRunItem[]) => {
      const base = String(articleWithMarkers || articleContent || '');
      if (!base) return '';

      const byIndex = new Map<number, MarkerRunItem>(items.map((x) => [x.markerIndex, x]));
      const patches: Array<{ start: number; end: number; replacement: string }> = [];
      let changed = false;

      // 关键：按 markerIndex 精准替换（允许只生成第 N 张，不依赖“前缀完成”）
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const it = byIndex.get(m.index);
        if (!it) continue;

        const url =
          String(it.assetUrl || it.url || '').trim() ||
          (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');

        if (url && it.status === 'done') {
          changed = true;
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `![配图 ${i + 1}](${url})`,
          });
          continue;
        }

        // "立刻插入"：无图时点击生成后，生成中也会在对应 marker 行下方插入占位提示
        // 注意：只有在 running 状态时才插入提示，parsing 和 parsed 状态不插入（意图解析是静默的）
        const isGenerating = it.status === 'running';
        if (isGenerating) {
          changed = true;
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `[插图] : ${m.text}\n\n> 配图 ${i + 1} 生成中...`,
          });
        }
      }

      if (!changed) return '';

      // 从后往前替换，避免偏移
      patches.sort((a, b) => b.start - a.start);
      let out = base;
      for (const p of patches) {
        out = out.slice(0, p.start) + p.replacement + out.slice(p.end);
      }
      return out;
    },
    [articleWithMarkers, articleContent, markers]
  );

  const rebuildMergedMarkdown = useCallback(
    (items: MarkerRunItem[]) => {
      setArticleWithImages(buildPreviewMarkdownWithImages(items));
    },
    [buildPreviewMarkdownWithImages]
  );

  const locateMarkerInPreview = (markerIndex: number) => {
    const container = articlePreviewRef.current;
    if (!container) return;
    const markers = container.querySelectorAll('.prd-md-marker');
    const target = markers[markerIndex] as HTMLElement | undefined;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const imgAlt = `配图 ${markerIndex + 1}`;
    const img = container.querySelector(`img[alt="${imgAlt}"]`) as HTMLElement | null;
    if (!img) return;
    img.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // markerRunItems 状态变化时：立即刷新左侧预览（支持"单条先生成"不乱序）
  useEffect(() => {
    if (phase === 2) { // MarkersGenerated
      rebuildMergedMarkdown(markerRunItems);
    }
  }, [markerRunItems, phase, rebuildMergedMarkdown]);

  const runSingleMarker = async (markerIndex: number) => {
    if (isStreamingRef.current) {
      await systemDialog.alert('标记正在生成中，请稍后再试');
      return;
    }
    if (!imageGenModel) {
      await systemDialog.alert(imageGenModelError || '未选择生图模型');
      return;
    }
    const current = markerRunItems.find((x) => x.markerIndex === markerIndex) ?? null;
    if (!current) return;
    const text = String(current.draftText || current.markerText || '').trim();
    if (!text) {
      await systemDialog.alert('提示词为空');
      return;
    }

    const cachedPlanItem = current.planItem;
    const cachedDraft = String(current.draftText || '').trim();
    // 1) 已解析过则直接复用，避免重复 planImageGen
    setMarkerRunItems((prev) =>
      prev.map((x) =>
        x.markerIndex === markerIndex
          ? { ...x, status: 'parsing', errorMessage: null, planItem: null, runId: null, base64: null, url: null, assetUrl: null }
          : x
      )
    );
    await updateMarkerStatus(markerIndex, { status: 'parsing' }); // 保存到后端

    let plannedPrompt = '';
    let plannedSize = '';
    let planItem: ImageGenPlanItem | null = null;

    if (cachedPlanItem && String(cachedPlanItem.prompt || '').trim()) {
      planItem = cachedPlanItem;
      plannedPrompt = String(cachedPlanItem.prompt || '').trim();
      plannedSize = String(cachedPlanItem.size || '').trim();
    } else if (cachedDraft) {
      plannedPrompt = cachedDraft;
    } else {
      const planRes = await planImageGen({ text, maxItems: 1 });
      if (!planRes.success) {
        const errorMsg = planRes.error?.message || '解析失败';
        setMarkerRunItems((prev) =>
          prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
        );
        await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
        return;
      }
      const first = (planRes.data?.items ?? [])[0] ?? null;
      if (!first || !String(first.prompt || '').trim()) {
        const errorMsg = '解析失败：未返回有效 JSON';
        setMarkerRunItems((prev) =>
          prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
        );
        await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
        return;
      }
      planItem = first;
      plannedPrompt = String(first.prompt || '').trim();
      plannedSize = String(first.size || '').trim();
    }

    plannedSize = plannedSize || parseSizeFromText(plannedPrompt) || parseSizeFromText(text) || '1024x1024';

    setMarkerRunItems((prev) =>
      prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'parsed', planItem } : x))
    );
    if (planItem) {
      await updateMarkerStatus(markerIndex, {
        status: 'parsed',
        draftText: plannedPrompt,
        planItem: {
          prompt: planItem.prompt,
          count: planItem.count,
          size: planItem.size,
        },
      });
    } else {
      await updateMarkerStatus(markerIndex, { status: 'parsed', draftText: plannedPrompt });
    }

    // 2) 创建 run（传入 workspaceId，后端会自动保存到 COS）
    setMarkerRunItems((prev) =>
      prev.map((x) =>
        x.markerIndex === markerIndex ? { ...x, status: 'running', base64: null, url: null, assetUrl: null } : x
      )
    );
    const idem = `article_img_${workspaceId}_${markerIndex}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const created = await createImageGenRun({
      input: {
        configModelId: imageGenModel.id,
        items: [{ prompt: plannedPrompt, count: 1, size: plannedSize }],
        size: plannedSize,
        responseFormat: 'url',  // 使用 URL 格式，后端会自动保存到 COS
        maxConcurrency: 1,
        workspaceId,  // 传入 workspaceId，后端会自动保存图片到 COS
      },
      idempotencyKey: idem,
    });
    if (!created.success) {
      const errorMsg = created.error?.message || '生图失败';
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
      );
      await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
      return;
    }
    const runId = String(created.data?.runId || '').trim();
    if (!runId) {
      const errorMsg = '生图失败：未返回 runId';
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: errorMsg } : x))
      );
      await updateMarkerStatus(markerIndex, { status: 'error', errorMessage: errorMsg });
      return;
    }
    setMarkerRunItems((prev) => prev.map((x) => (x.markerIndex === markerIndex ? { ...x, runId } : x)));
    await updateMarkerStatus(markerIndex, { status: 'running', runId }); // 保存

    // 3) 订阅 SSE，拿到 base64/url
    let gotBase64: string | null = null;
    let gotUrl: string | null = null;
    const ac = genAbortRef.current;
    const res = await streamImageGenRunWithRetry({
      runId,
      afterSeq: 0,
      maxAttempts: 20,
      signal: ac?.signal ?? new AbortController().signal,
      onEvent: (evt) => {
        if (!evt.data) return;
        const obj = safeJsonParse(String(evt.data));
        if (!obj || typeof obj !== 'object') return;
        const o = obj as Record<string, unknown>;
        const t = String(o.type ?? '');
        if (t === 'imageDone') {
          const evtRunId = String(o.runId ?? '').trim();
          if (evtRunId && evtRunId !== runId) return;
          const b64 = (o.base64 as string | null | undefined) ?? null;
          const url = (o.url as string | null | undefined) ?? null;
          gotBase64 = b64;
          gotUrl = url;
          setMarkerRunItems((prev) =>
            prev.map((x) => (x.markerIndex === markerIndex ? { ...x, base64: b64, url: url, errorMessage: null } : x))
          );
        }
        if (t === 'imageError') {
          const msg = String(o.errorMessage ?? '生图失败');
          setMarkerRunItems((prev) =>
            prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: msg } : x))
          );
        }
      },
    });
    if (!res.success) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: res.error?.message || '生图失败' } : x))
      );
      return;
    }

    // 4) 将结果转为可插入文章的 url：优先 SSE url；否则上传 base64 得到 asset.url
    const finalUrl = String(gotUrl || '').trim();
    const finalB64 = String(gotBase64 || '').trim();
    if (finalUrl) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'done', assetUrl: finalUrl, url: finalUrl } : x))
      );
      // 保存图片URL到后端
      await updateMarkerStatus(markerIndex, { status: 'done' });
      try {
        await updateArticleMarker({
          workspaceId,
          markerIndex,
          url: finalUrl,
        });
      } catch (error) {
        console.error('Failed to save image url:', error);
      }
      return;
    }
    if (!finalB64) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: '生图失败：未返回图片' } : x))
      );
      return;
    }

    const dataUrl = finalB64.startsWith('data:') ? finalB64 : `data:image/png;base64,${finalB64}`;
    const up = await uploadImageMasterWorkspaceAsset({ 
      id: workspaceId, 
      data: dataUrl, 
      prompt: plannedPrompt,
      articleInsertionIndex: markerIndex,
      originalMarkerText: current.markerText
    });
    if (!up.success) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: up.error?.message || '图片持久化失败' } : x))
      );
      return;
    }
    const assetUrl = String(up.data?.asset?.url || '').trim();
    if (!assetUrl) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: '图片持久化失败：未返回 url' } : x))
      );
      return;
    }
    setMarkerRunItems((prev) =>
      prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'done', assetUrl, url: assetUrl } : x))
    );
    // 图片已经通过 uploadImageMasterWorkspaceAsset 上传到腾讯云 COS，assetUrl 就是 COS 的 URL
    // 保存 URL 到后端（刷新后可恢复）
    await updateMarkerStatus(markerIndex, { status: 'done' });
    try {
      await updateArticleMarker({
        workspaceId,
        markerIndex,
        url: assetUrl,
      });
    } catch (error) {
      console.error('Failed to save asset url:', error);
    }
  };

  // 新增辅助函数：保存 marker 状态到后端
  const updateMarkerStatus = async (markerIndex: number, updates: {
    draftText?: string;
    status?: string;
    runId?: string;
    errorMessage?: string;
    planItem?: { prompt: string; count?: number; size?: string };
  }) => {
    try {
      const planItem = updates.planItem
        ? {
            prompt: updates.planItem.prompt,
            count: updates.planItem.count ?? 1,
            size: updates.planItem.size,
          }
        : undefined;
      await updateArticleMarker({
        workspaceId,
        markerIndex,
        ...updates,
        planItem,
      });
    } catch (error) {
      console.error('Failed to update marker status:', error);
    }
  };

  const handleBatchGenerate = async () => {
    if (!imageGenModel) {
      await systemDialog.alert(imageGenModelError || '未选择生图模型');
      return;
    }
    if (markers.length === 0) {
      await systemDialog.alert('暂无配图标记');
      return;
    }
    if (!articleWithMarkers.trim()) {
      await systemDialog.alert('请先生成配图标记');
      return;
    }

    genAbortRef.current?.abort();
    const ac = new AbortController();
    genAbortRef.current = ac;

    setGenerating(true);
    setArticleWithImages('');

    try {
      // 并行发起所有生图任务
      const ordered = [...markerRunItemsRef.current].sort((a, b) => a.markerIndex - b.markerIndex);
      const results = await Promise.allSettled(
        ordered.map(it => runSingleMarker(it.markerIndex))
      );
      
      // 检查是否有失败
      const anyError = results.some(r => r.status === 'rejected') || 
                       markerRunItemsRef.current.some(x => x.status === 'error');
      
      setGenerating(false);
      // 3 状态模式：生图完成后仍保持在 MarkersGenerated
      setPhase(2); // MarkersGenerated
      
      if (anyError && !ac.signal.aborted) {
        await systemDialog.alert('部分配图生成失败：可在右侧逐条修改并重新生成');
      }
    } catch (error) {
      console.error('Batch generate error:', error);
      setGenerating(false);
      setPhase(2); // MarkersGenerated
    }
  };

  const handleRegenerateOne = async (markerIndex: number) => {
    if (isBusy) return;
    setGenerating(true);
    try {
      await runSingleMarker(markerIndex);
    } finally {
      setGenerating(false);
      // 3 状态模式：生图完成后仍保持在 MarkersGenerated
      setPhase(2); // MarkersGenerated
    }
  };

  const removeMarkerFromContent = (content: string, marker: ArticleMarker): string => {
    let start = marker.startPos;
    let end = marker.endPos;

    // 优先吃掉行尾换行；否则吃掉行首换行，避免留下空行
    const nextTwo = content.slice(end, end + 2);
    if (nextTwo === '\r\n') end += 2;
    else if (content[end] === '\n' || content[end] === '\r') end += 1;
    else if (start > 0 && (content[start - 1] === '\n' || content[start - 1] === '\r')) start -= 1;

    return content.slice(0, start) + content.slice(end);
  };

  const handleDeleteMarker = async (markerIndex: number) => {
    if (isBusy) return;
    const marker = markers.find((m) => m.index === markerIndex) ?? null;
    if (!marker) return;

    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确定要删除配图 ${markerIndex + 1} 吗？将同时移除文章中的对应 [插图] 标记（不可恢复）。`,
      tone: 'danger',
    });
    if (!ok) return;

    const current = String(articleWithMarkers || '').trim();
    if (!current) return;

    const nextArticleWithMarkers = removeMarkerFromContent(articleWithMarkers, marker);
    const nextMarkers = extractMarkers(nextArticleWithMarkers);
    const nextRunItems = markerRunItemsRef.current
      .filter((x) => x.markerIndex !== markerIndex)
      .map((x) => (x.markerIndex > markerIndex ? { ...x, markerIndex: x.markerIndex - 1 } : x));

    setArticleWithMarkers(nextArticleWithMarkers);
    setMarkers(nextMarkers);
    setMarkerRunItems(nextRunItems);

    if (nextMarkers.length === 0) {
      setPhase(1); // Editing
    }
  };

  const handleExport = async () => {
    try {
      // 使用与预览相同的逻辑：精确替换标记为图片
      const base = String(articleWithMarkers || articleContent || '');
      if (!base) {
        await systemDialog.alert({ title: '导出失败', message: '文章内容为空' });
        return;
      }

      const byIndex = new Map<number, MarkerRunItem>(markerRunItems.map((x) => [x.markerIndex, x]));
      const patches: Array<{ start: number; end: number; replacement: string }> = [];

      // 遍历所有标记，将已完成的配图替换为图片 Markdown
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const it = byIndex.get(m.index);
        if (!it) continue;

        const url =
          String(it.assetUrl || it.url || '').trim() ||
          (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');

        if (url && it.status === 'done') {
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `![配图 ${i + 1}](${url})`,
          });
        }
      }

      // 从后往前替换，避免偏移
      patches.sort((a, b) => b.start - a.start);
      let contentWithImages = base;
      for (const p of patches) {
        contentWithImages = contentWithImages.slice(0, p.start) + p.replacement + contentWithImages.slice(p.end);
      }

      // 如果没有任何替换，提示用户
      if (patches.length === 0) {
        const ok = await systemDialog.confirm({
          title: '确认导出',
          message: '当前没有已完成的配图，是否导出原始文章（包含 [插图] 标记）？',
        });
        if (!ok) return;
        contentWithImages = base;
      }

      setArticleWithImages(contentWithImages);

      // 创建下载链接
      const blob = new Blob([contentWithImages], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${uploadedFileName || '文章配图'}.md`;
      link.click();
      URL.revokeObjectURL(url);

      await systemDialog.alert({ 
        title: '导出成功', 
        message: `已导出 ${patches.length} 张配图到文章中` 
      });
    } catch (error) {
      console.error('Export error:', error);
      await systemDialog.alert('导出失败');
    }
  };

  // 创建新提示词模板
  const [creatingPrompt, setCreatingPrompt] = useState<{ title: string; content: string } | null>(null);
  // 小屏：编辑/预览切换；大屏：左右分栏同时显示
  const [promptPanel, setPromptPanel] = useState<'edit' | 'preview'>('edit');

  const handleCreatePrompt = () => {
    setPromptPanel('edit');
    setCreatingPrompt({
      title: '',
      content: '',
    });
  };

  const handleSaveNewPrompt = async () => {
    if (!creatingPrompt) return;

    try {
      const res = await createLiteraryPrompt({
        title: creatingPrompt.title,
        content: creatingPrompt.content,
        scenarioType: 'article-illustration',
      });

      if (res.success && res.data?.prompt) {
        const newPrompt: PromptTemplate = {
          id: res.data.prompt.id,
          title: res.data.prompt.title,
          content: res.data.prompt.content,
          isSystem: res.data.prompt.isSystem,
          scenarioType: res.data.prompt.scenarioType,
          order: res.data.prompt.order,
        };

        const updated = [...userPrompts, newPrompt];
        setUserPrompts(updated);
        setSelectedPrompt(newPrompt);
        setCreatingPrompt(null);
      } else {
        await systemDialog.alert({ title: '创建失败', message: res.error?.message || '未知错误' });
      }
    } catch (error) {
      console.error('Failed to create prompt:', error);
      await systemDialog.alert('创建失败');
    }
  };

  const handleCancelCreate = () => {
    setCreatingPrompt(null);
  };

  // 编辑提示词模板
  const [editingPrompt, setEditingPrompt] = useState<{ id: string; title: string; content: string } | null>(null);

  const handleEditPrompt = (prompt: PromptTemplate) => {
    setPromptPanel('edit');
    setEditingPrompt({
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
    });
  };

  const handleSaveEdit = async () => {
    if (!editingPrompt) return;

    try {
      const res = await updateLiteraryPrompt({
        id: editingPrompt.id,
        title: editingPrompt.title,
        content: editingPrompt.content,
      });

      if (res.success && res.data?.prompt) {
        const updated = userPrompts.map((p) =>
          p.id === editingPrompt.id
            ? {
                ...p,
                title: res.data.prompt.title,
                content: res.data.prompt.content,
                order: res.data.prompt.order,
              }
            : p
        );
        setUserPrompts(updated);

        if (selectedPrompt?.id === editingPrompt.id) {
          setSelectedPrompt({ ...selectedPrompt, title: editingPrompt.title, content: editingPrompt.content });
        }

        setEditingPrompt(null);
      } else {
        await systemDialog.alert({ title: '保存失败', message: res.error?.message || '未知错误' });
      }
    } catch (error) {
      console.error('Failed to update prompt:', error);
      await systemDialog.alert('保存失败');
    }
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

    try {
      const res = await deleteLiteraryPrompt({ id: prompt.id });

      if (res.success) {
        const updated = userPrompts.filter((p) => p.id !== prompt.id);
        setUserPrompts(updated);

        if (selectedPrompt?.id === prompt.id) {
          setSelectedPrompt(updated.length > 0 ? updated[0] : null);
        }
      } else {
        await systemDialog.alert({ title: '删除失败', message: res.error?.message || '未知错误' });
      }
    } catch (error) {
      console.error('Failed to delete prompt:', error);
      await systemDialog.alert('删除失败');
    }
  };

  const buttonConfig = [
    {
      label: '生成配图标记',
      action: handleGenerateMarkers,
      icon: Wand2,
      disabled: !articleContent.trim() || !selectedPrompt,
      show: phase === 1, // Editing
    },
    {
      label: '生成配图标记中...',
      action: async () => {},
      icon: Wand2,
      disabled: true,
      show: false, // 3 状态模式：无 MarkersGenerating 中间态
    },
    {
      label: '一键生图',
      action: handleBatchGenerate,
      icon: Sparkles,
      disabled: !imageGenModel || generating,
      show: phase === 2 && markerRunItems.filter(x => x.status === 'done').length === 0, // MarkersGenerated
    },
    {
      label: '一键导出',
      action: handleExport,
      icon: Download,
      disabled: false,
      show: phase === 2 && markerRunItems.filter(x => x.status === 'done').length > 0, // MarkersGenerated
    },
  ];

  const activeButton = buttonConfig.find((btn) => btn.show);

  // 左侧统一作为"预览面板"：上传时渲染原文；AI 流式生成时直接渲染带标记版本
  const leftPreviewMarkdown =
    phase === 2 // MarkersGenerated
      ? (articleWithImages || articleWithMarkers || articleContent)
      : articleContent;

  const markerRegex = /\[插图\]\s*:\s*([^\n]+)/g;
  const highlightText = (text: string) => {
    const out: Array<string | JSX.Element> = [];
    let last = 0;
    let m: RegExpExecArray | null;
    markerRegex.lastIndex = 0;
    while ((m = markerRegex.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (start > last) out.push(text.slice(last, start));
      out.push(
        <mark key={`${start}-${end}`} className="prd-md-marker">
          {m[0]}
        </mark>
      );
      last = end;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const highlightChildren = (children: React.ReactNode): React.ReactNode => {
    if (typeof children === 'string') return <>{highlightText(children)}</>;
    if (Array.isArray(children)) return <>{children.map((c, i) => <span key={i}>{highlightChildren(c)}</span>)}</>;
    if (React.isValidElement(children)) {
      const type = children.type;
      // 不在 code/pre 内做高亮，避免破坏代码块内容
      if (type === 'code' || type === 'pre') return children;
      const next = highlightChildren(children.props.children);
      return React.cloneElement(children, { ...children.props, children: next });
    }
    return children;
  };

  const phaseSteps: Array<{ key: WorkflowPhase; label: string }> = [
    { key: 0, label: '上传' },
    { key: 1, label: '预览' },
    { key: 2, label: '配图标记' },
  ];

  const handleStepClick = async (stepKey: number) => {
    const targetPhase = stepKey as WorkflowPhase;
    if (targetPhase === phase || isBusy) return;

    // 简单切换阶段（不做复杂的服务端校验）
    setPhase(targetPhase);
  };


  return (
    <div className="h-full min-h-0 flex gap-4">
      {/* 左侧：文章编辑器 */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <Card className="flex-1 min-h-0 flex flex-col">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText size={16} style={{ color: 'var(--text-primary)' }} />
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                {uploadedFileName || '文章内容'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {phase === 0 && uploadedFileName && ( // Upload
                <Button size="sm" variant="primary" onClick={handleEnterPreview}>
                  <Edit2 size={14} />
                  进入预览
                </Button>
              )}
            </div>
          </div>

          {/* 系统提示词：永远可见（预览 + 列表） */}
          <div className="mb-3">
            <div className="mt-2 rounded-[12px] px-2 py-2 flex items-center gap-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-subtle)' }}>
              {/* 标签 */}
              <div className="inline-block text-[10px] px-2 py-1 rounded font-semibold shrink-0" style={{ background: 'rgba(147, 197, 253, 0.1)', color: 'rgba(147, 197, 253, 0.7)', border: '1px solid rgba(147, 197, 253, 0.2)' }}>
                系统提示词
              </div>
              {watermarkEnabled && (
                <div
                  className="inline-block text-[10px] px-2 py-1 rounded font-semibold shrink-0"
                  style={{ background: 'rgba(245, 158, 11, 0.12)', color: 'rgba(245, 158, 11, 0.85)', border: '1px solid rgba(245, 158, 11, 0.28)' }}
                >
                  水印
                </div>
              )}
              
              {/* 标题 */}
              <div className="flex-1 min-w-0">
                {allPrompts.length === 0 ? (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    还没有提示词模板
                  </div>
                ) : selectedPrompt ? (
                  <div>
                    <style>{`
                      .prompt-marquee{position:relative;overflow:hidden;white-space:nowrap;min-width:0;width:100%}
                      .prompt-marquee__track{display:flex;align-items:center;gap:16px;width:max-content;will-change:transform}
                      .prompt-marquee__track--animate{animation:prompt-marquee-scroll 10s linear infinite}
                      .prompt-marquee__track--static{animation:none;width:100%}
                      .prompt-marquee__item{display:inline-block;white-space:nowrap}
                      @keyframes prompt-marquee-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
                      @media (prefers-reduced-motion: reduce){.prompt-marquee__track--animate{animation:none}}
                    `}</style>
                    <div className="prompt-marquee">
                      <div className={`prompt-marquee__track ${selectedPrompt.title.length > 30 ? 'prompt-marquee__track--animate' : 'prompt-marquee__track--static'}`}>
                        <span className="prompt-marquee__item text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {selectedPrompt.title}
                        </span>
                        {selectedPrompt.title.length > 30 && (
                          <span className="prompt-marquee__item text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {selectedPrompt.title}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
              
              {/* 按钮 */}
              <div className="shrink-0">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => setPromptPreviewOpen(true)}
                  title="切换系统提示词"
                >
                  <Eye size={12} />
                  切换
                </Button>
              </div>
            </div>
          </div>

          <div 
            ref={articlePreviewRef}
            className="flex-1 min-h-0 overflow-auto relative"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <style>{PRD_MD_STYLE}</style>
            
            {/* 拖拽悬浮提示层 */}
            {isDragging && (
              <div 
                className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
                style={{
                  background: 'rgba(147, 197, 253, 0.15)',
                  border: '2px dashed rgba(147, 197, 253, 0.6)',
                  backdropFilter: 'blur(4px)',
                }}
              >
                <div className="text-center">
                  <Upload size={64} style={{ color: 'rgba(147, 197, 253, 0.95)' }} className="mx-auto mb-4" />
                  <div className="text-lg font-semibold mb-2" style={{ color: 'rgba(147, 197, 253, 0.95)' }}>
                    释放以上传文件
                  </div>
                  <div className="text-sm" style={{ color: 'rgba(147, 197, 253, 0.75)' }}>
                    支持 .md 和 .txt 格式
                  </div>
                </div>
              </div>
            )}
            
            {/* 上传阶段：显示上传区域或已上传文件信息 */}
            {phase === 0 && !uploadedFileName && ( // Upload
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
            {phase === 0 && uploadedFileName && ( // Upload
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
                    <Button variant="primary" onClick={handleEnterPreview}>
                      <Edit2 size={16} />
                      进入预览
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 预览阶段：渲染原文（不提供手动编辑入口） */}
            {phase === 1 && ( // Editing
              <div className="p-4 pt-10 relative">
                {!isDragging && (
                  <div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded font-semibold" style={{ background: 'rgba(147, 197, 253, 0.1)', color: 'rgba(147, 197, 253, 0.7)', border: '1px solid rgba(147, 197, 253, 0.2)' }}>
                    正文
                  </div>
                )}
                <div className="prd-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw]}
                    components={{
                      p: ({ node: _node, children, ...props }) => <p {...props}>{highlightChildren(children)}</p>,
                      li: ({ node: _node, children, ...props }) => <li {...props}>{highlightChildren(children)}</li>,
                      blockquote: ({ node: _node, children, ...props }) => <blockquote {...props}>{highlightChildren(children)}</blockquote>,
                      h1: ({ node: _node, children, ...props }) => <h1 {...props}>{highlightChildren(children)}</h1>,
                      h2: ({ node: _node, children, ...props }) => <h2 {...props}>{highlightChildren(children)}</h2>,
                      h3: ({ node: _node, children, ...props }) => <h3 {...props}>{highlightChildren(children)}</h3>,
                    }}
                  >
                    {leftPreviewMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            )}

            {/* 标记生成中/完成/生图等阶段：显示 markdown 预览（流式更新） */}
            {phase === 2 && ( // MarkersGenerated
              <div className="p-4 pt-10 relative">
                {!isDragging && (
                  <div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded font-semibold" style={{ background: 'rgba(147, 197, 253, 0.1)', color: 'rgba(147, 197, 253, 0.7)', border: '1px solid rgba(147, 197, 253, 0.2)' }}>
                    正文
                  </div>
                )}
                <div className="prd-md">
                  <ReactMarkdown
                    key={leftPreviewMarkdown.length}
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw]}
                    components={{
                      p: ({ node: _node, children, ...props }) => <p {...props}>{highlightChildren(children)}</p>,
                      li: ({ node: _node, children, ...props }) => <li {...props}>{highlightChildren(children)}</li>,
                      blockquote: ({ node: _node, children, ...props }) => <blockquote {...props}>{highlightChildren(children)}</blockquote>,
                      h1: ({ node: _node, children, ...props }) => <h1 {...props}>{highlightChildren(children)}</h1>,
                      h2: ({ node: _node, children, ...props }) => <h2 {...props}>{highlightChildren(children)}</h2>,
                      h3: ({ node: _node, children, ...props }) => <h3 {...props}>{highlightChildren(children)}</h3>,
                    }}
                  >
                    {leftPreviewMarkdown}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* 右侧：工作台 */}
      <div className="w-96 flex flex-col gap-4">
        {/* 顶部操作按钮 */}
        <Card>
          <WorkflowProgressBar 
            steps={phaseSteps} 
            currentStep={phase} 
            onStepClick={handleStepClick}
            disabled={generating}
            allCompleted={
              phase === 2 && 
              markerRunItems.length > 0 && 
              markerRunItems.every(x => x.status === 'done')
            }
          />
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

        {/* 配图标记列表（含生图结果/重生成） */}
        {phase === 2 && ( // MarkersGenerated
          <Card className="flex-1 min-h-0 flex flex-col">
            <div className="mb-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  配图标记列表
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={markerRunItems.filter(x => x.status === 'done').length === 0}
                  onClick={async () => {
                    try {
                      const JSZip = (await import('jszip')).default;
                      const zip = new JSZip();
                      
                      const doneItems = markerRunItems.filter(x => x.status === 'done' && (x.assetUrl || x.url || x.base64));
                      
                      if (doneItems.length === 0) {
                        await systemDialog.alert({ title: '无可下载图片', message: '还没有已完成的配图' });
                        return;
                      }
                      
                      let successCount = 0;
                      for (const item of doneItems) {
                        const src = item.assetUrl || item.url || (item.base64?.startsWith('data:') ? item.base64 : `data:image/png;base64,${item.base64}`) || '';
                        
                        if (!src) {
                          console.warn(`配图 ${item.markerIndex + 1} 没有图片数据`);
                          continue;
                        }
                        
                        try {
                          let blob: Blob;
                          
                          // 如果是 data URL（base64），直接转换为 blob
                          if (src.startsWith('data:')) {
                            const response = await fetch(src);
                            blob = await response.blob();
                          } else {
                            // 对于外部 URL，使用 Image + Canvas 方式绕过 CORS
                            blob = await new Promise<Blob>((resolve, reject) => {
                              const img = new Image();
                              img.crossOrigin = 'anonymous'; // 尝试启用 CORS
                              
                              img.onload = () => {
                                try {
                                  // 创建 canvas 并绘制图片
                                  const canvas = document.createElement('canvas');
                                  canvas.width = img.naturalWidth;
                                  canvas.height = img.naturalHeight;
                                  const ctx = canvas.getContext('2d');
                                  if (!ctx) {
                                    reject(new Error('无法创建 canvas context'));
                                    return;
                                  }
                                  ctx.drawImage(img, 0, 0);
                                  
                                  // 转换为 blob
                                  canvas.toBlob((b) => {
                                    if (b) {
                                      resolve(b);
                                    } else {
                                      reject(new Error('Canvas toBlob 失败'));
                                    }
                                  }, 'image/png');
                                } catch (error) {
                                  reject(error);
                                }
                              };
                              
                              img.onerror = () => {
                                reject(new Error('图片加载失败'));
                              };
                              
                              img.src = src;
                            });
                          }
                          
                          zip.file(`配图-${item.markerIndex + 1}.png`, blob);
                          successCount++;
                        } catch (error) {
                          console.error(`Failed to download image ${item.markerIndex + 1}:`, error);
                        }
                      }
                      
                      if (successCount === 0) {
                        await systemDialog.alert({ title: '下载失败', message: '所有图片下载失败，可能是跨域限制导致' });
                        return;
                      }
                      
                      const content = await zip.generateAsync({ type: 'blob' });
                      const link = document.createElement('a');
                      link.href = URL.createObjectURL(content);
                      link.download = `配图-${new Date().getTime()}.zip`;
                      link.click();
                      URL.revokeObjectURL(link.href);
                      
                      await systemDialog.alert({ 
                        title: '下载完成', 
                        message: `已打包 ${successCount} 张图片${successCount < doneItems.length ? `（${doneItems.length - successCount} 张失败）` : ''}` 
                      });
                    } catch (error) {
                      console.error('Batch download failed:', error);
                      await systemDialog.alert({ title: '下载失败', message: '批量下载图片时出错' });
                    }
                  }}
                  title="下载所有已生成的图片（ZIP 格式）"
                >
                  <DownloadCloud size={14} />
                  下载全部
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
                  <div 
                    className="h-full rounded-full transition-all duration-300" 
                    style={{ 
                      width: `${markerRunItems.length > 0 ? (markerRunItems.filter(x => x.status === 'done').length / markerRunItems.length * 100) : 0}%`,
                      background: 'linear-gradient(90deg, rgba(34, 197, 94, 0.8), rgba(34, 197, 94, 0.6))'
                    }}
                  />
                </div>
                <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {markerRunItems.filter(x => x.status === 'done').length}/{markerRunItems.length}
                </div>
              </div>
            </div>
            {imageGenModel ? (
              <div className="mb-3 flex items-center gap-2">
                <div 
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium"
                  style={{
                    background: 'rgba(139, 92, 246, 0.12)',
                    border: '1px solid rgba(139, 92, 246, 0.24)',
                    color: 'rgba(139, 92, 246, 0.95)',
                  }}
                >
                  <Sparkles size={14} />
                  <span>生图模型：{imageGenModel.modelName}</span>
                </div>
              </div>
            ) : imageGenModelError ? (
              <div className="mb-3 text-xs" style={{ color: 'rgba(239,68,68,0.92)' }}>
                生图模型不可用：{imageGenModelError}
              </div>
            ) : null}

            <div ref={markerListRef} className="flex-1 min-h-0 overflow-auto space-y-2">
              {markerRunItems.map((it, idx) => {
                const statusLabel =
                  it.status === 'parsing'
                    ? '解析中'
                    : it.status === 'parsed'
                      ? '已解析'
                      : it.status === 'running'
                        ? '生成中'
                        : it.status === 'done'
                          ? '完成'
                          : it.status === 'error'
                            ? '失败'
                            : '等待';

                const src =
                  String(it.assetUrl || it.url || '').trim() ||
                  (it.base64 ? (it.base64.startsWith('data:') ? it.base64 : `data:image/png;base64,${it.base64}`) : '');
                const showPlaceholder = it.status === 'running' || it.status === 'parsing';
                const canShow = Boolean(src) && it.status === 'done';
                const hasImage = Boolean(String(it.assetUrl || it.url || '').trim() || it.base64);
                const genLabel = hasImage ? '重新生成' : '生成图片';
                const genTitle = hasImage ? '重新生成该配图（会替换左侧预览中的对应插图）' : '生成该配图（会插入左侧预览中对应 [插图] 位置）';

                return (
                  <div
                  key={it.markerIndex}
                  className="p-3 rounded"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                      配图 {idx + 1}
                    </div>
                    <div className="flex items-center gap-2">
                      {/* 显示图片尺寸（如果已解析） */}
                      {it.planItem?.size && (
                        <div
                          className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                          style={{
                            background: 'rgba(99, 102, 241, 0.12)',
                            border: '1px solid rgba(99, 102, 241, 0.24)',
                            color: 'rgba(99, 102, 241, 0.95)',
                          }}
                          title={`图片尺寸：${it.planItem.size}`}
                        >
                          {it.planItem.size}
                        </div>
                      )}
                      {/* 状态标签 */}
                      <div
                        className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                        style={{
                          background:
                            it.status === 'done'
                              ? 'rgba(34, 197, 94, 0.12)'
                              : it.status === 'error'
                                ? 'rgba(239, 68, 68, 0.12)'
                                : it.status === 'running' || it.status === 'parsing'
                                  ? 'rgba(250, 204, 21, 0.12)'
                                  : 'rgba(255,255,255,0.06)',
                          border:
                            it.status === 'done'
                              ? '1px solid rgba(34, 197, 94, 0.28)'
                              : it.status === 'error'
                                ? '1px solid rgba(239, 68, 68, 0.28)'
                                : it.status === 'running' || it.status === 'parsing'
                                  ? '1px solid rgba(250, 204, 21, 0.24)'
                                  : '1px solid rgba(255,255,255,0.10)',
                          color:
                            it.status === 'done'
                              ? 'rgba(34, 197, 94, 0.95)'
                              : it.status === 'error'
                                ? 'rgba(239, 68, 68, 0.95)'
                                : it.status === 'running' || it.status === 'parsing'
                                  ? 'rgba(250, 204, 21, 0.95)'
                                  : 'var(--text-secondary)',
                        }}
                        title={it.errorMessage || ''}
                      >
                        {statusLabel}
                      </div>
                    </div>
                  </div>

                  {it.errorMessage ? (
                    <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.92)' }}>
                      {it.errorMessage}
                    </div>
                  ) : null}

                  {(showPlaceholder || canShow) ? (
                    <div
                      className="mt-2 rounded-[12px] overflow-hidden relative group"
                      style={{
                        height: 160,
                        background: 'rgba(0,0,0,0.18)',
                        border: '1px solid rgba(255,255,255,0.10)',
                        cursor: canShow ? 'pointer' : 'default',
                      }}
                      onClick={() => {
                        if (!canShow) return;
                        const allImages = markerRunItems
                          .filter(x => x.assetUrl || x.url || x.base64)
                          .map((x, i) => ({
                            url: x.assetUrl || x.url || (x.base64?.startsWith('data:') ? x.base64 : `data:image/png;base64,${x.base64}`) || '',
                            alt: `配图 ${i + 1}`,
                          }));
                        const currentIdx = allImages.findIndex((_, i) => {
                          const item = markerRunItems.filter(x => x.assetUrl || x.url || x.base64)[i];
                          return item?.markerIndex === it.markerIndex;
                        });
                        setImagePreviewIndex(currentIdx >= 0 ? currentIdx : 0);
                        setImagePreviewOpen(true);
                      }}
                    >
                      {showPlaceholder ? (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <PrdPetalBreathingLoader size={140} />
                        </div>
                      ) : null}
                      {canShow ? (
                        <>
                          <img src={src} alt={`img-${idx + 1}`} className="w-full h-full block" style={{ objectFit: 'contain' }} />

                          {/* Copy and Download icons */}
                          <div
                            className="absolute bottom-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              className="p-2 rounded-lg"
                              style={{
                                background: 'rgba(0, 0, 0, 0.6)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                backdropFilter: 'blur(10px)',
                              }}
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(src);
                                  await systemDialog.alert({ title: '已复制', message: '图片链接已复制到剪贴板' });
                                } catch (error) {
                                  console.error('Copy failed:', error);
                                }
                              }}
                              title="复制图片链接"
                            >
                              <Copy size={16} style={{ color: 'white' }} />
                            </button>
                            <button
                              className="p-2 rounded-lg"
                              style={{
                                background: 'rgba(0, 0, 0, 0.6)',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                backdropFilter: 'blur(10px)',
                              }}
                              onClick={async () => {
                                try {
                                  const link = document.createElement('a');
                                  link.href = src;
                                  link.download = `配图-${idx + 1}.png`;
                                  link.click();
                                } catch (error) {
                                  console.error('Download failed:', error);
                                }
                              }}
                              title="下载图片"
                            >
                              <DownloadCloud size={16} style={{ color: 'white' }} />
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  <textarea
                    value={it.draftText}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMarkerRunItems((prev) => prev.map((x) => (x.markerIndex === it.markerIndex ? { ...x, draftText: v } : x)));
                    }}
                    className="mt-2 w-full rounded-[12px] px-3 py-2 text-[12px] outline-none resize-none prd-field"
                    style={{ minHeight: 84 }}
                    placeholder="可编辑后右下角生成图片 / 重新生成"
                    disabled={it.status === 'running' || it.status === 'parsing'}
                  />

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={it.status === 'running' || it.status === 'parsing'}
                      onClick={() => void handleDeleteMarker(it.markerIndex)}
                      title="删除该配图提示词（同时移除文章中的对应 [插图] 标记）"
                    >
                      <Trash2 size={14} />
                      删除
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => locateMarkerInPreview(it.markerIndex)}
                      title="定位到正文中的配图标记位置"
                    >
                      <MapPin size={14} />
                      定位
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={it.status === 'running' || it.status === 'parsing' || !imageGenModel}
                      onClick={() => void handleRegenerateOne(it.markerIndex)}
                      title={genTitle}
                    >
                      <Sparkles size={14} />
                      {genLabel}
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>
            <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
              点击“一键生图”将按顺序逐条解析 JSON 并生成图片；也可在单条卡片内编辑后重生成
            </div>
          </Card>
        )}
      </div>

      {/* 新建提示词对话框 */}
      <Dialog
        open={!!creatingPrompt}
        onOpenChange={(open) => !open && handleCancelCreate()}
        title="新建提示词模板"
        description="输入模板名称和内容"
        maxWidth={1040}
        content={
          creatingPrompt ? (
            <div className="h-full min-h-0 flex flex-col">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    模板名称
                  </label>
                  <input
                    type="text"
                    value={creatingPrompt.title}
                    onChange={(e) => setCreatingPrompt({ ...creatingPrompt, title: e.target.value })}
                    placeholder="例如：产品介绍"
                    className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field"
                    autoFocus
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant={promptPanel === 'edit' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('edit')}
                      >
                        编辑
                      </Button>
                      <Button
                        size="xs"
                        variant={promptPanel === 'preview' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('preview')}
                      >
                        预览
                      </Button>
                    </div>
                  </div>

                  {/* 编辑模式：显示 textarea */}
                  {promptPanel === 'edit' && (
                    <textarea
                      value={creatingPrompt.content}
                      onChange={(e) => setCreatingPrompt({ ...creatingPrompt, content: e.target.value })}
                      placeholder="请输入提示词模板内容（所有文学创作 Agent 全局共享）..."
                      rows={14}
                      className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-5 outline-none resize-none font-mono select-text prd-field"
                    />
                  )}

                  {/* 预览模式：显示 markdown 只读 */}
                  {promptPanel === 'preview' && (
                    <div
                      className="rounded-[14px] px-3 py-2.5 overflow-auto"
                      style={{
                        background: 'rgba(0,0,0,0.28)',
                        border: '1px solid var(--border-subtle)',
                        maxHeight: '360px',
                      }}
                    >
                      <style>{`
                        .create-prompt-md { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
                        .create-prompt-md h1,.create-prompt-md h2,.create-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 12px 0 6px; }
                        .create-prompt-md h1 { font-size: 16px; }
                        .create-prompt-md h2 { font-size: 14px; }
                        .create-prompt-md h3 { font-size: 13px; }
                        .create-prompt-md p { margin: 6px 0; }
                        .create-prompt-md ul,.create-prompt-md ol { margin: 6px 0; padding-left: 18px; }
                        .create-prompt-md li { margin: 3px 0; }
                        .create-prompt-md code { font-family: ui-monospace, monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 4px; border-radius: 4px; }
                        .create-prompt-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; padding: 10px; overflow: auto; margin: 6px 0; }
                        .create-prompt-md pre code { background: transparent; border: 0; padding: 0; }
                      `}</style>
                      <div className="create-prompt-md">
                        {creatingPrompt.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {creatingPrompt.content}
                          </ReactMarkdown>
                        ) : (
                          <div style={{ color: 'var(--text-muted)' }}>（输入内容后显示预览）</div>
                        )}
                      </div>
                    </div>
                  )}
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
        maxWidth={1040}
        content={
          editingPrompt ? (
            <div className="h-full min-h-0 flex flex-col">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    模板标题
                  </label>
                  <input
                    type="text"
                    value={editingPrompt.title}
                    onChange={(e) => setEditingPrompt({ ...editingPrompt, title: e.target.value })}
                    placeholder="输入模板标题..."
                    className="w-full rounded-[14px] px-3 py-2.5 text-sm outline-none prd-field"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant={promptPanel === 'edit' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('edit')}
                      >
                        编辑
                      </Button>
                      <Button
                        size="xs"
                        variant={promptPanel === 'preview' ? 'primary' : 'secondary'}
                        onClick={() => setPromptPanel('preview')}
                      >
                        预览
                      </Button>
                    </div>
                  </div>

                  {/* 编辑模式：显示 textarea */}
                  {promptPanel === 'edit' && (
                    <textarea
                      value={editingPrompt.content}
                      onChange={(e) => setEditingPrompt({ ...editingPrompt, content: e.target.value })}
                      placeholder="输入模板内容..."
                      rows={14}
                      className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-5 outline-none resize-none font-mono select-text prd-field"
                    />
                  )}

                  {/* 预览模式：显示 markdown 只读 */}
                  {promptPanel === 'preview' && (
                    <div
                      className="rounded-[14px] px-3 py-2.5 overflow-auto"
                      style={{
                        background: 'rgba(0,0,0,0.28)',
                        border: '1px solid var(--border-subtle)',
                        maxHeight: '360px',
                      }}
                    >
                      <style>{`
                        .edit-prompt-md { font-size: 13px; line-height: 1.6; color: var(--text-secondary); }
                        .edit-prompt-md h1,.edit-prompt-md h2,.edit-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 12px 0 6px; }
                        .edit-prompt-md h1 { font-size: 16px; }
                        .edit-prompt-md h2 { font-size: 14px; }
                        .edit-prompt-md h3 { font-size: 13px; }
                        .edit-prompt-md p { margin: 6px 0; }
                        .edit-prompt-md ul,.edit-prompt-md ol { margin: 6px 0; padding-left: 18px; }
                        .edit-prompt-md li { margin: 3px 0; }
                        .edit-prompt-md code { font-family: ui-monospace, monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 4px; border-radius: 4px; }
                        .edit-prompt-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; padding: 10px; overflow: auto; margin: 6px 0; }
                        .edit-prompt-md pre code { background: transparent; border: 0; padding: 0; }
                      `}</style>
                      <div className="edit-prompt-md">
                        {editingPrompt.content ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {editingPrompt.content}
                          </ReactMarkdown>
                        ) : (
                          <div style={{ color: 'var(--text-muted)' }}>（输入内容后显示预览）</div>
                        )}
                      </div>
                    </div>
                  )}
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
            </div>
          ) : null
        }
      />

      {/* 系统提示词与水印配置对话框 */}
      <Dialog
        open={promptPreviewOpen}
        onOpenChange={setPromptPreviewOpen}
        title="配置管理"
        description="系统提示词与水印设置"
        maxWidth={1400}
        content={
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-2">
            {/* 左侧：系统提示词 */}
            <div className="min-h-0 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  系统提示词
                </div>
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => {
                    handleCreatePrompt();
                    setPromptPreviewOpen(false);
                  }}
                >
                  <Plus size={12} />
                  新建
                </Button>
              </div>
              {allPrompts.length === 0 ? (
                <div className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>
                  还没有提示词模板，点击上方「新建」创建第一个模板
                </div>
              ) : (
                <div className="max-h-[520px] overflow-auto pr-1">
                  <div className="grid grid-cols-1 gap-3">
                    {allPrompts.map((prompt) => (
                      <Card key={prompt.id} className="p-0 overflow-hidden">
                        <div className="group relative flex flex-col h-full">
                          {/* 上栏：标题区 */}
                          <div className="p-2 pb-1 flex-shrink-0">
                            <style>{`
                              .modal-prompt-marquee{position:relative;overflow:hidden;white-space:nowrap;min-width:0;width:100%}
                              .modal-prompt-marquee__track{display:flex;align-items:center;gap:16px;width:max-content;will-change:transform}
                              .modal-prompt-marquee__track--animate{animation:modal-prompt-scroll 12s linear infinite}
                              .modal-prompt-marquee__track--static{animation:none;width:100%}
                              .modal-prompt-marquee__item{display:inline-block;white-space:nowrap}
                              @keyframes modal-prompt-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
                              @media (prefers-reduced-motion: reduce){.modal-prompt-marquee__track--animate{animation:none}}
                            `}</style>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                <Sparkles size={14} style={{ color: 'rgba(147, 197, 253, 0.85)', flexShrink: 0 }} />
                                <div className="modal-prompt-marquee flex-1">
                                  <div className={`modal-prompt-marquee__track ${prompt.title.length > 20 ? 'modal-prompt-marquee__track--animate' : 'modal-prompt-marquee__track--static'}`}>
                                    <span className="modal-prompt-marquee__item font-semibold text-[13px]" style={{ color: 'var(--text-primary)' }}>
                                      {prompt.title}
                                    </span>
                                    {prompt.title.length > 20 && (
                                      <span className="modal-prompt-marquee__item font-semibold text-[13px]" style={{ color: 'var(--text-primary)' }}>
                                        {prompt.title}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex items-center gap-1 flex-shrink-0">
                                {/* 分类标签 */}
                                {(!prompt.scenarioType || prompt.scenarioType === 'global') ? (
                                  <span
                                    className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                                    style={{
                                      background: 'rgba(168, 85, 247, 0.12)',
                                      color: 'rgba(168, 85, 247, 0.95)',
                                      border: '1px solid rgba(168, 85, 247, 0.28)',
                                    }}
                                    title="全局共享（所有场景可用）"
                                  >
                                    全局
                                  </span>
                                ) : prompt.scenarioType === 'article-illustration' ? (
                                  <span
                                    className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                                    style={{
                                      background: 'rgba(34, 197, 94, 0.12)',
                                      color: 'rgba(34, 197, 94, 0.95)',
                                      border: '1px solid rgba(34, 197, 94, 0.28)',
                                    }}
                                    title="文章配图专用"
                                  >
                                    文章配图
                                  </span>
                                ) : null}

                                {/* 当前选中标签 */}
                                {selectedPrompt?.id === prompt.id && (
                                  <span
                                    className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                                    style={{
                                      background: 'var(--accent-primary)',
                                      color: 'white',
                                    }}
                                  >
                                    当前
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 中栏：内容预览区 */}
                          <div className="px-2 pb-1 flex-1 min-h-0 overflow-hidden">
                            <div
                              className="h-full overflow-auto border rounded-[6px]"
                              style={{
                                borderColor: 'var(--border-subtle)',
                                background: 'rgba(255,255,255,0.02)',
                                minHeight: '120px',
                                maxHeight: '160px',
                              }}
                            >
                              <style>{`
                                .modal-prompt-md { font-size: 11px; line-height: 1.5; color: var(--text-secondary); padding: 8px; }
                                .modal-prompt-md h1,.modal-prompt-md h2,.modal-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 8px 0 4px; }
                                .modal-prompt-md h1 { font-size: 13px; }
                                .modal-prompt-md h2 { font-size: 12px; }
                                .modal-prompt-md h3 { font-size: 11px; }
                                .modal-prompt-md p { margin: 4px 0; }
                                .modal-prompt-md ul,.modal-prompt-md ol { margin: 4px 0; padding-left: 16px; }
                                .modal-prompt-md li { margin: 2px 0; }
                                .modal-prompt-md code { font-family: ui-monospace, monospace; font-size: 10px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 4px; border-radius: 4px; }
                                .modal-prompt-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 6px; padding: 8px; overflow: auto; margin: 4px 0; }
                                .modal-prompt-md pre code { background: transparent; border: 0; padding: 0; }
                              `}</style>
                              <div className="modal-prompt-md">
                                {prompt.content ? (
                                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                    {prompt.content}
                                  </ReactMarkdown>
                                ) : (
                                  <div style={{ color: 'var(--text-muted)' }}>（内容为空）</div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* 下栏：操作按钮区 */}
                          <div className="px-2 pb-2 pt-1 flex-shrink-0">
                            <div className="flex gap-1.5 justify-end">
                              {selectedPrompt?.id !== prompt.id ? (
                                <Button
                                  size="xs"
                                  variant="primary"
                                  onClick={() => {
                                    setSelectedPrompt(prompt);
                                    setPromptPreviewOpen(false);
                                  }}
                                >
                                  <Check size={12} />
                                  选择
                                </Button>
                              ) : (
                                <Button
                                  size="xs"
                                  variant="secondary"
                                  disabled
                                >
                                  <Check size={12} />
                                  已选
                                </Button>
                              )}
                              <Button
                                size="xs"
                                variant="secondary"
                                onClick={() => {
                                  handleEditPrompt(prompt);
                                  setPromptPreviewOpen(false);
                                }}
                              >
                                <Edit2 size={12} />
                                编辑
                              </Button>
                              <Button
                                size="xs"
                                variant="danger"
                                onClick={() => {
                                  void handleDeletePrompt(prompt);
                                }}
                              >
                                <Trash2 size={12} />
                                删除
                              </Button>
                            </div>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 右侧：水印设置 */}
            <div className="min-h-0 flex flex-col border-l pl-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                水印设置
              </div>
              <div className="flex-1 min-h-0 overflow-auto">
                <WatermarkSettingsPanel onStatusChange={setWatermarkEnabled} />
              </div>
            </div>
          </div>
        }
      />

      {/* Image Preview Dialog */}
      <ImagePreviewDialog
        images={markerRunItems
          .filter(x => x.assetUrl || x.url || x.base64)
          .map((x, i) => ({
            url: x.assetUrl || x.url || (x.base64?.startsWith('data:') ? x.base64 : `data:image/png;base64,${x.base64}`) || '',
            alt: `配图 ${i + 1}`,
          }))}
        initialIndex={imagePreviewIndex}
        open={imagePreviewOpen}
        onClose={() => setImagePreviewOpen(false)}
      />
    </div>
  );
}
