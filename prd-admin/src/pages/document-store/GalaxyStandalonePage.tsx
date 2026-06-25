/**
 * 知识库 3D 文档星系 —— 独立全屏页。
 *
 * 与「宇宙图」分离：直接从 URL :storeId 取库（不解析库列表，避免卡「正在加载知识库列表...」），
 * 用 fixed inset-0 盖住 AppShell 侧边栏，整屏交给 DocumentGalaxyView。
 * DocumentGalaxyView 内部已做「失败必报 + 超时 + WebGL ErrorBoundary」，
 * 本页负责顶部工具条：返回 + 关系链面包屑（中）+ 标题显示开关（右上）。
 *
 * 路由：/document-store/:storeId/galaxy（参数化子路由，navCoverage 自动豁免）。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDocumentStoreReal } from '@/services/real/documentStore';
import { DocumentGalaxyView, type GalaxyLabelMode } from './DocumentGalaxyView';

export function GalaxyStandalonePage() {
  const { storeId } = useParams();
  const navigate = useNavigate();
  const [storeName, setStoreName] = useState<string>('');
  // 标题显示模式：正文标题(frontmatter title / 首个标题，默认) ↔ 结构名(文件名/点分名)。
  const [labelMode, setLabelMode] = useState<GalaxyLabelMode>('content');

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
    // 单条顶栏现由 DocumentGalaxyView 自渲染（返回/库名/图例/统计/面包屑/搜索/开关合一），
    // 本页只做全屏容器 + 透传导航与显示模式。
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: '#0c0c12' }}>
      <DocumentGalaxyView
        storeId={storeId}
        storeName={title}
        labelMode={labelMode}
        onBack={back}
        onToggleLabelMode={() => setLabelMode((m) => (m === 'content' ? 'structural' : 'content'))}
      />
    </div>
  );
}

export default GalaxyStandalonePage;
