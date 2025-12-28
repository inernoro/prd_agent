import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { Tooltip } from '@/components/ui/Tooltip';
import { exportConfig, importConfig, previewImportConfig } from '@/services';
import type { DataConfigImportOptions, ExportedConfig } from '@/services/contracts/data';
import type { DataConfigImportPreviewResponse } from '@/services/contracts/data';
import { Check, Copy, Download, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { systemDialog } from '@/lib/systemDialog';

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: '内容为空' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'JSON 解析失败' };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

function validateExportedConfig(x: unknown): { ok: true; data: ExportedConfig } | { ok: false; error: string } {
  if (!isRecord(x)) return { ok: false, error: '根节点必须是 JSON 对象' };
  const ver = x.version;
  if (ver !== 1 && ver !== 2) return { ok: false, error: '不支持的配置版本（仅支持 version=1/2）' };
  const platforms = x.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0) return { ok: false, error: 'platforms 为空' };

  for (const p of platforms) {
    if (!isRecord(p)) return { ok: false, error: 'platforms[] 必须是对象数组' };
    if (ver === 2) {
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      if (!id) return { ok: false, error: 'version=2 要求 platforms[].id 不能为空' };
    }
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const apiUrl = typeof p.apiUrl === 'string' ? p.apiUrl.trim() : '';
    const platformType = typeof p.platformType === 'string' ? p.platformType.trim() : '';
    const apiKey = typeof p.apiKey === 'string' ? p.apiKey : '';
    const enabledModels = p.enabledModels;
    if (!name) return { ok: false, error: 'platforms[].name 不能为空' };
    if (!platformType) return { ok: false, error: `平台 ${name} 缺少 platformType` };
    if (!apiUrl) return { ok: false, error: `平台 ${name} 缺少 apiUrl` };
    if (!Array.isArray(enabledModels)) return { ok: false, error: `平台 ${name} 缺少 enabledModels 数组` };
    // apiKey 可以为空（允许目标环境手动补填），但本需求默认导出含明文密钥，所以这里不强制
    void apiKey;
  }

  return { ok: true, data: x as ExportedConfig };
}

