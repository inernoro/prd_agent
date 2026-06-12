import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, FileText, Image, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { importRequirements, type ImportRequirementRow } from '@/services/real/productAgent';
import { parseRequirementRtfBytes, replaceImportImageMarkers, type RtfImportRequirement } from './requirementRtfImport';
import { REQUIREMENT_SOURCE_RTF } from './requirementSource';

interface ParsedFile {
  file: File;
  requirement?: RtfImportRequirement;
  error?: string;
}

export function RequirementRtfImportDialog({
  productId,
  files,
  onClose,
  onImported,
}: {
  productId: string;
  files: File[];
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [parsing, setParsing] = useState(true);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null);
  const validFiles = useMemo(() => parsedFiles.filter((item) => item.requirement), [parsedFiles]);

  useEffect(() => {
    let active = true;
    void Promise.all(files.map(async (file): Promise<ParsedFile> => {
      try {
        return { file, requirement: parseRequirementRtfBytes(await file.arrayBuffer(), file.name) };
      } catch (error) {
        return { file, error: error instanceof Error ? error.message : 'RTF 解析失败' };
      }
    })).then((items) => {
      if (!active) return;
      setParsedFiles(items);
      setParsing(false);
    });
    return () => {
      active = false;
    };
  }, [files]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !importing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onClose]);

  const runImport = async () => {
    setImporting(true);
    setResult(null);
    const batchId = crypto.randomUUID();
    const rows: ImportRequirementRow[] = [];

    for (let fileIndex = 0; fileIndex < validFiles.length; fileIndex += 1) {
      const item = validFiles[fileIndex];
      const requirement = item.requirement!;
      const uploadedImages: { index: number; url: string; fileName: string }[] = [];
      const attachmentIds: string[] = [];
      for (let imageIndex = 0; imageIndex < requirement.images.length; imageIndex += 1) {
        setProgress(`正在上传第 ${fileIndex + 1}/${validFiles.length} 条需求的图片 ${imageIndex + 1}/${requirement.images.length}`);
        const image = requirement.images[imageIndex];
        const imageFile = new File([image.bytes.slice().buffer], image.fileName, { type: image.mimeType });
        const uploaded = await uploadAttachment(imageFile);
        if (!uploaded.success || !uploaded.data) {
          setProgress(`图片上传失败：${uploaded.error?.message ?? image.fileName}`);
          setImporting(false);
          return;
        }
        uploadedImages.push({ index: imageIndex, url: uploaded.data.url, fileName: uploaded.data.fileName });
        attachmentIds.push(uploaded.data.attachmentId);
      }
      rows.push({
        title: requirement.title,
        grade: requirement.grade,
        description: replaceImportImageMarkers(requirement.description, uploadedImages),
        sourceSystem: REQUIREMENT_SOURCE_RTF,
        externalId: requirement.externalId,
        sourceStatus: requirement.sourceStatus,
        sourcePriority: requirement.sourcePriority,
        sourceFields: requirement.fields,
        handlerNames: requirement.handlerNames,
        developerNames: requirement.developerNames,
        creatorNames: requirement.creatorNames,
        ccNames: requirement.ccNames,
        comments: requirement.comments,
        attachmentIds,
        sourceCreatedAt: requirement.sourceCreatedAt,
        sourceModifiedAt: requirement.sourceModifiedAt,
        sourceCompletedAt: requirement.sourceCompletedAt,
        importedFileName: item.file.name,
        importBatchId: batchId,
      });
    }

    setProgress(`正在写入 ${rows.length} 条需求`);
    const imported = await importRequirements(productId, rows);
    setImporting(false);
    if (!imported.success) {
      setProgress(imported.error?.message ?? '导入失败');
      return;
    }
    setResult({ created: imported.data.created, updated: imported.data.updated ?? 0 });
    setProgress('');
    await onImported();
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4">
      <div
        className="w-full max-w-4xl rounded-xl border border-white/15 bg-[#111319] shadow-2xl flex flex-col"
        style={{ maxHeight: 'min(820px, calc(100vh - 32px))' }}
      >
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10">
          <div>
            <div className="text-base font-semibold text-white">导入 RTF 需求</div>
            <div className="text-xs text-white/45 mt-1">先预览字段与图片，再批量写入；相同需求 ID 会更新原记录。</div>
          </div>
          <button onClick={onClose} disabled={importing} className="p-1.5 rounded-lg text-white/45 hover:text-white hover:bg-white/10 disabled:opacity-40" title="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          {parsing ? (
            <div className="py-16 flex items-center justify-center gap-2 text-sm text-white/55">
              <MapSpinner size={16} /> 正在解析 {files.length} 个 RTF 文件
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {parsedFiles.map((item) => (
                <div key={`${item.file.name}-${item.file.lastModified}`} className="rounded-lg border border-white/10 bg-white/[0.025] p-3.5">
                  {item.error ? (
                    <div className="flex items-start gap-2 text-sm text-red-200">
                      <AlertCircle size={16} className="mt-0.5 shrink-0" />
                      <div><div className="font-medium">{item.file.name}</div><div className="text-xs text-red-200/65 mt-1">{item.error}</div></div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-300 shrink-0">
                        <FileText size={17} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-white truncate">{item.requirement!.title}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-white/50">
                          <span>需求 ID：{item.requirement!.externalId}</span>
                          <span>状态：{item.requirement!.sourceStatus || '空'}</span>
                          <span>优先级：{item.requirement!.sourcePriority || '空'}</span>
                          <span>字段：{Object.keys(item.requirement!.fields).length}</span>
                          <span className="flex items-center gap-1"><Image size={12} /> 图片：{item.requirement!.images.length}</span>
                          <span>评论：{item.requirement!.comments.length}</span>
                        </div>
                        <div className="text-[11px] text-white/30 mt-2 truncate">{item.file.name}</div>
                      </div>
                      <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 px-5 py-4 border-t border-white/10">
          {progress && <div className="mb-3 text-xs text-cyan-200/80">{progress}</div>}
          {result && (
            <div className="mb-3 text-xs text-emerald-200">
              导入完成：新增 {result.created} 条，更新 {result.updated} 条。
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-white/40">有效 {validFiles.length} 个，失败 {parsedFiles.length - validFiles.length} 个</div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} disabled={importing} className="px-3.5 py-2 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-40">
                {result ? '完成' : '取消'}
              </button>
              {!result && (
                <button
                  onClick={() => void runImport()}
                  disabled={parsing || importing || validFiles.length === 0}
                  className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/35 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40 flex items-center gap-1.5"
                >
                  {importing ? <MapSpinner size={14} /> : <Upload size={14} />}
                  导入 {validFiles.length} 条需求
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
