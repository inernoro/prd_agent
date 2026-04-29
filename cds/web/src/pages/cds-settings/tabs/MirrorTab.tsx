import { useEffect, useState } from 'react';

import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { LoadState, MirrorResponse, TabTitleResponse } from '../types';

interface MirrorData {
  mirror: MirrorResponse;
  tabTitle: TabTitleResponse;
}

export function MirrorTab(): JSX.Element {
  const [state, setState] = useState<LoadState<MirrorData>>({ status: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      apiRequest<MirrorResponse>('/api/mirror', { signal: ctrl.signal }),
      apiRequest<TabTitleResponse>('/api/tab-title', { signal: ctrl.signal }),
    ])
      .then(([mirror, tabTitle]) => setState({ status: 'ok', data: { mirror, tabTitle } }))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, []);

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  return (
    <Section title="镜像与外观" description="CDS 实例级镜像加速与浏览器标签设置。">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="镜像加速">
          <CodePill>{state.data.mirror.enabled ? '已启用' : '未启用'}</CodePill>
        </Field>
        <Field label="浏览器标签名">
          <CodePill>{state.data.tabTitle.enabled ? '已启用' : '未启用'}</CodePill>
        </Field>
      </div>
    </Section>
  );
}
