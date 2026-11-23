import { useEffect, useState, type RefObject } from 'react';
import { ArrowRight, ChevronDown, Search, X } from 'lucide-react';
import { finishEntryArrival } from './entryArrival';
import type { ToolboxItem } from '@/services';
import { ConsciousnessHud, ConsciousnessScene, clearConsciousnessArrival, isConsciousnessArrival } from './ConsciousnessScene';

type Props = {
  query: string;
  onQueryChange: (query: string) => void;
  results: ToolboxItem[];
  shortcuts: ToolboxItem[];
  onOpen: (item: ToolboxItem) => void;
  onShowDesk: () => void;
  searchRef: RefObject<HTMLInputElement>;
  displayName: string;
  loading: boolean;
};

export function ConsciousnessHome({ query, onQueryChange, results, shortcuts, onOpen, onShowDesk, searchRef, displayName, loading }: Props) {
  const [arriving] = useState(isConsciousnessArrival);
  useEffect(() => { if (arriving) clearConsciousnessArrival(); }, [arriving]);
  const open = (item: ToolboxItem) => { finishEntryArrival(); onOpen(item); };
  return (
    <section className={`consciousness-home${arriving ? ' is-entering' : ''}`} aria-label="沉浸首页">
      <ConsciousnessScene />
      <ConsciousnessHud />
      <div className="consciousness-home-center">
        <div className="consciousness-home-heading"><span className="consciousness-sigil" aria-hidden="true">M</span><h1>探索未至之境</h1></div>
        <p className="consciousness-home-subtitle">{displayName ? `${displayName}，` : ''}选择智能体，开始创造</p>
        <div className="consciousness-search">
          <label className="consciousness-search-field"><Search size={17} aria-hidden="true" />
            <input ref={searchRef} type="search" value={query} onChange={e => onQueryChange(e.target.value)}
              aria-label="搜索智能体、工具或平台能力" placeholder="搜索智能体、工具或平台能力"
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && results.length) open(results[0]);
                if (e.key === 'Escape') { onQueryChange(''); e.currentTarget.blur(); }
              }} />
            {query ? <button type="button" aria-label="清空搜索" onClick={() => { onQueryChange(''); searchRef.current?.focus(); }}><X size={16} /></button> : <kbd>/</kbd>}
          </label>
          <div className="consciousness-search-footer"><span>{query ? `${results.length} 项匹配能力` : '连接想法与行动'}</span><span>{query ? '回车打开第一项' : 'MAP / WORKSPACE'}</span></div>
          {query.trim() && <div className="consciousness-search-results" role="region" aria-label="搜索结果">
            {loading && !results.length ? <p role="status">正在读取可用能力…</p> : results.length ? results.map(item => (
              <button type="button" key={item.id} onClick={() => open(item)}><span><strong>{item.name}</strong><small>{item.description}</small></span><ArrowRight size={15} aria-hidden="true" /></button>
            )) : <p>没有匹配的能力，换个关键词试试。</p>}
          </div>}
        </div>
        {!query && <nav className="consciousness-shortcuts" aria-label="快捷开始">{shortcuts.map(item => <button type="button" key={item.id} onClick={() => open(item)}>{item.name.replace('智能体', '')}<ArrowRight size={12} aria-hidden="true" /></button>)}</nav>}
      </div>
      <button type="button" className="consciousness-open-desk" onClick={() => { finishEntryArrival(); onShowDesk(); }}><span />展开工作台<ChevronDown size={14} /><span /></button>
    </section>
  );
}
