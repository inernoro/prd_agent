import { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, FileText, Table, Play, Save, Trash2, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Select } from '@/components/design/Select';
import {
  parseSourceFile,
  parseTemplateFile,
  createTask,
  listTasks,
  listRules,
  saveRule,
  deleteRule,
  downloadResult,
  type ParseSourceResult,
  type ParseTemplateResult,
  type FieldMapping,
  type FileConvertTask,
  type FileConvertRule,
} from '@/services/real/fileConvertService';

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
  const [logs, setLogs] = useState<string[]>([]);
  const [processedRows, setProcessedRows] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [taskDoneId, setTaskDoneId] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<FileConvertTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const loadRules = useCallback(async () => {
    const res = await listRules();
    if (res.success && Array.isArray(res.data)) setRules(res.data);
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

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
    if (!res.success) {
      setUploadError(String(res.error?.message ?? '源文件解析失败'));
      return;
    }
    setSourceResult(res.data);
  }, []);

  const handleTemplateUpload = useCallback(async (file: File) => {
    setTemplateLoading(true);
    setUploadError(null);
    const res = await parseTemplateFile(file);
    setTemplateLoading(false);
    if (!res.success) {
      setUploadError(String(res.error?.message ?? '模板文件解析失败'));
      return;
    }
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
      sourceColumn:
        sourceResult.columns.find(c => c.toLowerCase() === ph.toLowerCase()) ??
        sourceResult.columns[0] ??
        '',
    }));
    setMappings(initial);
    setStep('mapping');
  }, [sourceResult, templateResult]);

  const applyRule = useCallback(
    (rule: FileConvertRule) => {
      const applied: FieldMapping[] = rule.fieldMappings.map(m => ({
        templatePlaceholder: m.templatePlaceholder,
        sourceColumn:
          sourceResult?.columns.find(c => c === m.sourceColumn) ?? m.sourceColumn,
      }));
      setMappings(applied);

      // 若规则附带了永久模板，自动填充 templateResult，跳过手动上传
      if (rule.templateFileKey && rule.templateFileName) {
        const placeholders = [...new Set(rule.fieldMappings.map(m => m.templatePlaceholder))];
        setTemplateResult({
          fileKey: rule.templateFileKey,
          fileName: rule.templateFileName,
          placeholders,
        });
      }
    },
    [sourceResult]
  );

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
    if (res.success) { setShowSaveRuleForm(false); setSaveRuleName(''); loadRules(); }
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
    const token = sessionStorage.getItem('authToken') || '';

    fetch(`/api/file-convert/tasks/${taskId}/progress`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'X-Client': 'admin' },
      signal: ac.signal,
    })
      .then(async (response) => {
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
            let eventType = 'message';
            let data = '';
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
      })
      .catch(() => { /* aborted or closed */ });
  }, [sourceResult, templateResult, mappings, loadTasks]);

  useEffect(() => { return () => abortRef.current?.abort(); }, []);

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">文件批量转换</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          上传源数据文件和目标模板，配置字段映射后批量生成文件并下载
        </p>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6 space-y-6">

          {/* Step 1 */}
          <CollapsibleSection
            title="第一步：上传文件"
            done={!!sourceResult && !!templateResult}
            forceOpen={step === 'upload'}
          >
            <div className="grid grid-cols-2 gap-4">
              <DropZone
                label="源数据文件"
                accept=".csv,.xlsx,.json"
                hint="支持 CSV / Excel / JSON"
                result={sourceResult ? `${sourceResult.fileName}（${sourceResult.totalRows} 行，${sourceResult.columns.length} 列）` : null}
                loading={sourceLoading}
                onFile={handleSourceUpload}
                onDrop={(e) => handleFileDrop('source', e)}
              />
              <DropZone
                label="目标模板文件"
                accept=".docx,.xlsx"
                hint={templateResult?.fileKey?.startsWith('file-convert/rules/') ? '由规则提供，可重新上传覆盖' : '支持 Word (.docx) / Excel (.xlsx)'}
                result={templateResult ? `${templateResult.fileName}（${templateResult.placeholders.length} 个占位符）${templateResult.fileKey?.startsWith('file-convert/rules/') ? ' · 来自规则' : ''}` : null}
                loading={templateLoading}
                onFile={handleTemplateUpload}
                onDrop={(e) => handleFileDrop('template', e)}
              />
            </div>

            {uploadError && <p className="text-sm text-red-500 mt-2">{uploadError}</p>}

            {sourceResult && (
              <div className="mt-3 p-3 rounded-lg border bg-muted/30">
                <p className="text-xs font-medium text-muted-foreground mb-1">列名预览</p>
                <div className="flex flex-wrap gap-1">
                  {sourceResult.columns.map(c => (
                    <span key={c} className="text-xs px-2 py-0.5 rounded bg-secondary text-secondary-foreground">{c}</span>
                  ))}
                </div>
              </div>
            )}

            {templateResult && (
              <div className="mt-2 p-3 rounded-lg border bg-muted/30">
                <p className="text-xs font-medium text-muted-foreground mb-1">模板占位符</p>
                <div className="flex flex-wrap gap-1">
                  {templateResult.placeholders.map(p => (
                    <span key={p} className="text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-mono">{`{{${p}}}`}</span>
                  ))}
                </div>
              </div>
            )}

            {/* 历史规则入口 - 在 Step 1 展示，方便直接加载规则 */}
            {rules.length > 0 && (
              <div className="mt-3">
                <button
                  className="flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 transition-colors"
                  onClick={() => setRulesExpanded(v => !v)}
                >
                  {rulesExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  加载历史规则（{rules.length} 条）
                  <span className="text-xs text-muted-foreground ml-1">— 含模板的规则只需上传源文件</span>
                </button>
                {rulesExpanded && (
                  <div className="mt-2 space-y-1">
                    {rules.map(r => (
                      <div key={r.id} className="flex items-center justify-between p-2 rounded border hover:bg-muted/40 transition-colors">
                        <div>
                          <span className="text-sm font-medium">{r.name}</span>
                          {r.templateFileName && (
                            <span className="text-xs text-blue-500 ml-2">含模板 · {r.templateFileName}</span>
                          )}
                          {r.lastSourceFileName && (
                            <span className="text-xs text-muted-foreground ml-1">({r.lastSourceFileName})</span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => applyRule(r)}>加载</Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDeleteRule(r.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {sourceResult && templateResult && (
              <Button className="mt-4" variant="primary" onClick={toMappingStep}>
                下一步：配置字段映射
              </Button>
            )}
          </CollapsibleSection>

          {/* Step 2 */}
          {(step === 'mapping' || step === 'running') && (
            <CollapsibleSection
              title="第二步：字段映射"
              done={step === 'running'}
              forceOpen={step === 'mapping'}
            >

              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-4 text-xs font-medium text-muted-foreground pb-1 border-b">
                  <span>模板占位符</span>
                  <span>对应源文件列</span>
                </div>
                {mappings.map((m, idx) => (
                  <div key={m.templatePlaceholder} className="grid grid-cols-2 gap-4 items-center">
                    <span className="text-xs font-mono px-2 py-1 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                      {`{{${m.templatePlaceholder}}}`}
                    </span>
                    <Select
                      value={m.sourceColumn}
                      onValueChange={(v: string) => {
                        const next = [...mappings];
                        next[idx] = { ...m, sourceColumn: v };
                        setMappings(next);
                      }}
                      uiSize="sm"
                    >
                      {sourceResult?.columns.map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                      <option value="__skip__">（不映射）</option>
                    </Select>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-2">
                {!showSaveRuleForm ? (
                  <Button variant="secondary" size="sm" onClick={() => setShowSaveRuleForm(true)}>
                    <Save className="w-3.5 h-3.5 mr-1.5" />
                    保存为规则
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2 p-3 rounded-lg border bg-muted/20">
                    <div className="flex items-center gap-2">
                      <input
                        className="flex-1 h-8 px-3 text-sm rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                        placeholder="规则名称"
                        value={saveRuleName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSaveRuleName(e.target.value)}
                        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && handleSaveRule()}
                      />
                    </div>
                    {templateResult && (
                      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={saveRuleWithTemplate}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSaveRuleWithTemplate(e.target.checked)}
                          className="w-4 h-4 rounded accent-primary"
                        />
                        <span>同时保存模板文件（下次加载规则后无需重新上传模板）</span>
                        <span className="text-xs text-muted-foreground">— {templateResult.fileName}</span>
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
              </div>

              <Button className="mt-4 w-full" variant="primary" onClick={startTask}>
                <Play className="w-4 h-4 mr-2" />
                开始批量生成
              </Button>
            </CollapsibleSection>
          )}

          {/* Step 3 */}
          {step === 'running' && (
            <CollapsibleSection title="第三步：生成进度" done={taskStatus === 'done'} forceOpen>
              {totalRows > 0 && (
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>{taskStatus === 'done' ? '已完成' : '处理中...'}</span>
                    <span>{processedRows} / {totalRows}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${totalRows ? (processedRows / totalRows) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="bg-muted/30 rounded-lg border p-3 max-h-40 overflow-y-auto text-xs font-mono space-y-0.5">
                {logs.length === 0 && <span className="text-muted-foreground">等待处理...</span>}
                {logs.map((log, i) => <div key={i} className="text-muted-foreground">{log}</div>)}
              </div>

              {taskError && (
                <div className="mt-3 p-3 rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400">
                  {taskError}
                </div>
              )}

              {taskStatus === 'done' && taskDoneId && (
                <Button className="mt-4 w-full" variant="primary" onClick={() => downloadResult(taskDoneId)}>
                  下载 ZIP 包
                </Button>
              )}

              <div className="mt-4 flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setStep('upload');
                    setSourceResult(null);
                    setTemplateResult(null);
                    setMappings([]);
                    setTaskStatus(null);
                  }}
                >
                  重新开始
                </Button>
                <Button variant="ghost" size="sm" onClick={loadTasks}>查看历史任务</Button>
              </div>
            </CollapsibleSection>
          )}
        </div>

        <HistoryPanel tasks={tasks} onLoad={loadTasks} loading={tasksLoading} />
      </div>
    </div>
  );
}

// ── 子组件 ──

function CollapsibleSection({
  title, done, forceOpen, children,
}: {
  title: string;
  done?: boolean;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);

  return (
    <div className="rounded-xl border bg-card">
      <button
        className="w-full flex items-center justify-between px-5 py-3.5 text-left"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {done && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
              完成
            </span>
          )}
        </div>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

function DropZone({
  label, accept, hint, result, loading, onFile, onDrop,
}: {
  label: string;
  accept: string;
  hint: string;
  result: string | null;
  loading: boolean;
  onFile: (f: File) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <p className="text-sm font-medium mb-1.5">{label}</p>
      <div
        className="border-2 border-dashed rounded-lg p-5 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/20 transition-colors"
        onDragOver={(e: React.DragEvent<HTMLDivElement>) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        {loading ? (
          <p className="text-sm text-muted-foreground">解析中...</p>
        ) : result ? (
          <div>
            <FileText className="w-5 h-5 mx-auto mb-1 text-primary" />
            <p className="text-sm text-primary font-medium">{result}</p>
            <p className="text-xs text-muted-foreground mt-0.5">点击重新选择</p>
          </div>
        ) : (
          <div>
            <Upload className="w-6 h-6 mx-auto mb-1.5 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">点击或拖拽文件到此处</p>
            <p className="text-xs text-muted-foreground/60 mt-0.5">{hint}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryPanel({ tasks, onLoad, loading }: { tasks: FileConvertTask[]; onLoad: () => void; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        className="w-8 border-l flex flex-col items-center justify-start pt-4 gap-1 text-muted-foreground hover:bg-muted/20 transition-colors"
        onClick={() => { setExpanded(true); onLoad(); }}
        title="历史任务"
      >
        <Table className="w-4 h-4" />
      </button>
    );
  }

  return (
    <div className="w-72 border-l flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="text-sm font-medium">历史任务</span>
        <div className="flex gap-1">
          <button className="p-1 rounded hover:bg-muted/40" onClick={onLoad} title="刷新">
            <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button className="p-1 rounded hover:bg-muted/40" onClick={() => setExpanded(false)} title="收起">
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0
          ? <div className="p-4 text-xs text-muted-foreground text-center">暂无历史任务</div>
          : tasks.map(t => <TaskRow key={t.id} task={t} />)}
      </div>
    </div>
  );
}

function TaskRow({ task }: { task: FileConvertTask }) {
  const statusColor: Record<string, string> = {
    queued: 'text-muted-foreground', running: 'text-blue-500',
    done: 'text-green-600', error: 'text-red-500',
  };
  const statusLabel: Record<string, string> = { queued: '排队中', running: '处理中', done: '完成', error: '失败' };

  return (
    <div className="px-4 py-3 border-b last:border-0 hover:bg-muted/20 transition-colors">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs font-medium truncate max-w-[160px]">{task.sourceFileName}</span>
        <span className={`text-[11px] ${statusColor[task.status] ?? 'text-muted-foreground'}`}>
          {statusLabel[task.status] ?? task.status}
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {task.totalRows > 0 ? `${task.processedRows}/${task.totalRows} 行 · ` : ''}
        {new Date(task.createdAt).toLocaleDateString('zh-CN')}
      </div>
      {task.status === 'done' && task.hasResult && (
        <button
          className="mt-1 text-[11px] text-primary hover:underline"
          onClick={() => downloadResult(task.id)}
        >
          下载 ZIP
        </button>
      )}
      {task.status === 'done' && !task.hasResult && (
        <span className="mt-1 text-[11px] text-muted-foreground">文件已清理</span>
      )}
      {task.status === 'error' && task.errorMessage && (
        <div className="mt-1 text-[11px] text-red-500 truncate" title={task.errorMessage}>
          {task.errorMessage}
        </div>
      )}
    </div>
  );
}
