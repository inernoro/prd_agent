import { MotionLink as Link } from '@/components/layout/RouteMotion';
import { useEffect, useState } from 'react';


import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { EnvEditor } from '@/pages/cds-settings/EnvEditor';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { CategorizeResponse, LoadState, ProjectsResponse } from '../types';

export function GlobalVarsTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [projectsState, setProjectsState] = useState<LoadState<ProjectsResponse>>({ status: 'loading' });
  const [targetProjectId, setTargetProjectId] = useState('');
  const [preview, setPreview] = useState<CategorizeResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<ProjectsResponse>('/api/projects', { signal: ctrl.signal })
      .then((projects) => {
        setProjectsState({ status: 'ok', data: projects });
      })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setProjectsState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, []);

  async function previewMigrate(): Promise<void> {
    if (!targetProjectId) {
      onToast('请选择目标项目');
      return;
    }
    setSubmitting(true);
    try {
      const data = await apiRequest<CategorizeResponse>('/api/env/categorize', {
        method: 'POST',
        body: { targetProjectId, dryRun: true },
      });
      setPreview(data);
    } catch (err) {
      onToast(`预览失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function executeMigrate(): Promise<void> {
    if (!preview?.targetProjectId) return;
    setSubmitting(true);
    try {
      const data = await apiRequest<CategorizeResponse>('/api/env/categorize', {
        method: 'POST',
        body: { targetProjectId: preview.targetProjectId, dryRun: false },
      });
      const summary = data.summary || {};
      onToast(
        `已整理：复制 ${summary.duplicatedCount || 0}，移动 ${summary.movedCount || 0}，跳过 ${
          (summary.duplicateSkippedCount || 0) + (summary.moveSkippedCount || 0)
        }`,
      );
      setPreview(null);
      setReloadKey((current) => current + 1);
    } catch (err) {
      onToast(`执行失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (preview) {
    return (
      <PreviewPanel
        data={preview}
        projectName={(projectsState.status === 'ok' ? projectsState.data.projects?.find(p => p.id === preview.targetProjectId)?.name || preview.targetProjectId : preview.targetProjectId) || '未知项目'}
        onCancel={() => setPreview(null)}
        onExecute={() => void executeMigrate()}
        submitting={submitting}
      />
    );
  }

  const projects = projectsState.status === 'ok' ? projectsState.data.projects || [] : [];
  const organizePanel = (
    <details className="border-t border-border pt-3">
      <summary className="cursor-pointer text-sm font-medium">将全局中的项目变量整理到项目</summary>
      <div className="mt-1 text-sm leading-6 text-muted-foreground">
        先选择目标项目并查看逐项预览，再确认复制或移动。移动会移除全局原项；项目同名变量不覆盖。
      </div>
      {projectsState.status === 'loading' ? (
        <div className="mt-3">
          <LoadingBlock label="加载项目列表" />
        </div>
      ) : null}
      {projectsState.status === 'error' ? (
        <div className="mt-3">
          <ErrorBlock message={projectsState.message} />
        </div>
      ) : null}
      {projectsState.status === 'ok' && projects.length === 0 ? (
        <div className="mt-3 text-sm text-muted-foreground">当前没有项目，先创建项目后再整理变量。</div>
      ) : null}
      {projects.length > 0 ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            aria-label="整理目标项目"
            value={targetProjectId}
            onChange={(event) => setTargetProjectId(event.target.value)}
            className="min-h-11 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">请选择目标项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name || project.id}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" onClick={() => void previewMigrate()} disabled={submitting || !targetProjectId}>
            预览整理方案
          </Button>
        </div>
      ) : null}
    </details>
  );

  return (
    <EnvEditor
      scope="_global"
      title="CDS 全局变量"
      description={
        <>
          CDS 系统配置与共享变量。只有明确开启“继承 CDS 全局变量”的项目会继承共享变量，同名项目变量优先。项目独有变量请在{' '}
          <Link className="text-primary underline-offset-4 hover:underline" to="/project-list">
            项目列表
          </Link>{' '}
          中选择项目后配置。
        </>
      }
      emptyDescription="没有全局变量。跨项目共享的 CDS 配置可以直接在这里添加；项目独有配置请进入项目设置。"
      onToast={onToast}
      reloadKey={reloadKey}
      topContent={organizePanel}
    />
  );
}

function PreviewPanel({
  data,
  projectName,
  onCancel,
  onExecute,
  submitting,
}: {
  data: CategorizeResponse;
  projectName: string;
  onCancel: () => void;
  onExecute: () => void;
  submitting: boolean;
}): JSX.Element {
  const groups = data.groups || {};
  const summary = data.summary || {};
  const changeCount = summary.changeCount || 0;

  return (
    <Section
      title={`整理到项目：${projectName}`}
      description="复制会保留全局原项；移动会删除全局原项，可能影响其他继承全局变量的项目。下列同名冲突均跳过，不覆盖目标项目。确认前请核对目标与变量名。"
    >
      <div className="space-y-5">
        <PreviewKeys label={`复制到项目：${summary.duplicatedCount || 0}`} keys={groups.duplicated || []} />
        <PreviewKeys label={`从全局移到项目：${summary.movedCount || 0}`} keys={groups.moved || []} />
        <PreviewKeys
          label={`撞名跳过：${(summary.duplicateSkippedCount || 0) + (summary.moveSkippedCount || 0)}`}
          keys={[...(groups.duplicateSkipped || []), ...(groups.moveSkipped || [])]}
        />
        <PreviewKeys label={`保留全局：${summary.globalOnlyCount || 0}`} keys={groups.globalOnly || []} />
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button type="button" onClick={onExecute} disabled={submitting || changeCount === 0}>
            {changeCount === 0 ? '无可整理项' : `确认整理 ${changeCount} 个变量`}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function PreviewKeys({ label, keys }: { label: string; keys: string[] }): JSX.Element {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2">
        {keys.length === 0 ? (
          <span className="text-muted-foreground">无</span>
        ) : (
          keys.map((key) => <CodePill key={key}>{key}</CodePill>)
        )}
      </div>
    </Field>
  );
}
