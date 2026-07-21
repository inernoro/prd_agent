export type DocumentStoreDetailAction = 'doc' | 'record' | 'upload' | 'video';

export interface DetailInitialActionRequest {
  id: number;
  storeId: string;
  action: DocumentStoreDetailAction;
}

export function detailInitialActionForStore(
  request: DetailInitialActionRequest | null,
  storeId: string,
): DetailInitialActionRequest | undefined {
  return request?.storeId === storeId ? request : undefined;
}

export function consumeDetailInitialAction(
  current: DetailInitialActionRequest | null,
  consumedRequestId: number,
): DetailInitialActionRequest | null {
  return current?.id === consumedRequestId ? null : current;
}
