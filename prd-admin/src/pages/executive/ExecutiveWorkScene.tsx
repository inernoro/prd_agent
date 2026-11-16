import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, ImageOff, ArrowUpRight } from 'lucide-react';
import {
  getMobileAssets,
  listRecentDocumentEntries,
  getDocumentEntry,
} from '@/services';
import type { MobileAssetItem } from '@/services/contracts/mobile';
import { useAuthStore } from '@/stores/authStore';
import {
  PersonAvatar,
  WorkspacePanel,
  WorkspaceEmpty,
  WorkspaceLink,
} from '@/components/workspace/Workspace';
import { Dialog } from '@/components/ui/Dialog';
import { HomeTaskQueue } from '@/components/workspace/HomeTaskQueue';
import { withDocumentStoreEntry } from '@/pages/document-store/documentStoreDeepLink';
import { useExecutiveQuery } from './useExecutiveQuery';
import { stripMarkdown } from '@/lib/stripMarkdown';
import { ok } from '@/types/api';

const readImages = () => getMobileAssets({ category: 'image', limit: 4 });
const readKnowledge = () => listRecentDocumentEntries(2);
// Preview details are optional and independent of the global statistics request.
const readPreviews = async () => {
  const response = await readKnowledge();
  if (!response.success) return response;
  const items = await Promise.all(
    response.data.items.map(async (entry) => {
      try {
        const detail = await getDocumentEntry(entry.id);
        return {
          ...entry,
          summary: detail.success ? detail.data.summary : undefined,
        };
      } catch {
        return { ...entry, summary: undefined };
      }
    }),
  );
  return ok({ items });
};
const shortDate = (date: string) => new Date(date).toLocaleDateString('zh-CN');

function AssetImage({ asset }: { asset: MobileAssetItem }) {
  const [failed, setFailed] = useState(false);
  return !failed && (asset.thumbnailUrl || asset.url) ? (
    <img
      src={asset.thumbnailUrl || asset.url!}
      alt={asset.title}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="scene-image-fallback">
      <ImageOff size={24} />
      预览不可用
    </span>
  );
}

export function ExecutiveWorkScene({ revision = 0 }: { revision?: number }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  const root = useAuthStore((s) => s.isRoot);
  const can = (permission: string) =>
    root || permissions.includes('super') || permissions.includes(permission);
  const assetsAllowed = can('assets.read');
  const knowledgeAllowed =
    can('document-store.read') || can('document-store.write');
  const images = useExecutiveQuery(readImages, 0, assetsAllowed, revision);
  const knowledge = useExecutiveQuery(
    readPreviews,
    0,
    knowledgeAllowed,
    revision,
  );
  const [preview, setPreview] = useState<MobileAssetItem>();
  return (
    <div className="scene-work">
      <div className="scene-owner ws-person">
        <PersonAvatar
          person={{
            displayName: user?.displayName || '我',
            avatarFileName: user?.avatarFileName,
            avatarUrl: user?.avatarUrl,
          }}
          size={28}
        />
        <strong>我的工作对象 · {user?.displayName || '当前账号'}</strong>
      </div>
      {assetsAllowed && (
        <WorkspacePanel
          title="我的最近图片"
          hint="当前账号的图像资源 · 不受平台统计时间范围筛选"
          action={
            <WorkspaceLink onClick={() => navigate('/assets')}>
              全部资源
            </WorkspaceLink>
          }
        >
          {images.error && (
            <p role="status" className="ws-alert">
              图片读取失败{images.data ? '，保留上次结果' : `：${images.error}`}
            </p>
          )}
          <div className="scene-images">
            {images.data?.items.map((asset) => (
              <button
                className="scene-image-card"
                key={asset.id}
                onClick={() => setPreview(asset)}
              >
                <AssetImage asset={asset} />
                <strong>
                  <span>{asset.title || '未命名图片'}</span>
                  <ArrowUpRight size={13} />
                </strong>
                <small>
                  <span>{asset.source || '来源未记录'}</span>
                  <time>{shortDate(asset.createdAt)}</time>
                </small>
              </button>
            ))}
          </div>
          {!images.data?.items.length && (
            <WorkspaceEmpty
              title={
                images.loading
                  ? '图片读取中'
                  : images.error
                    ? '图片暂不可用'
                    : '还没有图像资源'
              }
              description="创建或上传的图片将在这里展示。"
            />
          )}
        </WorkspacePanel>
      )}
      {knowledgeAllowed && (
        <WorkspacePanel
          title="最近更新的知识"
          hint="我可访问的个人与团队知识 · 按更新时间排列"
          action={
            <WorkspaceLink
              onClick={() => navigate('/document-store?tab=recent')}
            >
              知识库
            </WorkspaceLink>
          }
        >
          {knowledge.error && (
            <p role="status" className="ws-alert">
              知识读取失败
              {knowledge.data ? '，保留上次结果' : `：${knowledge.error}`}
            </p>
          )}
          <div className="scene-documents">
            {knowledge.data?.items.map((entry) => (
              <button
                className="scene-document"
                key={entry.id}
                onClick={() =>
                  navigate(
                    `/document-store${withDocumentStoreEntry('', entry.storeId, entry.id)}`,
                  )
                }
              >
                <header>
                  <FileText size={20} />
                  <span>
                    <strong>{entry.title}</strong>
                    <small>{entry.storeName}</small>
                  </span>
                  <ArrowUpRight size={14} />
                </header>
                {entry.summary ? (
                  <p>
                    {stripMarkdown(entry.summary).replace(
                      /(^|\s)#{1,6}\s+/g,
                      '$1',
                    )}
                  </p>
                ) : (
                  <p className="scene-doc-no-summary">打开阅读正文</p>
                )}
                <footer>
                  <span>
                    {entry.contentType || '文档'}
                    {entry.tags?.length
                      ? ` · ${entry.tags.slice(0, 3).join(' / ')}`
                      : ''}
                  </span>
                  <time>更新于 {shortDate(entry.updatedAt)}</time>
                </footer>
              </button>
            ))}
          </div>
          {!knowledge.data?.items.length && (
            <WorkspaceEmpty
              title={
                knowledge.loading
                  ? '知识读取中'
                  : knowledge.error
                    ? '知识暂不可用'
                    : '暂无可访问的知识'
              }
            />
          )}
        </WorkspacePanel>
      )}
      {can('active-tasks.use') && <HomeTaskQueue />}
      {!assetsAllowed && !knowledgeAllowed && !can('active-tasks.use') && (
        <WorkspaceEmpty
          title="当前账号暂无工作对象访问权限"
          description="平台汇总和右侧成员统计仍可查看。"
        />
      )}
      <div className="scene-owner ws-person">
        <PersonAvatar
          person={{
            displayName: user?.displayName || '我',
            avatarFileName: user?.avatarFileName,
            avatarUrl: user?.avatarUrl,
          }}
          size={22}
        />
        <span>图片与任务属于当前账号；知识包含已授权的团队内容。</span>
      </div>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
        title={
          <span className="scene-preview-title" title={preview?.title}>
            {preview?.title || '图片预览'}
          </span>
        }
        maxWidth={1000}
        content={
          preview ? (
            <div className="scene-preview-content">
              <AssetImage asset={{ ...preview, thumbnailUrl: undefined }} />
              <WorkspaceLink
                onClick={() => {
                  setPreview(undefined);
                  navigate('/assets');
                }}
              >
                在资源管理中继续
              </WorkspaceLink>
            </div>
          ) : null
        }
      />
    </div>
  );
}
