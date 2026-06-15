import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, FileText, Image, Upload, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { importOverviewRequirements, importRequirements, type ImportRequirementRow } from '@/services/real/productAgent';
import {
  normalizeRtfImage,
  parseRequirementRtfBytes,
  replaceImportImageMarkers,
  rtfImageToUploadFile,
  stripFailedImageMarkers,
  type RtfImportImage,
  type RtfImportRequirement,
} from './requirementRtfImport';
import { REQUIREMENT_SOURCE_RTF } from './requirementSource';

interface ParsedRequirementItem {
  file: File;
  requirement: RtfImportRequirement;
  indexInFile: number;
  totalInFile: number;
}

interface ParsedFile {
  file: File;
  requirements: ParsedRequirementItem[];
  error?: string;
}

export function RequirementRtfImportDialog({
  productId,
  files,
  onClose,
  onImported,
  crossProductRoute = false,
}: {
  productId: string;
  files: File[];
  onClose: () => void;
  onImported: () => Promise<void>;
  crossProductRoute?: boolean;
}) {
  const [parsedFiles, setParsedFiles] = useState<ParsedFile[]>([]);
  const [parsing, setParsing] = useState(true);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState<{ created: number; updated: number; skippedImages: number } | null>(null);
  const [imageWarnings, setImageWarnings] = useState<string[]>([]);

  const validItems = useMemo(
    () => parsedFiles.flatMap((item) => item.requirements),
    [parsedFiles],
  );
  const totalRequirementCount = validItems.length;

  useEffect(() => {
    let active = true;
    void Promise.all(files.map(async (file): Promise<ParsedFile> => {
      try {
        const requirements = parseRequirementRtfBytes(await file.arrayBuffer(), file.name);
        return {
          file,
          requirements: requirements.map((requirement, indexInFile) => ({
            file,
            requirement,
            indexInFile,
            totalInFile: requirements.length,
          })),
        };
      } catch (error) {
        return { file, requirements: [], error: error instanceof Error ? error.message : 'RTF 解析失败' };
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

  const formatUploadError = (fileName: string, uploaded: Awaited<ReturnType<typeof uploadAttachment>>) => {
    const detail = uploaded.error?.message ?? uploaded.error?.code;
    return detail ? `${fileName}：${detail}` : `${fileName}：上传失败`;
  };

  const runImport = async () => {
    setImporting(true);
    setResult(null);
    setImageWarnings([]);
    const batchId = crypto.randomUUID();
    const rows: ImportRequirementRow[] = [];
    const uploadedByRef = new Map<number, { index: number; url: string; fileName: string; attachmentId: string }>();
    const failedRefIndices = new Set<number>();
    const warningMessages: string[] = [];
    let skippedImageCount = 0;

    const ensureImageUploaded = async (image: RtfImportImage, progressLabel: string): Promise<boolean> => {
      if (uploadedByRef.has(image.refIndex)) return true;
      if (failedRefIndices.has(image.refIndex)) return false;

      const normalized = normalizeRtfImage(image);
      if (!normalized) {
        failedRefIndices.add(image.refIndex);
        skippedImageCount += 1;
        warningMessages.push(`${image.fileName}：无效或超限图片，已跳过`);
        return false;
      }

      setProgress(progressLabel);
      let uploaded = await uploadAttachment(rtfImageToUploadFile(normalized));
      if (!uploaded.success || !uploaded.data) {
        await new Promise((resolve) => { setTimeout(resolve, 600); });
        uploaded = await uploadAttachment(rtfImageToUploadFile(normalized));
      }
      if (!uploaded.success || !uploaded.data) {
        failedRefIndices.add(image.refIndex);
        skippedImageCount += 1;
        warningMessages.push(formatUploadError(normalized.fileName, uploaded));
        return false;
      }

      uploadedByRef.set(image.refIndex, {
        index: normalized.refIndex,
        url: uploaded.data.url,
        fileName: uploaded.data.fileName,
        attachmentId: uploaded.data.attachmentId,
      });
      return true;
    };

    for (let itemIndex = 0; itemIndex < validItems.length; itemIndex += 1) {
      const item = validItems[itemIndex];
      const requirement = item.requirement;
      const uploadedImages: { index: number; url: string; fileName: string }[] = [];
      const attachmentIds: string[] = [];
      const fileHint = item.totalInFile > 1
        ? `${item.file.name}（${item.indexInFile + 1}/${item.totalInFile}）`
        : item.file.name;

      for (let imageIndex = 0; imageIndex < requirement.images.length; imageIndex += 1) {
        const image = requirement.images[imageIndex];
        const ok = await ensureImageUploaded(
          image,
          `正在上传 ${fileHint} 第 ${itemIndex + 1}/${validItems.length} 条需求的图片 ${imageIndex + 1}/${requirement.images.length}`,
        );
        if (!ok) continue;
        const cached = uploadedByRef.get(image.refIndex);
        if (!cached) continue;
        uploadedImages.push({ index: cached.index, url: cached.url, fileName: cached.fileName });
        attachmentIds.push(cached.attachmentId);
      }

      const failedForRequirement = requirement.images
        .map((image) => image.refIndex)
        .filter((refIndex) => failedRefIndices.has(refIndex));
      rows.push({
        title: requirement.title,
        grade: requirement.grade,
        description: stripFailedImageMarkers(
          replaceImportImageMarkers(requirement.description, uploadedImages),
          failedForRequirement,
        ),
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
    const imported = crossProductRoute
      ? await importOverviewRequirements(rows)
      : await importRequirements(productId, rows);
    setImporting(false);
    if (!imported.success) {
      setProgress(imported.error?.message ?? '导入失败');
      if (warningMessages.length > 0) setImageWarnings(warningMessages.slice(0, 8));
      return;
    }
    setResult({
      created: imported.data.created,
      updated: imported.data.updated ?? 0,
      skippedImages: skippedImageCount,
    });
    setImageWarnings(warningMessages.slice(0, 8));
    setProgress(skippedImageCount > 0 ? `导入完成，${skippedImageCount} 张图片未上传（需求正文已去除对应占位）` : '');
    await onImported();
    onClose();
  };

  const failedFileCount = parsedFiles.filter((item) => item.error).length;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4">
      <div
        className="w-full max-w-4xl rounded-xl border border-white/15 bg-[#111319] shadow-2xl flex flex-col"
        style={{ maxHeight: 'min(820px, calc(100vh - 32px))' }}
      >
        <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10">
          <div>
            <div className="text-base font-semibold text-white">导入 RTF 需求</div>
            <div className="text-xs text-white/45 mt-1">支持 TAPD 单文件批量导出：一个 RTF 可解析为多条需求；相同需求 ID 会更新原记录。</div>
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
                    <div className="flex flex-col gap-2.5">
                      <div className="text-[11px] text-white/40 font-mono truncate">
                        {item.file.name}
                        {item.requirements.length > 1 && (
                          <span className="ml-2 text-cyan-300/80">共 {item.requirements.length} 条需求</span>
                        )}
                      </div>
                      {item.requirements.map((reqItem) => (
                        <div key={`${reqItem.requirement.externalId}-${reqItem.indexInFile}`} className="flex items-start gap-3 pl-1">
                          <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-300 shrink-0">
                            <FileText size={17} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-white truncate">{reqItem.requirement.title}</div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-white/50">
                              <span>ID：{reqItem.requirement.externalId}</span>
                              <span>状态：{reqItem.requirement.sourceStatus || '空'}</span>
                              <span>优先级：{reqItem.requirement.sourcePriority || '空'}</span>
                              <span>字段：{Object.keys(reqItem.requirement.fields).length}</span>
                              <span className="flex items-center gap-1"><Image size={12} /> 图片：{reqItem.requirement.images.length}</span>
                              <span>评论：{reqItem.requirement.comments.length}</span>
                            </div>
                          </div>
                          <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                        </div>
                      ))}
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
              导入完成：新增 {result.created} 条，更新 {result.updated} 条
              {result.skippedImages > 0 ? `，跳过 ${result.skippedImages} 张图片` : ''}。
            </div>
          )}
          {imageWarnings.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
              <div className="font-medium text-amber-100 mb-1">部分图片未上传（需求已继续导入）</div>
              <ul className="list-disc pl-4 space-y-0.5 text-amber-100/75">
                {imageWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-white/40">
              {files.length} 个文件，识别 {totalRequirementCount} 条需求
              {failedFileCount > 0 ? `，失败 ${failedFileCount} 个文件` : ''}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={onClose} disabled={importing} className="px-3.5 py-2 rounded-lg border border-white/10 text-sm text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-40">
                {result ? '完成' : '取消'}
              </button>
              {!result && (
                <button
                  onClick={() => void runImport()}
                  disabled={parsing || importing || totalRequirementCount === 0}
                  className="px-4 py-2 rounded-lg bg-cyan-500/20 border border-cyan-500/35 text-sm text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40 flex items-center gap-1.5"
                >
                  {importing ? <MapSpinner size={14} /> : <Upload size={14} />}
                  导入 {totalRequirementCount} 条需求
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
