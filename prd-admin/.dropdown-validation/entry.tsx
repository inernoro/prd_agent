import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '../src/components/ui/Dialog';
import { ItemSearchSelect } from '../src/components/ItemSearchSelect';
import '../src/styles/tailwind.css';
import '../src/styles/tokens.css';
import '../src/styles/globals.css';

const options = Array.from({ length: 120 }, (_, i) => ({ id: String(i), label: `模拟方案 ${i}` }));
function Fixture() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  return <main style={{ padding: 24 }}>
    <button onClick={() => setOpen(true)}>打开申领弹窗</button>
    <Dialog open={open} onOpenChange={setOpen} title="内部立项方案滚动回归" maxWidth={760} contentStyle={{ height: '85vh' }} content={<>
      <p style={{ marginBottom: 36 }}>使用真实 Dialog 与 ItemSearchSelect；仅模拟方案，不连接 API。</p>
      <ItemSearchSelect value={value} onChange={setValue} options={options} placeholder="搜索已有方案" countUnit="个方案" />
      <output data-testid="selection">{value}</output>
      <div style={{ height: 1000 }}>下层表单滚动区</div>
    </>} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
