import type { WritingTemplate } from './writing';
export interface HostedCollectionSection { id: string; title: string; siteIds: string[] }
export interface HostedCollection {
  id: string; ownerUserId?: string; ownerName?: string; name: string; description: string;
  siteIds: string[]; mainSiteId: string; sections: HostedCollectionSection[]; version: number;
  updatedAt?: string; createdAt?: string; dissolvedAt?: string;
}
export interface HostedCollectionItem {
  siteUrl?: string; entryFile?: string; wrappedAssetType?: string; contentShape?: 'self-contained-html' | 'multi-file';
  id: string; title: string; summary?: string; excerpt?: string; headings?: string[];
  characterCount?: number; commentCount?: number; annotationCount?: number; discussionCount?: number; versionNumber?: number;
  templateId?: string; type?: string; ownerUserId?: string; author?: string; updatedAt?: string;
  version?: string; visibility?: string; sharedTeamIds?: string[]; groupId?: string;
  canShare: boolean; canEdit: boolean; unavailable?: boolean;
  memberships?: { id: string; name: string }[];
}
export interface HostedCollectionView {
  collection: HostedCollection; items: HostedCollectionItem[]; canManage: boolean; shareToken?: string;
  templates?: WritingTemplate[];
  related?: { items: { id: string; title: string; updatedAt?: string; href: string; isManual: boolean; mentions?: { label: string; authorName: string }[] }[] };
}
export interface HostedCollectionCandidates {
  items: HostedCollectionItem[]; templates: WritingTemplate[];
  legacy: { id: string; name: string; siteIds: string[]; mainSiteId: string }[];
}
export interface HostedCollectionPermission {
  id: string; title: string; visibility?: string; sharedTeamIds?: string[]; canShare: boolean;
  canSync: boolean; matches: boolean; differences?: string[];
}
export interface HostedCollectionPermissions { fingerprint: string; items: HostedCollectionPermission[] }
export interface HostedCollectionShare {
  id: string; token: string; title: string; visibility: string; accessLevel: string; expiresAt?: string;
  createdAt: string; viewCount: number; isRevoked: boolean; shareUrl: string;
  accessMembers?: { id: string; name: string }[];
  snapshot: { collectionId: string; version: number; name: string; description: string; siteIds: string[]; mainSiteId: string; sections: HostedCollectionSection[]; accessUserIds?: string[] };
}
export interface SaveHostedCollection { version?: number; name: string; description: string; siteIds: string[]; mainSiteId: string; sections: HostedCollectionSection[] }
