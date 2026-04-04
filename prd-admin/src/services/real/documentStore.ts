import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  CreateDocumentStoreContract,
  ListDocumentStoresContract,
  GetDocumentStoreContract,
  UpdateDocumentStoreContract,
  DeleteDocumentStoreContract,
  AddDocumentEntryContract,
  ListDocumentEntriesContract,
  UpdateDocumentEntryContract,
  DeleteDocumentEntryContract,
} from '@/services/contracts/documentStore';

export const createDocumentStoreReal: CreateDocumentStoreContract = async (input) => {
  return await apiRequest(api.documentStore.stores.create(), {
    method: 'POST',
    body: input,
  });
};

export const listDocumentStoresReal: ListDocumentStoresContract = async (page = 1, pageSize = 20) => {
  return await apiRequest(`${api.documentStore.stores.list()}?page=${page}&pageSize=${pageSize}`, {
    method: 'GET',
  });
};

export const getDocumentStoreReal: GetDocumentStoreContract = async (storeId) => {
  return await apiRequest(api.documentStore.stores.detail(storeId), {
    method: 'GET',
  });
};

export const updateDocumentStoreReal: UpdateDocumentStoreContract = async (storeId, input) => {
  return await apiRequest(api.documentStore.stores.detail(storeId), {
    method: 'PUT',
    body: input,
  });
};

export const deleteDocumentStoreReal: DeleteDocumentStoreContract = async (storeId) => {
  return await apiRequest(api.documentStore.stores.detail(storeId), {
    method: 'DELETE',
  });
};

export const addDocumentEntryReal: AddDocumentEntryContract = async (storeId, input) => {
  return await apiRequest(api.documentStore.entries.add(storeId), {
    method: 'POST',
    body: input,
  });
};

export const listDocumentEntriesReal: ListDocumentEntriesContract = async (storeId, page = 1, pageSize = 20, keyword) => {
  let url = `${api.documentStore.entries.list(storeId)}?page=${page}&pageSize=${pageSize}`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;
  return await apiRequest(url, { method: 'GET' });
};

export const updateDocumentEntryReal: UpdateDocumentEntryContract = async (entryId, input) => {
  return await apiRequest(api.documentStore.entries.update(entryId), {
    method: 'PUT',
    body: input,
  });
};

export const deleteDocumentEntryReal: DeleteDocumentEntryContract = async (entryId) => {
  return await apiRequest(api.documentStore.entries.delete(entryId), {
    method: 'DELETE',
  });
};
