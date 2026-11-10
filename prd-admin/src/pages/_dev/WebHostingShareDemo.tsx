import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Moon, Pause, Play, Sun } from 'lucide-react';
import HostedShareCollection from '@/components/web-hosting/HostedShareCollection';
import type { ShareViewData } from '@/services/real/webPages';

const data: Pick<ShareViewData, 'title' | 'description' | 'sites'> = {
  title: '小团队发布约定',
  description: '从方案到交付，把同一件事的资料放在一起。',
  sites: [
    { id: 'demo-overview', title: '发布指南 · 小团队协作的三个约定', description: '从共同目标开始，让每一次交付都有清晰的方向。', totalSize: 39859 },
    { id: 'demo-notes', title: '会议纪要 · 本周行动与决策', description: '记录关键讨论、已达成的共识与下一步安排。', totalSize: 47923 },
    { id: 'demo-review', title: '工作流验收 · 从设计到发布', description: '逐项核对页面、文档与交付结果，保留完整验收记录。', totalSize: 38297 },
  ].map(site => ({ ...site, siteUrl: '', entryFile: 'index.html', entrySize: site.totalSize, fileCount: 9 })),
};
const sampleSites = Array.from({ length: 90 }, (_, index) => {
  const source = data.sites[index % data.sites.length];
  return index < 3 ? source : { ...source, id: `demo-document-${index + 1}`, title: `${source.title} · ${index + 1}` };
});

/** Isolated sample data; the public collection uses the same component. */
export default function WebHostingShareDemo() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [paused, setPaused] = useState(false);
  const [count, setCount] = useState(3);
  const [params] = useSearchParams();
  const current = sampleSites.find(site => site.id === params.get('siteId'));
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = theme;
    return () => {
      if (previous === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previous;
    };
  }, [theme]);
  const controls = <div className="hosted-share-demo-controls">
    <span>合集设计预览</span>
    <label>示例文档数量 <select aria-label="示例文档数量" value={count} onChange={event => setCount(Number(event.target.value))}>{[3, 12, 30, 90].map(value => <option key={value} value={value}>{value} 份</option>)}</select></label>
    <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{theme === 'dark' ? '切换浅色' : '切换深色'}</button>
    <button aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? <Play size={14} /> : <Pause size={14} />}{paused ? '播放背景' : '暂停背景'}</button>
  </div>;
  if (current) return <main className="hosted-share-demo-reader">
    {controls}
    <div className="hosted-share-demo-controls"><Link to="/_dev/web-hosting-share"><ArrowLeft size={14} />返回合集</Link><strong>{current.title}</strong><span>阅读页示意</span></div>
    <article><h1>{current.title}</h1><p>{current.description}</p><p>这里用于演示：从合集打开成员后，仍然保留网页托管阅读骨架。正式页面继续使用现有的关联文档、版本、批注与讨论功能。</p><p>本 Demo 使用示例内容，不创建或修改文档关联。</p></article>
  </main>;
  return <div className="hosted-share-demo">{controls}<HostedShareCollection data={{ ...data, sites: sampleSites.slice(0, count), mainSiteId: sampleSites[0].id }} collectionPath="/_dev/web-hosting-share" paused={paused}
    footer={<>示例资料 · 背景来自 <a href="https://reactbits.dev/backgrounds/threads" target="_blank" rel="noopener noreferrer">React Bits / Threads</a> · 支持减少动态效果偏好</>} /></div>;
}
