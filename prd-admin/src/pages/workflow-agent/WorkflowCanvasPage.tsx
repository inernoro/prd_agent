import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import { getWorkflow, listExecutions } from '@/services';
import type { Workflow, WorkflowExecution } from '@/services/contracts/workflowAgent';
import { Button } from '@/components/design/Button';
import { WorkflowCanvas } from './WorkflowCanvas';

/**
 * 画布编辑的路由包装页。
 * 路径: /workflow-agent/:workflowId/canvas
 *
 * 负责加载 workflow 数据后传给 WorkflowCanvas 渲染。
 *
 * 导航策略：ReactFlow 内部有 53+ 个 zustand useSyncExternalStore 订阅，
 * 在 React 18 并发模式下会阻塞 React Router 的 location 状态传播。
 * 因此导航前先卸载 ReactFlow（设 unmounting=true），等一帧后再 navigate()。
 */
export function WorkflowCanvasPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [loading, setLoading] = useState(true);
  // 先卸载 ReactFlow 再导航，避免 zustand store 阻塞 React Router
  const [unmounting, setUnmounting] = useState(false);
  const pendingNav = useRef<string | null>(null);

  const safeNavigate = useCallback((path: string) => {
    pendingNav.current = path;
    setUnmounting(true);
  }, []);

  // unmounting 变为 true → ReactFlow 已卸载 → 下一帧执行 navigate
  useEffect(() => {
    if (!unmounting || !pendingNav.current) return;
    const target = pendingNav.current;
    const raf = requestAnimationFrame(() => {
      navigate(target);
    });
    return () => cancelAnimationFrame(raf);
  }, [unmounting, navigate]);

  useEffect(() => {
    if (!workflowId) return;
    (async () => {
      setLoading(true);
      try {
        const wfRes = await getWorkflow(workflowId);
        if (wfRes.success && wfRes.data) {
          setWorkflow(wfRes.data.workflow);

          // 加载最近一次执行用于状态渲染
          const execRes = await listExecutions({ workflowId, pageSize: 1 });
          if (execRes.success && execRes.data?.items?.length) {
            setExecution(execRes.data.items[0]);
          }
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [workflowId]);

  if (loading || unmounting) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--text-muted)' }} />
        <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {unmounting ? '返回中...' : '加载画布...'}
        </span>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <AlertCircle className="w-8 h-8" style={{ color: 'rgba(239,68,68,0.6)' }} />
        <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>工作流不存在</span>
        <Button variant="secondary" size="sm" onClick={() => safeNavigate('/workflow-agent')}>
          <ArrowLeft className="w-4 h-4" /> 返回列表
        </Button>
      </div>
    );
  }

  return (
    <WorkflowCanvas
      workflow={workflow}
      execution={execution}
      onBack={() => safeNavigate(`/workflow-agent/${workflowId}`)}
      onSaved={(wf) => setWorkflow(wf)}
    />
  );
}
