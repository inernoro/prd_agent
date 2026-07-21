import { describe, expect, it } from 'vitest';
import {
  consumeDetailInitialAction,
  detailInitialActionForStore,
  type DetailInitialActionRequest,
} from './detailInitialAction';

describe('detailInitialAction', () => {
  const quickRecord: DetailInitialActionRequest = {
    id: 1,
    storeId: 'quick-store',
    action: 'record',
  };

  it('只允许创建意图在发起时绑定的知识库执行', () => {
    expect(detailInitialActionForStore(quickRecord, 'quick-store')).toBe(quickRecord);
    expect(detailInitialActionForStore(quickRecord, 'destination-store')).toBeUndefined();
  });

  it('消费后切换知识库不会再次开始录音', () => {
    const consumed = consumeDetailInitialAction(quickRecord, quickRecord.id);
    expect(consumed).toBeNull();
    expect(detailInitialActionForStore(consumed, 'destination-store')).toBeUndefined();
  });

  it('迟到的消费回调不会清掉更新的创建意图', () => {
    const newer: DetailInitialActionRequest = {
      id: 2,
      storeId: 'another-store',
      action: 'upload',
    };
    expect(consumeDetailInitialAction(newer, quickRecord.id)).toBe(newer);
  });
});
