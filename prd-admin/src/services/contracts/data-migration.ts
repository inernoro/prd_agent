import type { ApiResponse } from '@/types/api';

// ============ 类型定义 ============

export type AppOwnerInfo = {
  appName: string;
  displayName: string;
  isPrimary: boolean;
};

export type CollectionMappingItem = {
  collectionName: string;
  entityName: string | null;
  entityFullName: string | null;
  appOwners: AppOwnerInfo[];
  existsInDatabase: boolean;
  hasEntity: boolean;
  documentCount: number;
};

export type AppCollectionStats = {
  appName: string | null;
  displayName: string;
  collectionCount: number;
  totalDocuments: number;
};

export type CollectionMappingsResponse = {
  mappings: CollectionMappingItem[];
  appStats: AppCollectionStats[];
  totalCollections: number;
  totalEntities: number;
  unmappedCollections: number;
  unmappedEntities: number;
};

export type CollectionDataResponse = {
  collectionName: string;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  fields: string[];
  data: unknown[];
};

export type EntityFieldInfo = {
  name: string;
  type: string;
  isNullable: boolean;
  isRequired: boolean;
};

export type InvalidDocumentItem = {
  documentId: string;
  document: unknown;
  issues: string[];
};

export type CollectionValidationResponse = {
  collectionName: string;
  hasEntity: boolean;
  entityName: string | null;
  totalDocuments: number;
  scannedDocuments: number;
  validDocuments: number;
  invalidDocuments: number;
  invalidItems: InvalidDocumentItem[];
  entityFields: EntityFieldInfo[];
};

export type CollectionDeleteResponse = {
  collectionName: string;
  deletedDocuments: number;
  success: boolean;
};

export type DocumentDeleteResponse = {
  collectionName: string;
  documentId: string;
  deleted: boolean;
};

export type AppDataDeleteResponse = {
  appName: string;
  deletedCollections: string[];
  totalDeletedDocuments: number;
};

// ============ Contract 类型定义 ============

export type GetCollectionMappingsContract = () => Promise<ApiResponse<CollectionMappingsResponse>>;

export type GetCollectionDataContract = (
  collectionName: string,
  page?: number,
  pageSize?: number
) => Promise<ApiResponse<CollectionDataResponse>>;

export type ValidateCollectionContract = (
  collectionName: string,
  limit?: number
) => Promise<ApiResponse<CollectionValidationResponse>>;

export type DeleteCollectionContract = (
  collectionName: string,
  confirmed: boolean
) => Promise<ApiResponse<CollectionDeleteResponse>>;

export type DeleteDocumentContract = (
  collectionName: string,
  documentId: string,
  confirmed: boolean
) => Promise<ApiResponse<DocumentDeleteResponse>>;

export type DeleteAppDataContract = (
  appName: string,
  confirmed: boolean
) => Promise<ApiResponse<AppDataDeleteResponse>>;
