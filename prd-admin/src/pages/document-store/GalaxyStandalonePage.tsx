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
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ToggleLeft, ToggleRight } from 'lucide-react';
import { getDocumentStoreReal } from '@/services/real/documentStore';
import {
  DocumentGalaxyView,
  type GalaxyCrumb,
  type GalaxyLabelMode,
} from './DocumentGalaxyView';

export function GalaxyStandalonePage() {
  const { storeId } = useParams();
  const navigate = useNavigate();
  const [storeName, setStoreName] = useState<string>('');
  // 标题显示模式：结构名(文件名/点分名，默认) ↔ 正文标题(frontmatter title / 首个标题)。
  const [labelMode, setLabelMode] = useState<GalaxyLabelMode>('structural');
  // 关系链面包屑（DocumentGalaxyView 上报：聚焦枢纽 / 打开文档时的根→当前路径）。
  const [crumbs, setCrumbs] = useState<GalaxyCrumb[]>([]);
  // 命令式打开文档（点面包屑里的叶子）。
  const openEntryRef = useRef<((entryId: string) => void) | null>(null);

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
      {/* 顶部工具条：返回 + 库名（左）｜ 关系链面包屑（中）｜ 标题显示开关（右上） */}
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
            flexShrink: 0,
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
            flexShrink: 0,
            fontSize: 14,
            fontWeight: 600,
            color: '#eaeaf0',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </div>

        {/* 关系链面包屑：占据中部、居中。空态给提示，避免空旷。 */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            overflow: 'hidden',
          }}
        >
          {crumbs.length === 0 ? (
            <span style={{ fontSize: 12, color: '#6a6c7a' }}>点枢纽或文档，这里显示所在关系链</span>
          ) : (
            crumbs.map((c, i) => {
              const isLast = i === crumbs.length - 1;
              const clickable = c.kind === 'leaf' && !!c.entryId;
              return (
                <span key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  {i > 0 && <span style={{ color: '#4d4f5c', fontSize: 12 }}>/</span>}
                  <span
                    onClick={clickable ? () => openEntryRef.current?.(c.entryId!) : undefined}
                    title={c.name}
                    style={{
                      fontSize: 12.5,
                      color: isLast ? '#eef0f6' : '#9a9cab',
                      fontWeight: isLast ? 600 : 400,
                      cursor: clickable ? 'pointer' : 'default',
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.name}
                  </span>
                </span>
              );
            })
          )}
        </div>

        {/* 标题显示开关（右上）：结构名 ↔ 正文标题。复用 DocBrowser 的语义与口径。 */}
        <button
          type="button"
          onClick={() => setLabelMode((m) => (m === 'content' ? 'structural' : 'content'))}
          title={
            labelMode === 'content'
              ? '当前：显示正文标题（正文第一行 / frontmatter title）。点击切回结构名'
              : '当前：显示结构名（文件名 / 点分命名）。点击切到正文标题'
          }
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(45,45,55,0.85)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            padding: '6px 10px',
            color: '#cfcfd6',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {labelMode === 'content' ? (
            <ToggleRight size={14} style={{ color: '#8ab4ff' }} />
          ) : (
            <ToggleLeft size={14} />
          )}
          {labelMode === 'content' ? '正文标题' : '结构名'}
        </button>
      </div>

      {/* 星系本体撑满剩余高度 */}
      <div className="flex-1 min-h-0">
        <DocumentGalaxyView
          storeId={storeId}
          storeName={storeName}
          labelMode={labelMode}
          onContextChange={(ctx) => setCrumbs(ctx.crumbs)}
          openEntryRef={openEntryRef}
        />
      </div>
    </div>
  );
}

export default GalaxyStandalonePage;
