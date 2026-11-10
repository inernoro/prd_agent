import { Component, useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, FileCode2, Layers3 } from 'lucide-react';
import Threads from '@/components/reactbits/Threads';
import { useDataTheme } from '@/hooks/useDataTheme';
import type { ShareViewData } from '@/services/real/webPages';
import './HostedShareCollection.css';

const THREAD_COLORS: Record<'light' | 'dark', [number, number, number]> = {
  light: [0.16, 0.48, 0.38],
  dark: [0.35, 0.88, 0.69],
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
      {animate && !paused
        ? <BackgroundBoundary><Threads color={THREAD_COLORS[theme]} amplitude={1.1} distance={0.2} /></BackgroundBoundary>
        : <svg className="hosted-share-still-threads" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 24 }, (_, index) => <path key={index}
            d={`M -160 ${430 + index * 8} C 240 ${220 + index * 8}, 360 ${800 + index * 5}, 780 ${570 + index * 7} S 1200 ${200 + index * 8}, 1600 ${470 + index * 6}`} />)}
        </svg>}
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
  const first = data.sites[0];
  const memberHref = (id: string) => `${collectionPath}?${new URLSearchParams({ siteId: id })}`;
  return <main className="hosted-share-collection">
    <HostedShareBackground paused={paused} />
    <section className="hosted-share-content" aria-label="站点合集">
      <div className="hosted-share-topbar">
        <div className="hosted-share-brand"><span><Layers3 size={20} strokeWidth={1.5} /></span>网页托管<i />共享合集</div>
        {action}
      </div>
      <div className="hosted-share-layout">
        <header className="hosted-share-heading">
          <div className="hosted-share-eyebrow"><span />一份合集，一起阅读</div>
          <div className="hosted-share-title-row">
          <h1>{data.title || `${data.sites.length} 个站点合集`}</h1>
          </div>
          <p className="hosted-share-description">{data.description || '选择一份文档，在阅读页中查看内容、版本与讨论。'}</p>
          {first && <a className="hosted-share-start" href={memberHref(first.id)} target="_blank" rel="noopener noreferrer">开始阅读<ArrowUpRight size={18} /></a>}
          <div className="hosted-share-cover-note"><span className="hosted-share-cover-line" /><span>把资料放在一起<br />让上下文完整延续</span></div>
        </header>
        <section className="hosted-share-directory" aria-label="合集目录">
          <div className="hosted-share-directory-heading"><div><span className="hosted-share-directory-label">CONTENTS</span><h2>合集目录</h2></div><div className="hosted-share-count"><strong>{String(data.sites.length).padStart(2, '0')}</strong><span>份内容</span></div></div>
          <div className="hosted-share-members">
        {data.sites.map((site, index) => <a key={site.id} className="hosted-share-member"
          href={memberHref(site.id)} target="_blank" rel="noopener noreferrer">
          <div className="hosted-share-file-icon">
            {site.coverImageUrl ? <img src={site.coverImageUrl} alt="" /> : <div className="hosted-share-paper" aria-hidden="true"><FileCode2 size={13} strokeWidth={1.4} /><span className="hosted-share-paper-lines" /><span>{String(index + 1).padStart(2, '0')}</span></div>}
          </div>
          <div className="hosted-share-member-text">
            <span className="hosted-share-member-number">文档 {String(index + 1).padStart(2, '0')}</span>
            <h2>{site.title}</h2>
            {site.description && <p>{site.description}</p>}
            <div className="hosted-share-file-meta">{site.fileCount} 个文件<span>·</span>{formatSize(site.totalSize)}</div>
          </div>
          <ArrowUpRight className="hosted-share-open-icon" size={19} aria-label="在新标签页打开阅读页" />
        </a>)}
          </div>
          <div className="hosted-share-directory-footer"><span>内容、版本与讨论，都在阅读页里</span><ArrowRight size={16} /></div>
        </section>
      </div>
      <footer className="hosted-share-footer">{footer ?? '网页托管 · 内容与讨论，留在同一个阅读页'}</footer>
    </section>
  </main>;
}
