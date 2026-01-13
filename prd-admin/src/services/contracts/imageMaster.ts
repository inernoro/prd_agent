import type { ApiResponse } from '@/types/api';

export type ImageMasterSession = {
  id: string;
  ownerUserId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ImageMasterMessage = {
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

export type ImageMasterCanvas = {
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

export type ImageMasterWorkspace = {
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

export type ImageMasterViewport = {
  z: number;
  x: number;
  y: number;
  updatedAt?: string;
};

export type CreateImageMasterSessionContract = (input: { title?: string }) => Promise<ApiResponse<{ session: ImageMasterSession }>>;
export type ListImageMasterSessionsContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: ImageMasterSession[] }>>;
export type GetImageMasterSessionContract = (input: { id: string; messageLimit?: number; assetLimit?: number }) => Promise<ApiResponse<{ session: ImageMasterSession; messages: ImageMasterMessage[]; assets: ImageAsset[] }>>;
export type AddImageMasterMessageContract = (input: { sessionId: string; role: 'User' | 'Assistant'; content: string }) => Promise<ApiResponse<{ message: ImageMasterMessage }>>;
export type UploadImageAssetContract = (input: { data?: string; sourceUrl?: string; prompt?: string; width?: number; height?: number }) => Promise<ApiResponse<{ asset: ImageAsset }>>;
export type DeleteImageMasterAssetContract = (input: { id: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type GetImageMasterCanvasContract = (input: { id: string }) => Promise<ApiResponse<{ canvas: ImageMasterCanvas | null }>>;
export type SaveImageMasterCanvasContract = (input: { id: string; schemaVersion?: number; payloadJson: string; idempotencyKey?: string }) => Promise<ApiResponse<{ canvas: ImageMasterCanvas }>>;

export type ListImageMasterWorkspacesContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: ImageMasterWorkspace[] }>>;
export type CreateImageMasterWorkspaceContract = (input: { title?: string; scenarioType?: string; idempotencyKey?: string }) => Promise<ApiResponse<{ workspace: ImageMasterWorkspace }>>;
export type UpdateImageMasterWorkspaceContract = (input: {
  id: string;
  title?: string;
  memberUserIds?: string[];
  coverAssetId?: string | null;
  articleContent?: string;
  scenarioType?: string;
  folderName?: string | null;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ workspace: ImageMasterWorkspace }>>;
export type DeleteImageMasterWorkspaceContract = (input: { id: string; idempotencyKey?: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type GetImageMasterWorkspaceDetailContract = (input: { id: string; messageLimit?: number; assetLimit?: number }) => Promise<
  ApiResponse<{
    workspace: ImageMasterWorkspace;
    messages: ImageMasterMessage[];
    assets: ImageAsset[];
    canvas: ImageMasterCanvas | null;
    viewport?: ImageMasterViewport | null;
  }>
>;

export type SaveImageMasterWorkspaceViewportContract = (input: {
  id: string;
  z: number;
  x: number;
  y: number;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ viewport: ImageMasterViewport }>>;
export type AddImageMasterWorkspaceMessageContract = (input: { id: string; role: 'User' | 'Assistant'; content: string }) => Promise<
  ApiResponse<{ message: ImageMasterMessage }>
>;
export type GetImageMasterWorkspaceCanvasContract = (input: { id: string }) => Promise<ApiResponse<{ canvas: ImageMasterCanvas | null }>>;
export type SaveImageMasterWorkspaceCanvasContract = (input: {
  id: string;
  schemaVersion?: number;
  payloadJson: string;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ canvas: ImageMasterCanvas }>>;
export type UploadImageMasterWorkspaceAssetContract = (input: {
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

// -------- ImageMaster：生图任务化（服务端后台执行） --------

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
  initImageAssetSha256?: string;
};

export type CreateWorkspaceImageGenRunContract = (args: {
  id: string;
  input: CreateWorkspaceImageGenRunInput;
  idempotencyKey?: string;
}) => Promise<ApiResponse<{ runId: string }>>;

export type DeleteImageMasterWorkspaceAssetContract = (input: { id: string; assetId: string }) => Promise<ApiResponse<{ deleted: boolean }>>;

export type RefreshImageMasterWorkspaceCoverContract = (input: { id: string; limit?: number; idempotencyKey?: string }) => Promise<
  ApiResponse<{ workspace: ImageMasterWorkspace }>
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

