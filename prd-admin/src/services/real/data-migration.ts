import { api } from '@/services/api';
import { apiRequest } from './apiClient';
import type {
  GetCollectionMappingsContract,
  GetCollectionDataContract,
  ValidateCollectionContract,
  DeleteCollectionContract,
  DeleteDocumentContract,
  DeleteAppDataContract,
} from '@/services/contracts/data-migration';

export const getCollectionMappingsReal: GetCollectionMappingsContract = async () => {
  return await apiRequest(api.dataMigration.mappings());
};

export const getCollectionDataReal: GetCollectionDataContract = async (
  collectionName,
  page = 1,
  pageSize = 20
) => {
  const url = `${api.dataMigration.collections.data(collectionName)}?page=${page}&pageSize=${pageSize}`;
  return await apiRequest(url);
};

export const validateCollectionReal: ValidateCollectionContract = async (
  collectionName,
  limit = 100
) => {
  const url = `${api.dataMigration.collections.validation(collectionName)}?limit=${limit}`;
  return await apiRequest(url);
};

export const deleteCollectionReal: DeleteCollectionContract = async (
  collectionName,
  confirmed
) => {
  const url = `${api.dataMigration.collections.delete(collectionName)}?confirmed=${confirmed}`;
  return await apiRequest(url, { method: 'DELETE' });
};

export const deleteDocumentReal: DeleteDocumentContract = async (
  collectionName,
  documentId,
  confirmed
) => {
  const url = `${api.dataMigration.collections.document(collectionName, documentId)}?confirmed=${confirmed}`;
  return await apiRequest(url, { method: 'DELETE' });
};

export const deleteAppDataReal: DeleteAppDataContract = async (appName, confirmed) => {
  const url = `${api.dataMigration.apps.delete(appName)}?confirmed=${confirmed}`;
  return await apiRequest(url, { method: 'DELETE' });
};
