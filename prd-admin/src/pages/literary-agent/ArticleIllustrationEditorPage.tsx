import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  createImageGenRun,
  exportArticle,
  generateArticleMarkers,
  getImageMasterWorkspaceDetail,
  getModels,
  planImageGen,
  streamImageGenRunWithRetry,
  updateImageMasterWorkspace,
  uploadImageMasterWorkspaceAsset,
} from '@/services';
import { Wand2, Download, Sparkles, FileText, Plus, Trash2, Edit2, Upload, Eye, Check } from 'lucide-react';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { extractMarkers, type ArticleMarker } from '@/lib/articleMarkerExtractor';
import { useDebounce } from '@/hooks/useDebounce';
import { systemDialog } from '@/lib/systemDialog';
import type { Model } from '@/types/admin';
import type { ImageGenPlanItem } from '@/services/contracts/imageGen';

type WorkflowPhase = 'upload' | 'editing' | 'markers-generating' | 'markers-generated' | 'images-generating' | 'images-generated';

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
  const [articleWithImages, setArticleWithImages] = useState('');
  const [phase, setPhase] = useState<WorkflowPhase>('upload');
  const [serverPhase, setServerPhase] = useState<WorkflowPhase>('upload'); // 服务端真实进度（用于判断按钮置灰）
  const [generating, setGenerating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false);
  
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

  const genAbortRef = useRef<AbortController | null>(null);
  
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
          setServerPhase(workflowPhase as WorkflowPhase); // 更新服务端真实进度
        } else {
          // 兼容旧数据：无 workflow 时按原逻辑推导
          if (ws.articleContentWithMarkers) {
            const extracted = extractMarkers(ws.articleContentWithMarkers);
            setMarkers(extracted);
            if (extracted.length > 0) {
              setPhase('markers-generated');
              setServerPhase('markers-generated');
            }
          } else if (content) {
            setUploadedFileName('已上传的文章.md');
            setPhase('editing');
            setServerPhase('editing');
          }
        }
        
        // 如果有生成的内容，提取标记（用于右侧列表）
        if (ws.articleContentWithMarkers) {
          const extracted = extractMarkers(ws.articleContentWithMarkers);
          setMarkers(extracted);
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

  // markers 变化时：初始化/对齐右侧运行状态列表（保持用户已编辑内容）
  useEffect(() => {
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
  }, [markers]);

  // 保存用户提示词到 localStorage（全局共享，不按 workspaceId 隔离）
  const saveUserPrompts = useCallback((prompts: PromptTemplate[]) => {
    localStorage.setItem('literary-prompts-global', JSON.stringify(prompts));
    setUserPrompts(prompts);
  }, []);

  useEffect(() => {
    if (debouncedArticleContent && workspaceId && phase === 'editing' && !generating) {
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
      setPhase('editing');
      setServerPhase('editing'); // 更新服务端真实进度
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
      setPhase('editing');
      setServerPhase('editing');
    } catch {
      await systemDialog.alert('文件读取失败');
    }
  }, [workspaceId]);

  // 进入预览阶段（保留 phase=editing，表示“已上传可生成标记”）
  const handleEnterPreview = useCallback(() => {
    setPhase('editing');
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
    setPhase('markers-generating');
    setArticleWithMarkers(articleContent); // 初始：从原文开始（流式会逐步变成带标记版本）
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
          // 流式输出到“带标记预览”，避免覆盖原文
          setArticleWithMarkers(fullText);
        } else if (chunk.type === 'done' && chunk.fullText) {
          fullText = chunk.fullText;
          setArticleWithMarkers(fullText);
          
          // 提取标记
          const extracted = extractMarkers(fullText);
          setMarkers(extracted);
          
          // 提交型操作成功：更新服务端真实进度
          setPhase('markers-generated');
          setServerPhase('markers-generated');
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
      setPhase('editing');
    } finally {
      setGenerating(false);
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

        if (url) {
          changed = true;
          patches.push({
            start: m.startPos,
            end: m.endPos,
            replacement: `![配图 ${i + 1}](${url})`,
          });
          continue;
        }

        // “立刻插入”：无图时点击生成后，生成中也会在对应 marker 行下方插入占位提示
        const isGenerating = it.status === 'parsing' || it.status === 'parsed' || it.status === 'running';
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

  // markerRunItems 状态变化时：立即刷新左侧预览（支持“单条先生成”不乱序）
  useEffect(() => {
    if (phase === 'markers-generated' || phase === 'images-generating' || phase === 'images-generated') {
      rebuildMergedMarkdown(markerRunItems);
    }
  }, [markerRunItems, phase, rebuildMergedMarkdown]);

  const runSingleMarker = async (markerIndex: number) => {
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

    // 1) 逐条解析 JSON（实验室同款：planImageGen），maxItems=1
    setMarkerRunItems((prev) =>
      prev.map((x) =>
        x.markerIndex === markerIndex
          ? { ...x, status: 'parsing', errorMessage: null, planItem: null, runId: null }
          : x
      )
    );
    const planRes = await planImageGen({ text, maxItems: 1 });
    if (!planRes.success) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: planRes.error?.message || '解析失败' } : x))
      );
      return;
    }
    const first = (planRes.data?.items ?? [])[0] ?? null;
    if (!first || !String(first.prompt || '').trim()) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: '解析失败：未返回有效 JSON' } : x))
      );
      return;
    }
    const plannedPrompt = String(first.prompt || '').trim();
    const plannedSize = String(first.size || '').trim() || parseSizeFromText(plannedPrompt) || parseSizeFromText(text) || '1024x1024';

    setMarkerRunItems((prev) =>
      prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'parsed', planItem: first } : x))
    );

    // 2) 创建 run（实验室同款 createRun + SSE）
    setMarkerRunItems((prev) => prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'running' } : x)));
    const idem = `article_img_${workspaceId}_${markerIndex}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const created = await createImageGenRun({
      input: {
        configModelId: imageGenModel.id,
        items: [{ prompt: plannedPrompt, count: 1, size: plannedSize }],
        size: plannedSize,
        responseFormat: 'b64_json',
        maxConcurrency: 1,
      },
      idempotencyKey: idem,
    });
    if (!created.success) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: created.error?.message || '生图失败' } : x))
      );
      return;
    }
    const runId = String(created.data?.runId || '').trim();
    if (!runId) {
      setMarkerRunItems((prev) =>
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'error', errorMessage: '生图失败：未返回 runId' } : x))
      );
      return;
    }
    setMarkerRunItems((prev) => prev.map((x) => (x.markerIndex === markerIndex ? { ...x, runId } : x)));

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
        prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'done', assetUrl: finalUrl } : x))
      );
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
      prev.map((x) => (x.markerIndex === markerIndex ? { ...x, status: 'done', assetUrl } : x))
    );
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
    setPhase('images-generating');
    setArticleWithImages('');

    let anyError = false;
    try {
      // 按 marker 顺序逐条：parse JSON -> createRun+SSE -> assetUrl
      const ordered = [...markerRunItemsRef.current].sort((a, b) => a.markerIndex - b.markerIndex);
      for (const it of ordered) {
        if (ac.signal.aborted) break;
        await runSingleMarker(it.markerIndex);
        const after = markerRunItemsRef.current.find((x) => x.markerIndex === it.markerIndex);
        if (after?.status === 'error') anyError = true;
        // 每条完成后：替换前缀已完成的 marker 行，写入左侧预览
        rebuildMergedMarkdown(markerRunItemsRef.current);
      }
    } finally {
      setGenerating(false);
      // 全部 done 才进入导出，否则回到配图标记阶段以便重试失败项
      const allDone = markerRunItemsRef.current.length > 0 && markerRunItemsRef.current.every((x) => x.status === 'done');
      setPhase(allDone ? 'images-generated' : 'markers-generated');
      if (anyError && !ac.signal.aborted) {
        await systemDialog.alert('部分配图生成失败：可在右侧逐条修改并重新生成');
      }
    }
  };

  const handleRegenerateOne = async (markerIndex: number) => {
    if (generating) return;
    setGenerating(true);
    setPhase('images-generating');
    try {
      await runSingleMarker(markerIndex);
    } finally {
      setGenerating(false);
      const allDone = markerRunItemsRef.current.length > 0 && markerRunItemsRef.current.every((x) => x.status === 'done');
      setPhase(allDone ? 'images-generated' : 'markers-generated');
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
    if (generating) return;
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
      setPhase('editing');
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
      label: '生成配图标记中...',
      action: async () => {},
      icon: Wand2,
      disabled: true,
      show: phase === 'markers-generating',
    },
    {
      label: '一键生图',
      action: handleBatchGenerate,
      icon: Sparkles,
      disabled: !imageGenModel || markerRunItems.length === 0,
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

  // 左侧统一作为“预览面板”：上传时渲染原文；AI 流式生成时直接渲染带标记版本
  const leftPreviewMarkdown =
    phase === 'markers-generating' || phase === 'markers-generated' || phase === 'images-generating' || phase === 'images-generated'
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
    { key: 'upload', label: '上传' },
    { key: 'editing', label: '预览' },
    { key: 'markers-generated', label: '配图标记' },
    { key: 'images-generating', label: '生图中' },
    { key: 'images-generated', label: '导出' },
  ];

  const jumpToPhase = async (target: WorkflowPhase) => {
    if (target === phase) return;
    if (generating) return;

    // 刷新 workspace detail，以服务端 workflow 为准判断是否可跳转
    const res = await getImageMasterWorkspaceDetail({ id: workspaceId });
    if (!res.success || !res.data?.workspace) {
      await systemDialog.alert('获取工作空间状态失败');
      return;
    }
    const ws = res.data.workspace;
    const latestServerPhase = ws.articleWorkflow?.phase || 'upload';
    
    // 更新服务端真实进度
    setServerPhase(latestServerPhase as WorkflowPhase);

    // 定义阶段顺序（用于判断"未来阶段"）
    const phaseOrder: Record<WorkflowPhase, number> = {
      'upload': 0,
      'editing': 1,
      'markers-generating': 2,
      'markers-generated': 2,
      'images-generating': 3,
      'images-generated': 4
    };

    const targetOrder = phaseOrder[target];
    const serverOrder = phaseOrder[latestServerPhase as WorkflowPhase];

    // 禁止跳到未生成过的未来阶段（这个判断应该在按钮渲染时就置灰，这里只是兜底）
    if (targetOrder > serverOrder) {
      // 理论上不应该走到这里（按钮应该已经置灰），但作为兜底保护
      return;
    }

    // 允许跳转到任何"已生成过"的阶段（<= serverOrder）
    // 只更新 UI 展示状态，不触发任何后端写入
    setPhase(target);
    setArticleContent(ws.articleContent || '');
    setArticleWithMarkers(ws.articleContentWithMarkers || '');
    if (ws.articleContentWithMarkers) {
      const extracted = extractMarkers(ws.articleContentWithMarkers);
      setMarkers(extracted);
    }
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
              {phase === 'upload' && uploadedFileName && (
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
                    <Button variant="primary" onClick={handleEnterPreview}>
                      <Edit2 size={16} />
                      进入预览
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 预览阶段：渲染原文（不提供手动编辑入口） */}
            {phase === 'editing' && (
              <div className="p-4 relative">
                {!isDragging && (
                  <div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded font-semibold" style={{ background: 'rgba(147, 197, 253, 0.1)', color: 'rgba(147, 197, 253, 0.7)', border: '1px solid rgba(147, 197, 253, 0.2)' }}>
                    正文
                  </div>
                )}
                <div className="prd-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
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

            {/* 标记生成中/完成/生图等阶段：正文始终展示"原文"，预览单独展示"带标记版本" */}
            {phase !== 'editing' && phase !== 'upload' && (
              <div className="p-4 relative">
                {!isDragging && (
                  <div className="absolute top-2 left-2 text-[10px] px-2 py-1 rounded font-semibold" style={{ background: 'rgba(147, 197, 253, 0.1)', color: 'rgba(147, 197, 253, 0.7)', border: '1px solid rgba(147, 197, 253, 0.2)' }}>
                    正文
                  </div>
                )}
                <div className="prd-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
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
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {phaseSteps.map((s) => {
              const active = s.key === phase;
              
              // 判断是否是"未来阶段"（服务端还未到达的阶段）
              const phaseOrder: Record<WorkflowPhase, number> = {
                'upload': 0,
                'editing': 1,
                'markers-generating': 2,
                'markers-generated': 2,
                'images-generating': 3,
                'images-generated': 4
              };
              const targetOrder = phaseOrder[s.key];
              const serverOrder = phaseOrder[serverPhase];
              const isFuture = targetOrder > serverOrder;
              const disabled = generating || isFuture;
              
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => void jumpToPhase(s.key)}
                  className="px-3 py-1.5 rounded-full text-[12px] font-semibold transition-colors"
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent-gold) 18%, rgba(255,255,255,0.03))' : 'rgba(255,255,255,0.03)',
                    border: active ? '1px solid color-mix(in srgb, var(--accent-gold) 42%, rgba(255,255,255,0.10))' : '1px solid rgba(255,255,255,0.10)',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    opacity: disabled ? 0.4 : 1,
                    pointerEvents: disabled ? 'none' : 'auto',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                  title={active ? '当前阶段' : isFuture ? '该阶段尚未生成' : `跳转到：${s.label}`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
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
        {(phase === 'markers-generated' || phase === 'images-generating' || phase === 'images-generated') && (
          <Card className="flex-1 min-h-0 flex flex-col">
            <div className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              配图标记列表 ({markerRunItems.length})
            </div>
            {imageGenModel ? (
              <div className="mb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                生图模型：{imageGenModel.modelName}（platformId={imageGenModel.platformId}）
              </div>
            ) : imageGenModelError ? (
              <div className="mb-3 text-xs" style={{ color: 'rgba(239,68,68,0.92)' }}>
                生图模型不可用：{imageGenModelError}
              </div>
            ) : null}

            <div className="flex-1 min-h-0 overflow-auto space-y-2">
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
                const canShow = Boolean(src) && (it.status === 'done' || it.status === 'running');
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

                  {it.errorMessage ? (
                    <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.92)' }}>
                      {it.errorMessage}
                    </div>
                  ) : null}

                  {canShow ? (
                    <div
                      className="mt-2 rounded-[12px] overflow-hidden"
                      style={{ height: 160, background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.10)' }}
                    >
                      <img src={src} alt={`img-${idx + 1}`} className="w-full h-full block" style={{ objectFit: 'contain' }} />
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
                    disabled={generating}
                  />

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={generating}
                      onClick={() => void handleDeleteMarker(it.markerIndex)}
                      title="删除该配图提示词（同时移除文章中的对应 [插图] 标记）"
                    >
                      <Trash2 size={14} />
                      删除
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={generating || !imageGenModel}
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
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    模板内容
                  </label>
                  <textarea
                    value={creatingPrompt.content}
                    onChange={(e) => setCreatingPrompt({ ...creatingPrompt, content: e.target.value })}
                    placeholder="请输入提示词模板内容（所有文学创作 Agent 全局共享）..."
                    rows={12}
                    className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-5 outline-none resize-none font-mono select-text prd-field"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    预览
                  </label>
                  <div
                    className="rounded-[14px] px-3 py-2.5 overflow-auto"
                    style={{
                      background: 'rgba(0,0,0,0.28)',
                      border: '1px solid var(--border-subtle)',
                      maxHeight: '300px',
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
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    模板内容
                  </label>
                  <textarea
                    value={editingPrompt.content}
                    onChange={(e) => setEditingPrompt({ ...editingPrompt, content: e.target.value })}
                    placeholder="输入模板内容..."
                    rows={12}
                    className="w-full rounded-[14px] px-3 py-2.5 text-[13px] leading-5 outline-none resize-none font-mono select-text prd-field"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-2 block" style={{ color: 'var(--text-primary)' }}>
                    预览
                  </label>
                  <div
                    className="rounded-[14px] px-3 py-2.5 overflow-auto"
                    style={{
                      background: 'rgba(0,0,0,0.28)',
                      border: '1px solid var(--border-subtle)',
                      maxHeight: '300px',
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

      {/* 系统提示词查看对话框 */}
      <Dialog
        open={promptPreviewOpen}
        onOpenChange={setPromptPreviewOpen}
        title="系统提示词"
        description="查看所有提示词模板"
        maxWidth={1200}
        content={
          <div className="p-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                            
                            {selectedPrompt?.id === prompt.id && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
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
        }
      />
    </div>
  );
}
