import type { ApiResponse } from '@/types/api';

export type VisualAgentSession = {
  id: string;
  ownerUserId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type VisualAgentMessage = {
  id: string;
  sessionId: string;
  workspaceId?: string;
  ownerUserId: string;
  role: 'User' | 'Assistant';
  content: string;
  createdAt: string;
};

export type ImageAsset = {
  id: string;
  ownerUserId: string;
  workspaceId?: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  url: string;
  prompt?: string | null;
  createdAt: string;
  articleInsertionIndex?: number | null;
  originalMarkerText?: string | null;
};

export type VisualAgentCanvas = {
  id: string;
  sessionId?: string;
  workspaceId?: string;
  schemaVersion: number;
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
};

export type ArticleIllustrationMarker = {
  index: number;
  text: string;
};

export type ArticleIllustrationWorkflow = {
  version: number;
  phase: number; // 0=Upload, 1=Editing, 2=MarkersGenerated
  markers: ArticleIllustrationMarker[];
  expectedImageCount?: number | null;
  doneImageCount: number;
  assetIdByMarkerIndex: Record<string, string>;
  updatedAt: string;
};

export type VisualAgentWorkspace = {
  id: string;
  ownerUserId: string;
  title: string;
  scenarioType?: 'image-gen' | 'article-illustration' | 'other';
  memberUserIds: string[];
  coverAssetId?: string | null;
  coverAssetIds?: string[];
  /** 列表封面拼贴资源（由后端 list/refresh 聚合返回） */
  coverAssets?: Array<{ id: string; url: string; width: number; height: number }>;
  canvasHash?: string | null;
  assetsHash?: string | null;
  contentHash?: string | null;
  coverHash?: string | null;
  coverStale?: boolean;
  coverUpdatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string | null;
  articleContent?: string | null;
  articleContentWithMarkers?: string | null;
  /** 文章配图 workflow（服务端状态机，前端用于恢复进度/禁止跳未来） */
  articleWorkflow?: ArticleIllustrationWorkflow | null;
  /** 文件夹名称（用于分组显示） */
  folderName?: string | null;
};

export type VisualAgentViewport = {
  z: number;
  x: number;
  y: number;
  updatedAt?: string;
};

export type CreateVisualAgentSessionContract = (input: { title?: string }) => Promise<ApiResponse<{ session: VisualAgentSession }>>;
export type ListVisualAgentSessionsContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: VisualAgentSession[] }>>;
export type GetVisualAgentSessionContract = (input: { id: string; messageLimit?: number; assetLimit?: number }) => Promise<ApiResponse<{ session: VisualAgentSession; messages: VisualAgentMessage[]; assets: ImageAsset[] }>>;
export type AddVisualAgentMessageContract = (input: { sessionId: string; role: 'User' | 'Assistant'; content: string }) => Promise<ApiResponse<{ message: VisualAgentMessage }>>;
export type UploadImageAssetContract = (input: { data?: string; sourceUrl?: string; prompt?: string; width?: number; height?: number }) => Promise<ApiResponse<{ asset: ImageAsset }>>;
export type DeleteVisualAgentAssetContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type GetVisualAgentCanvasContract = (input: { id: string }) => Promise<ApiResponse<{ canvas: VisualAgentCanvas | null }>>;
export type SaveVisualAgentCanvasContract = (input: { id: string; schemaVersion?: number; payloadJson: string; idempotencyKey?: string }) => Promise<ApiResponse<{ canvas: VisualAgentCanvas }>>;

export type ListVisualAgentWorkspacesContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: VisualAgentWorkspace[] }>>;
export type CreateVisualAgentWorkspaceContract = (input: { title?: string; scenarioType?: string; idempotencyKey?: string }) => Promise<ApiResponse<{ workspace: VisualAgentWorkspace }>>;
export type UpdateVisualAgentWorkspaceContract = (input: {
  id: string;
  title?: string;
  memberUserIds?: string[];
  coverAssetId?: string | null;
  articleContent?: string;
  scenarioType?: string;
  folderName?: string | null;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ workspace: VisualAgentWorkspace }>>;
export type DeleteVisualAgentWorkspaceContract = (input: { id: string; idempotencyKey?: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type GetVisualAgentWorkspaceDetailContract = (input: { id: string; messageLimit?: number; assetLimit?: number }) => Promise<
  ApiResponse<{
    workspace: VisualAgentWorkspace;
    messages: VisualAgentMessage[];
    assets: ImageAsset[];
    canvas: VisualAgentCanvas | null;
    viewport?: VisualAgentViewport | null;
  }>
>;

export type SaveVisualAgentWorkspaceViewportContract = (input: {
  id: string;
  z: number;
  x: number;
  y: number;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ viewport: VisualAgentViewport }>>;
export type AddVisualAgentWorkspaceMessageContract = (input: { id: string; role: 'User' | 'Assistant'; content: string }) => Promise<
  ApiResponse<{ message: VisualAgentMessage }>
>;
export type GetVisualAgentWorkspaceCanvasContract = (input: { id: string }) => Promise<ApiResponse<{ canvas: VisualAgentCanvas | null }>>;
export type SaveVisualAgentWorkspaceCanvasContract = (input: {
  id: string;
  schemaVersion?: number;
  payloadJson: string;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ canvas: VisualAgentCanvas }>>;
export type UploadVisualAgentWorkspaceAssetContract = (input: {
  id: string;
  data?: string;
  sourceUrl?: string;
  prompt?: string;
  width?: number;
  height?: number;
  articleInsertionIndex?: number;
  originalMarkerText?: string;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ asset: ImageAsset }>>;

// -------- VisualAgent：生图任务化（服务端后台执行） --------

export type CreateWorkspaceImageGenRunInput = {
  prompt: string;
  targetKey: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  configModelId?: string;
  platformId?: string;
  modelId?: string;
  size?: string;
  responseFormat?: 'url' | 'b64_json';
  /** 单图场景向后兼容 */
  initImageAssetSha256?: string;
  /** 多图引用列表（新架构） */
  imageRefs?: ImageRefForBackend[];
  /** 局部重绘蒙版（data URI，白色=重绘区域，黑色=保持） */
  maskBase64?: string;
};

/** 图片引用（发送给后端） */
export type ImageRefForBackend = {
  /** 引用 ID，对应 @img1, @img2 中的数字 */
  refId: number;
  /** 图片资产 SHA256 */
  assetSha256: string;
  /** 图片 URL（备用） */
  url: string;
  /** 用户标签 */
  label: string;
  /** 可选角色 */
  role?: 'target' | 'reference' | 'style' | 'background';
};

export type CreateWorkspaceImageGenRunContract = (args: {
  id: string;
  input: CreateWorkspaceImageGenRunInput;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ runId: string }>>;

export type DeleteVisualAgentWorkspaceAssetContract = (input: { id: string; assetId: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type RefreshVisualAgentWorkspaceCoverContract = (input: { id: string; limit?: number; idempotencyKey?: string }) => Promise<
  ApiResponse<{ workspace: VisualAgentWorkspace }>
>;

// -------- 文章配图场景专用接口 --------

export type ArticleMarker = {
  index: number;
  text: string;
  startPos: number;
  endPos: number;
};

export type GenerateArticleMarkersContract = (input: {
  id: string;
  articleContent: string;
  userInstruction?: string;
  idempotencyKey?: string;
}) => AsyncIterable<{ type: string; text?: string; fullText?: string; message?: string }>;

export type ExtractArticleMarkersContract = (input: {
  id: string;
  articleContentWithMarkers: string;
}) => Promise<ApiResponse<{ markers: ArticleMarker[] }>>;

export type ExportArticleContract = (input: {
  id: string;
  useCdn: boolean;
  exportFormat?: string;
}) => Promise<ApiResponse<{ content: string; format: string; assetCount: number }>>;
