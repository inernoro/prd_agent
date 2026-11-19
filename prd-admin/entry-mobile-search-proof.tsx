import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsciousnessHome } from './src/components/effects/ConsciousnessHome';
import type { ToolboxItem } from './src/services';
import './src/styles/tailwind.css';
import './src/styles/tokens.css';
import './src/styles/globals.css';

function Probe() {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const results = Array.from({ length: 8 }, (_, i) => ({
    id: String(i + 1), name: `验收能力 ${i + 1}`,
    description: '用于对照手机端的可见搜索结果。',
  })) as ToolboxItem[];
  return <ConsciousnessHome query={query} onQueryChange={setQuery} results={results} shortcuts={[]}
    onOpen={item => { document.body.dataset.opened = item.id; }} onShowDesk={() => {}}
    displayName="" searchRef={searchRef} loading={false} />;
}

createRoot(document.getElementById('root')!).render(<Probe />);
