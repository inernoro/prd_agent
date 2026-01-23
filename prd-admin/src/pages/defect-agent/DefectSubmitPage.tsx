import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { useDefectAgentStore } from '@/stores/defectAgentStore';
import type { CreateDefectInput, DefectEnvironment } from '@/services/contracts/defectAgent';
import { ArrowLeft, Plus, Minus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function DefectSubmitPage() {
  const navigate = useNavigate();
  const { createDefect, submitDefect } = useDefectAgentStore();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reproSteps, setReproSteps] = useState<string[]>(['']);
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [actualBehavior, setActualBehavior] = useState('');
  const [tags, setTags] = useState('');
  const [browser, setBrowser] = useState('');
  const [os, setOs] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const addStep = () => setReproSteps([...reproSteps, '']);
  const removeStep = (idx: number) => setReproSteps(reproSteps.filter((_, i) => i !== idx));
  const updateStep = (idx: number, val: string) => {
    const next = [...reproSteps];
    next[idx] = val;
    setReproSteps(next);
  };

  const handleSaveDraft = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const input = buildInput();
      const id = await createDefect(input);
      if (id) navigate(`/defect-agent/${id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const input = buildInput();
      const id = await createDefect(input);
      if (id) {
        await submitDefect(id);
        navigate(`/defect-agent/${id}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const buildInput = (): CreateDefectInput => {
    const env: DefectEnvironment | undefined =
      browser || os || appVersion
        ? { browser: browser || undefined, os: os || undefined, appVersion: appVersion || undefined }
        : undefined;

    return {
      title: title.trim(),
      description: description.trim() || undefined,
      reproSteps: reproSteps.filter((s) => s.trim()),
      expectedBehavior: expectedBehavior.trim() || undefined,
      actualBehavior: actualBehavior.trim() || undefined,
      environment: env,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
  };

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/defect-agent')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-lg font-semibold text-white/90">提交新缺陷</h1>
      </div>

      <div className="max-w-3xl w-full mx-auto space-y-4">
        {/* Title */}
        <GlassCard className="p-4">
          <label className="block text-sm font-medium text-white/70 mb-1">标题 *</label>
          <input
            type="text"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white/90 placeholder:text-white/30"
            placeholder="简要描述问题现象..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </GlassCard>

        {/* Description */}
        <GlassCard className="p-4">
          <label className="block text-sm font-medium text-white/70 mb-1">问题描述</label>
          <textarea
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white/90 placeholder:text-white/30 min-h-[120px] resize-y"
            placeholder="详细描述你遇到的问题..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </GlassCard>

        {/* Repro Steps */}
        <GlassCard className="p-4">
          <label className="block text-sm font-medium text-white/70 mb-2">重现步骤</label>
          <div className="space-y-2">
            {reproSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-white/30 w-5">{i + 1}.</span>
                <input
                  type="text"
                  className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-1.5 text-sm text-white/90 placeholder:text-white/30"
                  placeholder={`步骤 ${i + 1}...`}
                  value={step}
                  onChange={(e) => updateStep(i, e.target.value)}
                />
                {reproSteps.length > 1 && (
                  <Button variant="ghost" size="sm" onClick={() => removeStep(i)}>
                    <Minus className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="mt-2" onClick={addStep}>
            <Plus className="w-3.5 h-3.5 mr-1" /> 添加步骤
          </Button>
        </GlassCard>

        {/* Expected / Actual */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <GlassCard className="p-4">
            <label className="block text-sm font-medium text-white/70 mb-1">期望行为</label>
            <textarea
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white/90 placeholder:text-white/30 min-h-[80px] resize-y"
              placeholder="期望看到什么结果..."
              value={expectedBehavior}
              onChange={(e) => setExpectedBehavior(e.target.value)}
            />
          </GlassCard>
          <GlassCard className="p-4">
            <label className="block text-sm font-medium text-white/70 mb-1">实际行为</label>
            <textarea
              className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white/90 placeholder:text-white/30 min-h-[80px] resize-y"
              placeholder="实际看到什么结果..."
              value={actualBehavior}
              onChange={(e) => setActualBehavior(e.target.value)}
            />
          </GlassCard>
        </div>

        {/* Environment */}
        <GlassCard className="p-4">
          <label className="block text-sm font-medium text-white/70 mb-2">环境信息</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-white/40 mb-0.5">浏览器</label>
              <input
                type="text"
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                value={browser}
                onChange={(e) => setBrowser(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-white/40 mb-0.5">操作系统</label>
              <input
                type="text"
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                value={os}
                onChange={(e) => setOs(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs text-white/40 mb-0.5">应用版本</label>
              <input
                type="text"
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/90"
                value={appVersion}
                onChange={(e) => setAppVersion(e.target.value)}
              />
            </div>
          </div>
        </GlassCard>

        {/* Tags */}
        <GlassCard className="p-4">
          <label className="block text-sm font-medium text-white/70 mb-1">标签</label>
          <input
            type="text"
            className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white/90 placeholder:text-white/30"
            placeholder="用逗号分隔标签，如: login, input, focus"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </GlassCard>

        {/* Actions */}
        <div className="flex justify-end gap-3 pb-4">
          <Button variant="ghost" size="sm" onClick={handleSaveDraft} disabled={submitting || !title.trim()}>
            保存草稿
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={submitting || !title.trim()}>
            提交审核
          </Button>
        </div>
      </div>
    </div>
  );
}
