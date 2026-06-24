import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import {
  Upload, FileText, Play, Save, Trash2, ChevronDown, ChevronRight,
  RefreshCw, FileOutput, CheckCircle2, Table2, X,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Surface } from '@/components/design/Surface';
import { PageHeader } from '@/components/design/PageHeader';
import { Select } from '@/components/design/Select';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import {
  parseSourceFile, parseTemplateFile, createTask, listTasks, listRules,
  saveRule, deleteRule, downloadResult,
  type ParseSourceResult, type ParseTemplateResult,
  type FieldMapping, type FileConvertTask, type FileConvertRule,
} from '@/services/real/fileConvertService';

const inputStyle: CSSProperties = {
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
};

type Step = 'upload' | 'mapping' | 'running';

export default function FileConvertPage() {
  const [step, setStep] = useState<Step>('upload');

  const [sourceResult, setSourceResult] = useState<ParseSourceResult | null>(null);
  const [templateResult, setTemplateResult] = useState<ParseTemplateResult | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [rules, setRules] = useState<FileConvertRule[]>([]);
  const [savingRule, setSavingRule] = useState(false);
  const [saveRuleName, setSaveRuleName] = useState('');
  const [saveRuleWithTemplate, setSaveRuleWithTemplate] = useState(true);
  const [showSaveRuleForm, setShowSaveRuleForm] = useState(false);
  const [rulesExpanded, setRulesExpanded] = useState(false);

  const [taskStatus, setTaskStatus] = useState<string | null>(null);
  const [taskDoneId, setTaskDoneId] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [processedRows, setProcessedRows] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<FileConvertTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const loadRules = useCallback(async () => {
    const res = await listRules();
    if (res.success && Array.isArray(res.data)) setRules(res.data);
  }, []);

  useEffect(() => { loadRules(); }, [loadRules]);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    const res = await listTasks();
    if (res.success && Array.isArray(res.data)) setTasks(res.data);
    setTasksLoading(false);
  }, []);

  const handleSourceUpload = useCallback(async (file: File) => {
    setSourceLoading(true);
    setUploadError(null);
    const res = await parseSourceFile(file);
    setSourceLoading(false);
    if (!res.success) { setUploadError(String(res.error?.message ?? '源文件解析失败')); return; }
    setSourceResult(res.data);
  }, []);

  const handleTemplateUpload = useCallback(async (file: File) => {
    setTemplateLoading(true);
    setUploadError(null);
    const res = await parseTemplateFile(file);
    setTemplateLoading(false);
    if (!res.success) { setUploadError(String(res.error?.message ?? '模板文件解析失败')); return; }
    setTemplateResult(res.data);
  }, []);

  const handleFileDrop = useCallback(
    (type: 'source' | 'template', e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (type === 'source') handleSourceUpload(file);
      else handleTemplateUpload(file);
    },
    [handleSourceUpload, handleTemplateUpload]
  );

  const toMappingStep = useCallback(() => {
    if (!sourceResult || !templateResult) return;
    const initial: FieldMapping[] = templateResult.placeholders.map(ph => ({
      templatePlaceholder: ph,
      sourceColumn: sourceResult.columns.find(c => c.toLowerCase() === ph.toLowerCase()) ?? sourceResult.columns[0] ?? '',
    }));
    setMappings(initial);
    setStep('mapping');
  }, [sourceResult, templateResult]);

  const applyRule = useCallback((rule: FileConvertRule) => {
    const applied: FieldMapping[] = rule.fieldMappings.map(m => ({
      templatePlaceholder: m.templatePlaceholder,
      sourceColumn: sourceResult?.columns.find(c => c === m.sourceColumn) ?? m.sourceColumn,
    }));
    setMappings(applied);
    if (rule.templateFileKey && rule.templateFileName) {
      const placeholders = [...new Set(rule.fieldMappings.map(m => m.templatePlaceholder))];
      setTemplateResult({ fileKey: rule.templateFileKey, fileName: rule.templateFileName, placeholders });
    }
  }, [sourceResult]);

  const handleSaveRule = useCallback(async () => {
    if (!saveRuleName.trim()) return;
    setSavingRule(true);
    const res = await saveRule({
      name: saveRuleName.trim(),
      fieldMappings: mappings,
      lastSourceFileName: sourceResult?.fileName,
      ...(saveRuleWithTemplate && templateResult
        ? { tempTemplateFileKey: templateResult.fileKey, templateFileName: templateResult.fileName }
        : {}),
    });
    setSavingRule(false);
    if (res.success) {
      setShowSaveRuleForm(false);
      setSaveRuleName('');
      loadRules();
      toast.success('规则已保存');
    } else {
      toast.error('保存失败', String(res.error?.message ?? ''));
    }
  }, [saveRuleName, mappings, sourceResult, templateResult, saveRuleWithTemplate, loadRules]);

  const handleDeleteRule = useCallback(async (ruleId: string) => {
    await deleteRule(ruleId);
    loadRules();
  }, [loadRules]);

  const startTask = useCallback(async () => {
    if (!sourceResult || !templateResult) return;
    const validMappings = mappings.filter(m => m.sourceColumn && m.sourceColumn !== '__skip__' && m.templatePlaceholder);
    if (validMappings.length === 0) return;

    setStep('running');
    setLogs([]);
    setProcessedRows(0);
    setTotalRows(0);
    setTaskDoneId(null);
    setTaskError(null);
    setTaskStatus('queued');

    const res = await createTask({
      sourceFileKey: sourceResult.fileKey,
      sourceFileName: sourceResult.fileName,
      templateFileKey: templateResult.fileKey,
      templateFileName: templateResult.fileName,
      fieldMappings: validMappings,
    });

    if (!res.success) { setTaskError(String(res.error?.message ?? '创建任务失败')); return; }

    const taskId = res.data.taskId;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const token = useAuthStore.getState().token ?? '';

    fetch(`/api/file-convert/tasks/${taskId}/progress`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'X-Client': 'admin' },
      signal: ac.signal,
    }).then(async (response) => {
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const parseEvents = (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const lines = part.split('\n');
          let eventType = 'message'; let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (eventType === 'log') setLogs(prev => [...prev, String(parsed.message ?? '')]);
            else if (eventType === 'progress') {
              setTaskStatus(String(parsed.status ?? ''));
              setTotalRows(Number(parsed.totalRows) || 0);
              setProcessedRows(Number(parsed.processedRows) || 0);
            } else if (eventType === 'done') {
              const doneStatus = String(parsed.status ?? '');
              setTaskStatus(doneStatus);
              if (doneStatus === 'done' && parsed.hasResult) setTaskDoneId(taskId);
              setTaskError(parsed.errorMessage ? String(parsed.errorMessage) : null);
              loadTasks();
            }
          } catch { /* ignore */ }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parseEvents(decoder.decode(value, { stream: true }));
      }
    }).catch(() => { /* aborted */ });
  }, [sourceResult, templateResult, mappings, loadTasks]);

  useEffect(() => { return () => abortRef.current?.abort(); }, []);

  const isFromRule = (key: string | undefined) => key?.startsWith('file-convert/rules/');

  // ── 进度百分比 ──
  const pct = totalRows > 0 ? Math.round((processedRows / totalRows) * 100) : 0;

  // 步骤顺序常量，避免在 render 内反复创建数组
  const STEPS: Step[] = ['upload', 'mapping', 'running'];
  const STEP_LABELS = ['上传文件', '字段映射', '批量生成'];
  const stepIdx = STEPS.indexOf(step);

  return (
    // overflow: clip 不创建 stacking context，避免 backdrop-filter + overflow:hidden 合成层爆炸
    <div className="h-full min-h-0 flex flex-col" style={{ overflow: 'clip' }}>
      {/* 页头 */}
      <div className="shrink-0 px-6 pt-5 pb-4">
        <PageHeader
          title="文件批量转换"
          description="上传源数据文件和目标模板，配置字段映射后批量生成目标文件并下载"
          actions={
            <Button variant="secondary" size="sm" onClick={() => { setShowHistory(v => !v); if (!showHistory) loadTasks(); }}>
              <Table2 size={14} className="mr-1.5" />
              历史任务
            </Button>
          }
        />
      </div>

      {/* 步骤指示器 */}
      <div className="shrink-0 px-6 pb-4">
        <div className="flex items-center gap-0">
          {STEPS.map((s, idx) => {
            const isDone = idx < stepIdx;
            const isActive = step === s;
            return (
              <div key={s} className="flex items-center">
                <div className="flex items-center gap-2">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                    style={{
                      background: isDone ? 'var(--accent-green, #22c55e)' : isActive ? 'var(--accent-primary, #6366f1)' : 'var(--bg-sunken)',
                      color: isDone || isActive ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {isDone ? <CheckCircle2 size={14} /> : idx + 1}
                  </div>
                  <span className="text-xs font-medium" style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {STEP_LABELS[idx]}
                  </span>
                </div>
                {idx < 2 && (
                  <div className="w-12 h-px mx-3" style={{ background: idx < stepIdx ? 'var(--accent-green, #22c55e)' : 'var(--border-default)' }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 主体 - overflow:clip 同上 */}
      <div className="flex-1 min-h-0 flex gap-4 px-6 pb-6" style={{ overflow: 'clip' }}>
        {/* 内容区 */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">

          {/* ── Step 1: 上传文件 ── */}
          {step === 'upload' && (
            <Surface variant="raised" className="rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white" style={{ background: 'var(--accent-primary, #6366f1)' }}>1</div>
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>选择文件</span>
              </div>

              {/* 历史规则 */}
              {rules.length > 0 && (
                <div className="mb-4 rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-default)' }}>
                  <button
                    className="w-full flex items-center justify-between px-4 py-2.5 text-left transition-colors hover:opacity-80"
                    style={{ background: 'var(--bg-sunken)' }}
                    onClick={() => setRulesExpanded(v => !v)}
                  >
                    <div className="flex items-center gap-2">
                      <FileOutput size={14} style={{ color: 'var(--accent-primary, #6366f1)' }} />
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                        从已保存规则加载（{rules.length} 条）
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>— 含模板的规则只需上传源文件</span>
                    </div>
                    {rulesExpanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
                  </button>
                  {rulesExpanded && (
                    <div className="divide-y" style={{ borderTop: '1px solid var(--border-default)' }}>
                      {rules.map(r => (
                        <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            <div>
                              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{r.name}</span>
                              <div className="flex items-center gap-2 mt-0.5">
                                {r.templateFileName && (
                                  <span className="text-[11px] px-1.5 py-px rounded font-medium" style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent-primary, #6366f1)' }}>
                                    含模板 · {r.templateFileName}
                                  </span>
                                )}
                                {r.lastSourceFileName && (
                                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{r.lastSourceFileName}</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => applyRule(r)}>加载</Button>
                            <button className="p-1.5 rounded-lg transition-colors hover:opacity-70" onClick={() => handleDeleteRule(r.id)}>
                              <Trash2 size={13} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 上传区 */}
              <div className="grid grid-cols-2 gap-3">
                <FileDropZone
                  label="源数据文件"
                  accept=".csv,.xlsx,.json"
                  hint="CSV / Excel / JSON"
                  result={sourceResult ? `${sourceResult.fileName}` : null}
                  meta={sourceResult ? `${sourceResult.totalRows} 行 · ${sourceResult.columns.length} 列` : null}
                  loading={sourceLoading}
                  onFile={handleSourceUpload}
                  onDrop={e => handleFileDrop('source', e)}
                  onClear={() => setSourceResult(null)}
                />
                <FileDropZone
                  label="目标模板文件"
                  accept=".docx,.xlsx"
                  hint="Word (.docx) / Excel (.xlsx)"
                  result={templateResult ? `${templateResult.fileName}` : null}
                  meta={templateResult ? `${templateResult.placeholders.length} 个占位符${isFromRule(templateResult.fileKey) ? ' · 来自规则' : ''}` : null}
                  loading={templateLoading}
                  fromRule={isFromRule(templateResult?.fileKey)}
                  onFile={handleTemplateUpload}
                  onDrop={e => handleFileDrop('template', e)}
                  onClear={() => setTemplateResult(null)}
                />
              </div>

              {uploadError && (
                <div className="mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444' }}>
                  <X size={14} /> {uploadError}
                </div>
              )}

              {/* 字段/占位符预览 */}
              {(sourceResult || templateResult) && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {sourceResult && (
                    <div className="rounded-xl p-3" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                      <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>列名</p>
                      <div className="flex flex-wrap gap-1">
                        {sourceResult.columns.map(c => (
                          <span key={c} className="text-[11px] px-2 py-0.5 rounded-md font-medium" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>{c}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {templateResult && (
                    <div className="rounded-xl p-3" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                      <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>占位符</p>
                      <div className="flex flex-wrap gap-1">
                        {templateResult.placeholders.map(p => (
                          <span key={p} className="text-[11px] px-2 py-0.5 rounded-md font-mono font-medium" style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary, #6366f1)', border: '1px solid rgba(99,102,241,0.2)' }}>{`{{${p}}}`}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {sourceResult && templateResult && (
                <Button className="mt-4 w-full" variant="primary" onClick={toMappingStep}>
                  下一步：配置字段映射
                </Button>
              )}
            </Surface>
          )}

          {/* ── Step 2: 字段映射 ── */}
          {(step === 'mapping' || step === 'running') && (
            <Surface variant="raised" className="rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white" style={{ background: step === 'running' ? 'var(--accent-green, #22c55e)' : 'var(--accent-primary, #6366f1)' }}>
                    {step === 'running' ? <CheckCircle2 size={12} /> : '2'}
                  </div>
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>字段映射</span>
                </div>
                {step === 'mapping' && (
                  <button className="text-xs" style={{ color: 'var(--text-muted)' }} onClick={() => { setStep('upload'); }}>
                    返回修改文件
                  </button>
                )}
              </div>

              {step === 'mapping' && (
                <>
                  <div className="rounded-xl overflow-hidden mb-4" style={{ border: '1px solid var(--border-default)' }}>
                    <div className="grid grid-cols-2 gap-0 px-4 py-2" style={{ background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-default)' }}>
                      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>模板占位符</span>
                      <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>源文件列</span>
                    </div>
                    {mappings.map((m, idx) => (
                      <div key={m.templatePlaceholder} className="grid grid-cols-2 items-center gap-0 px-4 py-2" style={{ borderBottom: idx < mappings.length - 1 ? '1px solid var(--border-default)' : undefined }}>
                        <span className="text-xs font-mono font-medium pr-4" style={{ color: 'var(--accent-primary, #6366f1)' }}>{`{{${m.templatePlaceholder}}}`}</span>
                        <Select
                          value={m.sourceColumn}
                          onValueChange={(v: string) => {
                            const next = [...mappings];
                            next[idx] = { ...m, sourceColumn: v };
                            setMappings(next);
                          }}
                          uiSize="sm"
                        >
                          {sourceResult?.columns.map(c => <option key={c} value={c}>{c}</option>)}
                          <option value="__skip__">（不映射）</option>
                        </Select>
                      </div>
                    ))}
                  </div>

                  {/* 保存规则 */}
                  {!showSaveRuleForm ? (
                    <button className="flex items-center gap-1.5 text-xs mb-4 transition-opacity hover:opacity-70" style={{ color: 'var(--text-secondary)' }} onClick={() => setShowSaveRuleForm(true)}>
                      <Save size={12} /> 保存为规则，下次直接复用
                    </button>
                  ) : (
                    <div className="mb-4 rounded-xl p-4" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                      <p className="text-xs font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>保存规则</p>
                      <input
                        className="w-full h-9 px-3 text-sm rounded-xl outline-none mb-3"
                        style={inputStyle}
                        placeholder="规则名称，例：员工信息转月度报告"
                        value={saveRuleName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSaveRuleName(e.target.value)}
                        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSaveRule()}
                      />
                      {templateResult && (
                        <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={saveRuleWithTemplate}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSaveRuleWithTemplate(e.target.checked)}
                            className="w-4 h-4 rounded"
                          />
                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            同时保存模板文件（下次加载规则无需重新上传）
                          </span>
                        </label>
                      )}
                      <div className="flex gap-2">
                        <Button size="sm" variant="primary" onClick={handleSaveRule} disabled={savingRule || !saveRuleName.trim()}>
                          {savingRule ? '保存中...' : '确认保存'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowSaveRuleForm(false)}>取消</Button>
                      </div>
                    </div>
                  )}

                  <Button className="w-full" variant="primary" onClick={startTask}>
                    <Play size={15} className="mr-1.5" />
                    开始批量生成
                  </Button>
                </>
              )}

              {step === 'running' && (
                <div className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                  {mappings.filter(m => m.sourceColumn !== '__skip__').map(m => (
                    <span key={m.templatePlaceholder} className="inline-flex items-center gap-1 mr-2 mb-1 px-2 py-0.5 rounded-md" style={{ background: 'var(--bg-sunken)', color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--accent-primary, #6366f1)' }}>{`{{${m.templatePlaceholder}}}`}</span>
                      <span style={{ color: 'var(--text-muted)' }}>←</span>
                      {m.sourceColumn}
                    </span>
                  ))}
                </div>
              )}
            </Surface>
          )}

          {/* ── Step 3: 执行进度 ── */}
          {step === 'running' && (
            <Surface variant="raised" className="rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white" style={{ background: taskStatus === 'done' ? 'var(--accent-green, #22c55e)' : 'var(--accent-primary, #6366f1)' }}>
                  {taskStatus === 'done' ? <CheckCircle2 size={12} /> : '3'}
                </div>
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>批量生成</span>
                {taskStatus === 'running' && totalRows > 0 && (
                  <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>{processedRows} / {totalRows} 个文件</span>
                )}
              </div>

              {/* 进度条 */}
              {totalRows > 0 && (
                <div className="mb-4">
                  <div className="w-full h-1.5 rounded-full overflow-hidden mb-1" style={{ background: 'var(--bg-sunken)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: taskStatus === 'done' ? 'var(--accent-green, #22c55e)' : 'var(--accent-primary, #6366f1)' }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{taskStatus === 'done' ? '全部完成' : '处理中...'}</span>
                    <span>{pct}%</span>
                  </div>
                </div>
              )}

              {/* 日志 */}
              <div className="rounded-xl p-3 max-h-36 overflow-y-auto text-xs font-mono space-y-0.5" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--border-default)' }}>
                {logs.length === 0
                  ? <span style={{ color: 'var(--text-muted)' }}>等待处理...</span>
                  : logs.map((log, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>{log}</div>)}
              </div>

              {taskError && (
                <div className="mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444' }}>
                  <X size={14} /> {taskError}
                </div>
              )}

              {taskStatus === 'done' && taskDoneId && (
                <Button className="mt-4 w-full" variant="primary" onClick={() => downloadResult(taskDoneId).catch(e => toast.error('下载失败', String(e?.message ?? '')))}>
                  下载 ZIP 包
                </Button>
              )}

              <div className="mt-3 flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => { setStep('upload'); setSourceResult(null); setTemplateResult(null); setMappings([]); setTaskStatus(null); }}>
                  重新开始
                </Button>
              </div>
            </Surface>
          )}
        </div>

        {/* ── 历史任务侧边栏 ── */}
        {showHistory && (
          <div className="w-72 shrink-0 flex flex-col" style={{ minHeight: 0 }}>
            <GlassCard variant="subtle" className="flex-1 flex flex-col overflow-hidden p-0">
              <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border-default)' }}>
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>历史任务</span>
                <div className="flex gap-1">
                  <button className="p-1.5 rounded-lg transition-opacity hover:opacity-70" onClick={loadTasks}>
                    <RefreshCw size={13} className={tasksLoading ? 'animate-spin' : ''} style={{ color: 'var(--text-muted)' }} />
                  </button>
                  <button className="p-1.5 rounded-lg transition-opacity hover:opacity-70" onClick={() => setShowHistory(false)}>
                    <X size={13} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {tasks.length === 0
                  ? <div className="p-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>暂无历史任务</div>
                  : tasks.map(t => <TaskRow key={t.id} task={t} />)}
              </div>
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 文件上传区 ──
function FileDropZone({
  label, accept, hint, result, meta, loading, fromRule, onFile, onDrop, onClear,
}: {
  label: string; accept: string; hint: string;
  result: string | null; meta: string | null;
  loading: boolean; fromRule?: boolean;
  onFile: (f: File) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <p className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>{label}</p>
      <div
        className="relative rounded-xl transition-all cursor-pointer"
        style={{
          border: result ? '1px solid var(--border-default)' : '1.5px dashed var(--border-default)',
          background: result ? 'var(--bg-sunken)' : 'transparent',
          minHeight: 88,
        }}
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => !result && inputRef.current?.click()}
      >
        <input ref={inputRef} type="file" accept={accept} className="hidden"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />

        {loading ? (
          <div className="flex items-center justify-center h-[88px]">
            <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--accent-primary, #6366f1)', borderTopColor: 'transparent' }} />
          </div>
        ) : result ? (
          <div className="flex items-start justify-between p-3">
            <div className="flex items-start gap-2.5">
              <FileText size={18} className="shrink-0 mt-0.5" style={{ color: fromRule ? 'var(--accent-primary, #6366f1)' : 'var(--text-secondary)' }} />
              <div>
                <p className="text-xs font-medium leading-tight" style={{ color: 'var(--text-primary)' }}>{result}</p>
                {meta && <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{meta}</p>}
              </div>
            </div>
            <button className="p-1 rounded-md transition-opacity hover:opacity-70 shrink-0 ml-2" onClick={e => { e.stopPropagation(); onClear(); }}>
              <X size={12} style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-[88px] gap-1.5">
            <Upload size={18} style={{ color: 'var(--text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>点击或拖拽文件</p>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>{hint}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// 静态映射：定义在组件外避免每次渲染重建
const TASK_STATUS_COLOR: Record<string, string> = {
  queued: 'var(--text-muted)', running: '#3b82f6', done: '#22c55e', error: '#ef4444',
};
const TASK_STATUS_LABEL: Record<string, string> = { queued: '排队中', running: '处理中', done: '完成', error: '失败' };

// ── 历史任务行 ──
function TaskRow({ task }: { task: FileConvertTask }) {

  return (
    <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border-default)' }}>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-medium truncate max-w-[170px]" style={{ color: 'var(--text-primary)' }}>{task.sourceFileName}</span>
        <span className="text-[11px] font-medium" style={{ color: TASK_STATUS_COLOR[task.status] ?? 'var(--text-muted)' }}>
          {TASK_STATUS_LABEL[task.status] ?? task.status}
        </span>
      </div>
      <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
        {task.totalRows > 0 ? `${task.processedRows}/${task.totalRows} 行 · ` : ''}
        {new Date(task.createdAt).toLocaleDateString('zh-CN')}
      </div>
      {task.status === 'done' && task.hasResult && (
        <button
          className="text-[11px] font-medium transition-opacity hover:opacity-70"
          style={{ color: 'var(--accent-primary, #6366f1)' }}
          onClick={() => downloadResult(task.id)}
        >
          下载 ZIP
        </button>
      )}
      {task.status === 'done' && !task.hasResult && (
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>文件已清理</span>
      )}
      {task.status === 'error' && task.errorMessage && (
        <div className="text-[11px] truncate" style={{ color: '#ef4444' }} title={task.errorMessage}>
          {task.errorMessage}
        </div>
      )}
    </div>
  );
}
