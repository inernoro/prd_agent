import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Moon, SlidersHorizontal, Share2, Waves } from 'lucide-react';
import { WritingThreads } from '../document-store/writing/WritingThreads';
import type { ReactNode } from 'react';
import '../document-store/writing/writing.css';
import './collections.css';

export function CollectionThemeButton() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme);
  return <button className="btn ghost" aria-label="切换明暗主题" onClick={() => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light'; setTheme(root.dataset.theme);
  }}><Moon size={15} /><span className="hc-theme-label">{theme === 'light' ? '浅色' : '深色'}</span></button>;
}
export function CollectionLogo() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M7 15V9l5 4 5-4v6" /></svg>;
}
export function CollectionShell({ mode = 'read', name, shareHref, onManage, children, backHref = '/web-pages/collections' }: {
  mode?: 'read' | 'share'; name: string; shareHref?: string; onManage?: () => void; children: ReactNode; backHref?: string;
}) {
  const [paused, setPaused] = useState(false);
  return <div className={`hosted-collection hcol-${mode}`} data-collection-page={mode}>
    <WritingThreads collection paused={paused} /><header className="hc-top"><div className="hc-crumb"><Link to="/web-pages" aria-label="网页托管"><CollectionLogo /></Link><Link to="/web-pages">网页托管</Link><span>/</span><Link to="/web-pages/collections">合集</Link><span>/</span><span>{name}</span>{mode === 'share' && <><span>/</span><span>分享</span></>}</div><div className="hc-tools"><button className="btn ghost" aria-label="动态背景" aria-pressed={!paused} onClick={() => setPaused(value => !value)}><Waves size={16} />{paused ? '静止' : '动态'}</button><CollectionThemeButton />{shareHref && <Link className="btn" to={shareHref}><Share2 size={14} />分享</Link>}{onManage && <button className="btn" onClick={onManage}><SlidersHorizontal size={14} />管理合集</button>}{mode === 'share' && <Link className="btn" to={backHref}>返回阅读页</Link>}</div></header>
    <header className="hc-mobile-top"><Link to="/web-pages" aria-label="网页托管"><CollectionLogo /></Link><span className="mono">{mode === 'share' ? '网页托管 · 分享合集' : '网页托管 · 合集'}</span><CollectionThemeButton /></header>
    {children}
  </div>;
}
export const collectionDate = (value?: string) => value ? new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace('/', '-') : '—';
