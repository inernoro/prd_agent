/**
 * 知识库 3D 文档星系 —— 独立全屏页。
 *
 * 与「宇宙图」分离：直接从 URL :storeId 取库（不解析库列表，避免卡「正在加载知识库列表...」），
 * 用 fixed inset-0 盖住 AppShell 侧边栏，整屏交给 DocumentGalaxyView。
 * DocumentGalaxyView 内部已做「失败必报 + 超时 + WebGL ErrorBoundary」，
 * 本页只负责取库名标题 + 返回入口。
 *
 * 路由：/document-store/:storeId/galaxy（参数化子路由，navCoverage 自动豁免）。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { getDocumentStoreReal } from '@/services/real/documentStore';
import { DocumentGalaxyView } from './DocumentGalaxyView';

export function GalaxyStandalonePage() {
  const { storeId } = useParams();
  const navigate = useNavigate();
  const [storeName, setStoreName] = useState<string>('');

  // 取库名做标题；失败/拿不到就用 storeId 兜底（不阻断星系渲染）
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    getDocumentStoreReal(storeId)
      .then((res) => {
        if (cancelled) return;
        if (res.success) setStoreName(res.data.name || '');
        else console.error('[galaxy-standalone] 取库名失败', res.error);
      })
      .catch((e) => {
        if (!cancelled) console.error('[galaxy-standalone] 取库名异常', e);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  const back = () => {
    // 显式回到该库的关系图谱页（确定的应用内目的地）。不用 navigate(-1)：从书签/深链/
    // 登录 returnUrl 进来时 history 上一条可能是登录页或外站，会跳错（Codex P2）。
    if (storeId) {
      sessionStorage.setItem('doc-store-selected-id', storeId);
      navigate(`/document-store/${storeId}/universe`);
    } else {
      navigate('/document-store');
    }
  };

  const title = storeName || storeId || '文档星系';

  if (!storeId) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 60,
          background: '#0c0c12',
          color: '#ffd0d0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
        }}
      >
        缺少知识库 ID，无法打开星系。
      </div>
    );
  }

  return (
    <div
      className="flex flex-col"
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: '#0c0c12' }}
    >
      {/* 顶部工具条：返回 + 库名（type 图例在 DocumentGalaxyView 内部，避免重复） */}
      <div
        className="shrink-0"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <button
          onClick={back}
          style={{
            background: 'rgba(45,45,55,0.85)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            padding: '6px 10px',
            color: '#cfcfd6',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
          }}
        >
          <ArrowLeft size={13} /> 返回
        </button>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#eaeaf0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title} · 文档星系
        </div>
      </div>

      {/* 星系本体撑满剩余高度 */}
      <div className="flex-1 min-h-0">
        <DocumentGalaxyView storeId={storeId} storeName={storeName} />
      </div>
    </div>
  );
}

export default GalaxyStandalonePage;
