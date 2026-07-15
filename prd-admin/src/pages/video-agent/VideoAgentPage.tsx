import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  createVideoGenRunReal,
  createVideoProjectReal,
  listVideoGenRunsReal,
  listVideoModelsReal,
  listVideoProjectsReal,
  updateVideoProjectReal,
} from '@/services/real/videoAgent';
import type {
  VideoGenRunListItem,
  VideoProject,
  VideoProjectInput,
  VideoModelOption,
} from '@/services/contracts/videoAgent';
import { VideoGenDirectPanel } from './VideoGenDirectPanel';
import { VideoProjectStudio } from './VideoProjectStudio';
import { VideoStoryboardEditor } from './VideoStoryboardEditor';

const SELECTED_PROJECT_KEY = 'video-agent.selectedProjectId';

export const buildDirectVideoRunInput = (project: VideoProject, input: VideoProjectInput) => {
  const prompt = input.sourceMarkdown?.trim() ?? '';
  const directPrompt = input.styleDescription && input.styleDescription !== '智能匹配'
    ? `${prompt}\n视觉风格：${input.styleDescription}`
    : prompt;
  const directFirstFrameUrl = project.assets.find((asset) => asset.type !== 'audio' && asset.url)?.url;

  return {
    projectId: project.id,
    mode: 'direct' as const,
    articleTitle: project.title,
    directPrompt,
    directVideoModel: input.defaultVideoModel || undefined,
    directAspectRatio: input.defaultAspectRatio as '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | undefined,
    directResolution: input.defaultResolution as '480p' | '720p' | '1080p' | undefined,
    directDuration: input.defaultDuration,
    generateAudio: input.generateAudio,
    directFirstFrameUrl,
  };
};

export const VideoAgentPage: React.FC = () => {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [models, setModels] = useState<VideoModelOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SELECTED_PROJECT_KEY); } catch { return null; }
  });
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const loadWorkspace = useCallback(async () => {
    try {
      const [projectResponse, runResponse, modelResponse] = await Promise.all([
        listVideoProjectsReal(),
        listVideoGenRunsReal({ limit: 50 }),
        listVideoModelsReal(),
      ]);
      if (projectResponse.success) {
        setProjects(projectResponse.data);
        setSelectedProjectId((current) => {
          if (current && projectResponse.data.some((project) => project.id === current)) return current;
          return projectResponse.data[0]?.id ?? null;
        });
      }
      if (runResponse.success) setRuns(runResponse.data.items);
      if (modelResponse.success) setModels(modelResponse.data);
    } catch (error) {
      toast.error('加载视频制作台失败', error instanceof Error ? error.message : '网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);
  useEffect(() => {
    try {
      if (selectedProjectId) sessionStorage.setItem(SELECTED_PROJECT_KEY, selectedProjectId);
      else sessionStorage.removeItem(SELECTED_PROJECT_KEY);
    } catch { /* sessionStorage 不可用时不阻断制作 */ }
  }, [selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeRun = runs.find((run) => run.id === activeRunId);

  const replaceProject = useCallback((project: VideoProject) => {
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    setSelectedProjectId(project.id);
  }, []);

  const saveProject = useCallback(async (input: VideoProjectInput) => {
    setBusy(true);
    try {
      const response = selectedProject
        ? await updateVideoProjectReal(selectedProject.id, input)
        : await createVideoProjectReal(input);
      if (!response.success) {
        toast.error('保存项目失败', response.error?.message);
        return null;
      }
      replaceProject(response.data);
      return response.data;
    } catch (error) {
      toast.error('保存项目失败', error instanceof Error ? error.message : '网络错误');
      return null;
    } finally {
      setBusy(false);
    }
  }, [replaceProject, selectedProject]);

  const analyzeProject = useCallback(async (input: VideoProjectInput) => {
    if (!input.sourceMarkdown?.trim()) {
      toast.warning('请先粘贴或上传文学稿');
      return;
    }
    setBusy(true);
    try {
      const savedResponse = selectedProject
        ? await updateVideoProjectReal(selectedProject.id, input)
        : await createVideoProjectReal(input);
      if (!savedResponse.success) {
        toast.error('保存项目失败', savedResponse.error?.message);
        return;
      }
      const project = savedResponse.data;
      replaceProject(project);
      const runResponse = await createVideoGenRunReal({
        projectId: project.id,
        mode: 'storyboard',
      });
      if (!runResponse.success) {
        toast.error('开始拆镜失败', runResponse.error?.message);
        return;
      }
      setActiveRunId(runResponse.data.runId);
      await loadWorkspace();
    } catch (error) {
      toast.error('开始拆镜失败', error instanceof Error ? error.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }, [loadWorkspace, replaceProject, selectedProject]);

  const createDirectVideo = useCallback(async (input: VideoProjectInput) => {
    const prompt = input.sourceMarkdown?.trim();
    if (!prompt) {
      toast.warning('请先输入画面描述');
      return;
    }
    setBusy(true);
    try {
      const savedResponse = selectedProject
        ? await updateVideoProjectReal(selectedProject.id, input)
        : await createVideoProjectReal(input);
      if (!savedResponse.success) {
        toast.error('保存项目失败', savedResponse.error?.message);
        return;
      }
      const project = savedResponse.data;
      replaceProject(project);
      const runResponse = await createVideoGenRunReal(buildDirectVideoRunInput(project, input));
      if (!runResponse.success) {
        toast.error('开始生成失败', runResponse.error?.message);
        return;
      }
      setActiveRunId(runResponse.data.runId);
      await loadWorkspace();
    } catch (error) {
      toast.error('开始生成失败', error instanceof Error ? error.message : '网络错误');
    } finally {
      setBusy(false);
    }
  }, [loadWorkspace, replaceProject, selectedProject]);

  if (loading) return <MapSectionLoader text="正在打开视频制作台" />;

  if (activeRunId) {
    if (activeRun?.mode === 'direct') {
      return (
        <div className="h-full min-h-0 p-3">
          <VideoGenDirectPanel
            externalRunId={activeRunId}
            onReset={() => { setActiveRunId(null); void loadWorkspace(); }}
            onRunCreated={(runId) => setActiveRunId(runId)}
          />
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 p-3">
        <VideoStoryboardEditor
          runId={activeRunId}
          onBack={() => { setActiveRunId(null); void loadWorkspace(); }}
        />
      </div>
    );
  }

  return (
    <VideoProjectStudio
      projects={projects}
      project={selectedProject}
      runs={runs}
      models={models}
      busy={busy}
      onSelectProject={(project) => {
        setSelectedProjectId(project.id);
        setActiveRunId(null);
      }}
      onNewProject={() => {
        setSelectedProjectId(null);
        setActiveRunId(null);
      }}
      onSave={saveProject}
      onAnalyze={analyzeProject}
      onCreateDirect={createDirectVideo}
      onOpenRun={setActiveRunId}
    />
  );
};

export default VideoAgentPage;
