import { Component, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, FileCode2, Layers3 } from 'lucide-react';
import Threads from '@/components/reactbits/Threads';
import { useDataTheme } from '@/hooks/useDataTheme';
import type { ShareViewData } from '@/services/real/webPages';
import './HostedShareCollection.css';

const THREAD_COLORS: Record<'light' | 'dark', [number, number, number]> = {
  light: [0.25, 0.46, 0.42],
  dark: [0.34, 0.65, 0.59],
};

// Canvas is decoration. A browser without WebGL must still show the collection.
class BackgroundBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export function HostedShareBackground({ paused = false }: { paused?: boolean }) {
  const theme = useDataTheme();
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAnimate(!motion.matches && !document.hidden);
    update();
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return <div className="hosted-share-background" aria-hidden="true">
    <div className="hosted-share-threads">
      {animate && !paused && <BackgroundBoundary><Threads color={THREAD_COLORS[theme]} amplitude={0.45} distance={0.35} /></BackgroundBoundary>}
    </div>
  </div>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The demo and public collection use the same cards and member links. */
export default function HostedShareCollection({ data, collectionPath, action, paused = false, footer }: {
  data: Pick<ShareViewData, 'title' | 'description' | 'sites'>;
  collectionPath: string;
  action?: ReactNode;
  paused?: boolean;
  footer?: ReactNode;
}) {
  return <main className="hosted-share-collection">
    <HostedShareBackground paused={paused} />
    <section className="hosted-share-content" aria-label="站点合集">
      <header className="hosted-share-heading">
        <div className="hosted-share-eyebrow"><Layers3 size={15} />网页托管 <span>/</span> 共享合集</div>
        <div className="hosted-share-title-row">
          <h1>{data.title || `${data.sites.length} 个站点合集`}</h1>
          {action}
        </div>
        {data.description && <p className="hosted-share-description">{data.description}</p>}
        <p className="hosted-share-count">{data.sites.length} 个站点<span>点击卡片，在阅读页打开</span></p>
      </header>
      <div className="hosted-share-members">
        {data.sites.map((site, index) => <a key={site.id} className="hosted-share-member"
          href={`${collectionPath}?${new URLSearchParams({ siteId: site.id })}`} target="_blank" rel="noopener noreferrer">
          <div className="hosted-share-file-icon">
            {site.coverImageUrl ? <img src={site.coverImageUrl} alt="" /> : <FileCode2 size={23} strokeWidth={1.5} />}
          </div>
          <div className="hosted-share-member-text">
            <h2>{site.title}</h2>
            {site.description && <p>{site.description}</p>}
            <div className="hosted-share-file-meta">{site.fileCount} 个文件<span>·</span>{formatSize(site.totalSize)}</div>
          </div>
          <span className="hosted-share-member-number">{String(index + 1).padStart(2, '0')}</span>
          <ArrowUpRight className="hosted-share-open-icon" size={19} aria-label="在新标签页打开阅读页" />
        </a>)}
      </div>
      <footer className="hosted-share-footer">{footer ?? '网页托管 · 内容与讨论，留在同一个阅读页'}</footer>
    </section>
  </main>;
}