function downloadTextFile(filename: string, content: string, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatJson(x: unknown) {
  return JSON.stringify(x, null, 2);
}

function buildImportConfirmMessage(p: DataConfigImportPreviewResponse) {
  const lines: string[] = [];
  lines.push(`将导入：platforms=${p.importedPlatformCount}，enabledModels(total)=${p.importedEnabledModelCount}`);
  lines.push(`覆盖同名平台：${p.forceOverwriteSameName ? '是' : '否'}`);
  lines.push(`删除未导入：${p.deleteNotImported ? '是' : '否'}`);

  if (p.urlConflicts?.length) {
    lines.push('');
    lines.push(`同名平台 URL 不同（需要确认，最多展示 20 条；共 ${p.urlConflicts.length} 条）：`);
    p.urlConflicts.slice(0, 20).forEach((x) => {
      lines.push(`- ${x.name}: ${x.currentApiUrl} -> ${x.importedApiUrl}`);
    });
    if (p.urlConflicts.length > 20) lines.push(`... 还有 ${p.urlConflicts.length - 20} 条未展示`);
  }

  if (p.willDeletePlatforms?.length) {
    lines.push('');
    lines.push(`将删除“本次未导入”的平台（并级联删除该平台下已配置模型，最多展示 20 条；共 ${p.willDeletePlatforms.length} 条）：`);
    p.willDeletePlatforms.slice(0, 20).forEach((x) => {
      lines.push(`- ${x.name}${x.apiUrl ? ` (${x.apiUrl})` : ''}`);
    });
    if (p.willDeletePlatforms.length > 20) lines.push(`... 还有 ${p.willDeletePlatforms.length - 20} 条未展示`);
  }

  return lines.join('\n');
}

export function DataTransferDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<'export' | 'import'>('export');

  const [exportLoading, setExportLoading] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [exportJson, setExportJson] = useState<string>('');
  const [exportFetchedAt, setExportFetchedAt] = useState<number>(0);

  const [importText, setImportText] = useState('');
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importOkMsg, setImportOkMsg] = useState<string | null>(null);

  const [opts, setOpts] = useState<DataConfigImportOptions>({
    applyMain: true,
    applyIntent: true,
    applyVision: true,
    applyImageGen: true,
    forceOverwriteSameName: true,
    deleteNotImported: false,
  });

  const parsedImport = useMemo(() => safeJsonParse(importText), [importText]);
  const validatedImport = useMemo(() => (parsedImport.ok ? validateExportedConfig(parsedImport.value) : parsedImport), [parsedImport]);

  const importSummary = useMemo(() => {
    if (!validatedImport.ok) return null;
    const v = validatedImport.data;
    const platforms = v.platforms ?? [];
    const pCount = platforms.length ?? 0;
    let modelCount = 0;
    for (const p of platforms) {
      const ms = Array.isArray(p?.enabledModels) ? p.enabledModels : [];
      modelCount += ms.length;
    }
    return { version: v.version, platformCount: pCount, enabledModelCount: modelCount };
  }, [validatedImport]);

  const fetchExport = async () => {
    setExportLoading(true);
    setExportErr(null);
    try {
      const res = await exportConfig();
      if (!res.success) {
        setExportErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '导出失败'}`);
        return;
      }
      const txt = formatJson(res.data);
      setExportJson(txt);
      setExportFetchedAt(Date.now());
    } finally {
      setExportLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setImportOkMsg(null);
    setImportErr(null);
    // 默认打开时拉一次导出数据，减少用户点击
    void fetchExport();
  }, [open]);

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    const text = await file.text();
    setImportText(text);
  };

  const doImport = async () => {
    setImportOkMsg(null);
    setImportErr(null);

    if (!validatedImport.ok) {
      setImportErr(validatedImport.error);
      return;
    }

    const v = validatedImport.data;

    setImportLoading(true);
    try {
      // 先预览，生成 URL 冲突/删除清单，必要时强制二次确认
      const previewRes = await previewImportConfig({ data: v, options: opts });
      if (!previewRes.success) {
        setImportErr(`${previewRes.error?.code || 'ERROR'}：${previewRes.error?.message || '预览失败'}`);
        return;
      }

      const preview = previewRes.data;
      const needConfirm = Boolean(preview.requiresConfirmation);
      if (needConfirm) {
        const ok = await systemDialog.confirm({
          title: '确认导入',
          tone: 'danger',
          message: buildImportConfirmMessage(preview),
          confirmText: '继续导入',
          cancelText: '取消',
        });
        if (!ok) {
          setImportErr('已取消导入');
          return;
        }
      }

      const res = await importConfig({ data: v, options: opts, confirmed: needConfirm });
      if (!res.success) {
        setImportErr(`${res.error?.code || 'ERROR'}：${res.error?.message || '导入失败'}`);
        return;
      }

      const msg =
        `导入完成：平台 upsert ${res.data.platformUpserted}（新增 ${res.data.platformInserted} / 更新 ${res.data.platformUpdated}），` +
        `模型 upsert ${res.data.modelUpserted}（新增 ${res.data.modelInserted} / 更新 ${res.data.modelUpdated}）`;
      setImportOkMsg(msg);
      if (onImported) await onImported();
    } finally {
      setImportLoading(false);
    }
  };

  const canCopy = Boolean(exportJson);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="数据迁移"
      description="导入/导出平台 + 密钥 + 启用模型（JSON）。导出包含明文密钥，请谨慎保存。"
      maxWidth={980}
      contentStyle={{ height: 'min(86vh, 760px)' }}
      content={
        <div className="h-full min-h-0 flex flex-col">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTab('export')}
              className="h-9 px-3 rounded-[12px] text-sm font-semibold transition-colors"
              style={{
                background: tab === 'export' ? 'rgba(255,255,255,0.08)' : 'transparent',
                border: '1px solid rgba(255,255,255,0.10)',
                color: 'var(--text-primary)',
              }}
            >
              导出
            </button>
            <button
              type="button"
              onClick={() => setTab('import')}
              className="h-9 px-3 rounded-[12px] text-sm font-semibold transition-colors"
              style={{
                background: tab === 'import' ? 'rgba(255,255,255,0.08)' : 'transparent',
                border: '1px solid rgba(255,255,255,0.10)',
                color: 'var(--text-primary)',
              }}
            >
              导入
            </button>

            <div className="flex-1" />

            {tab === 'export' ? (
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={fetchExport} disabled={exportLoading}>
                  <RefreshCw size={16} />
                  {exportLoading ? '刷新中' : '刷新'}
                </Button>

                <Tooltip content="复制导出 JSON（包含明文密钥）" side="bottom" align="end">
                  <span className="inline-flex">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        if (!canCopy) return;
                        await navigator.clipboard.writeText(exportJson);
                      }}
                      disabled={!canCopy}
                    >
                      <Copy size={16} />
                      复制
                    </Button>
                  </span>
                </Tooltip>

                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const ts = exportFetchedAt ? new Date(exportFetchedAt) : new Date();
                    const pad2 = (n: number) => String(n).padStart(2, '0');
                    const name = `prd-agent-config-${ts.getFullYear()}${pad2(ts.getMonth() + 1)}${pad2(ts.getDate())}-${pad2(ts.getHours())}${pad2(ts.getMinutes())}${pad2(ts.getSeconds())}.json`;
                    downloadTextFile(name, exportJson || '{}');
                  }}
                  disabled={!exportJson}
                >
                  <Download size={16} />
                  下载
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <label
                  className="inline-flex items-center gap-2 h-9 px-3 rounded-[12px] text-sm font-semibold cursor-pointer transition-colors"
                  style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <Upload size={16} />
                  选择文件
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.currentTarget.files?.[0] ?? null;
                      void onPickFile(f);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                <Button variant="primary" size="sm" onClick={doImport} disabled={importLoading}>
                  <Check size={16} />
                  {importLoading ? '导入中' : '导入'}
                </Button>
              </div>
            )}
          </div>

          <div className="mt-4 rounded-[14px] p-3 text-xs" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-secondary)' }}>
            注意：导出 JSON **包含明文密钥 apiKey**。建议仅在本机离线保存，避免粘贴到聊天、工单或公共仓库中。
          </div>

          <div className="mt-4 flex-1 min-h-0 grid gap-4" style={{ gridTemplateColumns: tab === 'export' ? '1fr' : '1fr 320px' }}>
            <div className="min-h-0 flex flex-col">
              {tab === 'export' ? (
                <>
                  {exportErr && <div className="mb-2 text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>{exportErr}</div>}
                  <textarea
                    value={exportJson}
                    readOnly
                    className="w-full flex-1 min-h-0 rounded-[14px] p-3 text-xs outline-none"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'var(--text-primary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      lineHeight: 1.5,
                      whiteSpace: 'pre',
                    }}
                    placeholder={exportLoading ? '导出中...' : '暂无导出数据'}
                  />
                </>
              ) : (
                <>
                  {importErr && <div className="mb-2 text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>{importErr}</div>}
                  {importOkMsg && <div className="mb-2 text-sm" style={{ color: 'rgba(34,197,94,0.95)' }}>{importOkMsg}</div>}
                  <textarea
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    className="w-full flex-1 min-h-0 rounded-[14px] p-3 text-xs outline-none"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'var(--text-primary)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                      lineHeight: 1.5,
                      whiteSpace: 'pre',
                    }}
                    placeholder="粘贴导入 JSON，或点击右上角“选择文件”导入..."
                  />
                </>
              )}
            </div>

            {tab === 'import' ? (
              <div className="min-h-0 flex flex-col gap-3">
                <div className="rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>导入选项</div>
                  <div className="mt-3 space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={opts.forceOverwriteSameName}
                        onChange={(e) => setOpts((s) => ({ ...s, forceOverwriteSameName: e.target.checked }))}
                      />
                      强制覆盖同名平台（默认勾选）
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={opts.deleteNotImported}
                        onChange={(e) => setOpts((s) => ({ ...s, deleteNotImported: e.target.checked }))}
                      />
                      删除本次未导入的平台（含该平台下模型）
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={opts.applyMain} onChange={(e) => setOpts((s) => ({ ...s, applyMain: e.target.checked }))} />
                      导入主模型
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={opts.applyIntent} onChange={(e) => setOpts((s) => ({ ...s, applyIntent: e.target.checked }))} />
                      导入意图模型
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={opts.applyVision} onChange={(e) => setOpts((s) => ({ ...s, applyVision: e.target.checked }))} />
                      导入识图模型
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={opts.applyImageGen} onChange={(e) => setOpts((s) => ({ ...s, applyImageGen: e.target.checked }))} />
                      导入生图模型
                    </label>
                  </div>
                </div>

                <div className="rounded-[14px] p-3" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)' }}>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>校验</div>
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {importSummary ? (
                      <>
                        <div>version: {String(importSummary.version)}</div>
                        <div>platforms: {importSummary.platformCount}</div>
                        <div>enabledModels(total): {importSummary.enabledModelCount}</div>
                      </>
                    ) : (
                      <div>{validatedImport.ok ? '无法生成摘要' : validatedImport.error}</div>
                    )}
                  </div>
                </div>

                <div className="rounded-[14px] p-3 text-xs" style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(0,0,0,0.20)', color: 'var(--text-muted)' }}>
                  导入策略：平台按名称匹配。勾选“强制覆盖”时同名平台会更新（平台 id 保持不变）；未勾选时仅新增不存在的平台。模型按 platformId + modelId upsert；导入列表内模型会被设为启用，但不会自动禁用现有其它模型。
                </div>
              </div>
            ) : null}
          </div>
        </div>
      }
    />
  );
}


