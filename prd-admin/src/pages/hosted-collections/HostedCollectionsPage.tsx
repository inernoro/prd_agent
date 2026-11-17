import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { listHostedCollections, restoreHostedCollection } from '@/services/real/hostedCollections';
import type { HostedCollection } from '@/services/contracts/hostedCollections';
import { CollectionShell, collectionDate } from './CollectionShell';
import { HostedCollectionManage } from './HostedCollectionManage';

export default function HostedCollectionsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<HostedCollection[]>();
  const [dissolved, setDissolved] = useState(false);
  const [create, setCreate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => { const r = await listHostedCollections(dissolved); if (r.success) { setItems(r.data.items); setError(''); } else setError(r.error.message); }, [dissolved]);
  useEffect(() => { void load(); }, [load]);
  async function restore(item: HostedCollection) { setBusy(item.id); const r = await restoreHostedCollection(item.id, item.version); setBusy(''); if (r.success) navigate(`/web-pages/collections/${item.id}`); else setError(r.error.message); }
  return <CollectionShell name="我的合集"><main className="scroll hc-index"><div className="hc-between"><div><h1 className="serif">我的合集</h1><p>把托管文档编成阅读路径，从主文档开始。</p></div><button className="btn pri" onClick={() => setCreate(true)}><Plus size={14} />新建合集</button></div><div className="seg"><button aria-pressed={!dissolved} onClick={() => setDissolved(false)}>我的合集</button><button aria-pressed={dissolved} onClick={() => setDissolved(true)}>已解散</button></div>{error && <div className="hc-error" role="alert">{error}<button className="btn" onClick={() => void load()}>重试</button></div>}{!items ? <MapSectionLoader text="正在读取合集…" /> : !items.length ? <div className="panel hc-index-empty"><h2 className="serif">{dissolved ? '没有已解散的合集' : '还没有合集'}</h2><p>{dissolved ? '解散后的合集可在30天内恢复，原文档始终保留。' : '选择你的托管文档，指定主文档，再调整阅读顺序。原文档、权限和批注保持独立。'}</p>{!dissolved && <button className="btn pri" onClick={() => setCreate(true)}>新建合集</button>}</div> : <div className="hc-index-grid">{items.map(item => <article className="panel" key={item.id}><span className="mono hc-meta">{item.siteIds.length} 份文档 · 更新于 {collectionDate(item.updatedAt)}</span><h2 className="serif">{item.dissolvedAt ? item.name : <Link to={`/web-pages/collections/${item.id}`}>{item.name}</Link>}</h2><p>{item.description}</p>{item.dissolvedAt && <button className="btn" disabled={!!busy || Date.now() - Date.parse(item.dissolvedAt) > 30 * 86400000} onClick={() => void restore(item)}>{busy === item.id ? '正在恢复…' : '30 天内恢复合集'}</button>}</article>)}</div>}</main>{create && <HostedCollectionManage onClose={() => setCreate(false)} onSaved={data => navigate(`/web-pages/collections/${data.collection.id}`)} />}</CollectionShell>;
}
