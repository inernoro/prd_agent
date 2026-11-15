import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getLogicalModels } from '@/lib/api';
import type { GatewayAppCaller, LogicalModelItem } from '@/lib/types';
import { appCallerDefaultModel, callerModelWorkspaceHref } from '@/lib/appCallerDefaultModel';
import { Button } from '@/components/ui';

const DefaultsContext = createContext<{ models: LogicalModelItem[] | null; failed: boolean; returnSearch: string; reload: () => void }>({ models: null, failed: false, returnSearch: '', reload: () => {} });
export function AppCallerDefaultsProvider({ children, returnSearch }: { children: ReactNode; returnSearch: string }) {
  const [models, setModels] = useState<LogicalModelItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setModels(null);
    getLogicalModels().then(result => {
      if (!alive) return;
      if (result.success) setModels(result.data.items); else { setModels(null); setFailed(true); }
    }).catch(() => { if (alive) { setModels(null); setFailed(true); } });
    return () => { alive = false; };
  }, [revision]);
  return <DefaultsContext.Provider value={{ models, failed, returnSearch, reload: () => setRevision(value => value + 1) }}>{children}</DefaultsContext.Provider>;
}

export function AppCallerDefaultModel({ item }: { item: Pick<GatewayAppCaller, 'appCallerCode' | 'requestType'> }) {
  const { models, failed, returnSearch, reload } = useContext(DefaultsContext);
  if (failed) return <div className="lg-app-caller-stack"><span>默认模型读取失败</span><Button size="sm" variant="ghost" onClick={reload}>重新读取</Button></div>;
  if (!models) return <span>正在读取默认模型…</span>;
  const { model, source, allowed } = appCallerDefaultModel(models, item.appCallerCode, item.requestType);
  return <div className="lg-app-caller-stack">
    <strong>{model?.name || model?.publicId || '未配置默认模型'}</strong>
    <span>{model ? source === 'caller' ? '此调用方专属默认' : '沿用用途默认' : '未点名模型的请求无默认目标'}</span>
    {!allowed ? <span className="lg-app-caller-warning">模型未允许此调用方</span> : null}
    <Link className="lg-text-link" to={callerModelWorkspaceHref(item.appCallerCode, item.requestType, returnSearch)}>查看默认模型</Link>
  </div>;
}

export function AppCallerPromptPolicyLink({ item }: { item: GatewayAppCaller }) {
  const { returnSearch } = useContext(DefaultsContext);
  return <Link to={`/app-callers/${encodeURIComponent(item.id)}/prompt-policy?${new URLSearchParams({ callerReturn: returnSearch })}`}>提示词策略</Link>;
}
