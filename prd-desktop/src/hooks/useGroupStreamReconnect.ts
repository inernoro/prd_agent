import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '../lib/tauri';

interface UseGroupStreamReconnectOptions {
  groupId: string | null;
  afterSeq: number;
  onConnectionChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void;
}

/**
 * 群组 SSE 流断线重连管理
 * 
 * 功能：
 * 1. 心跳检测（45s 无数据视为断线，后端 keep-alive 间隔 10s）
 * 2. 自动重连（指数退避：1s -> 2s -> 4s -> 8s -> 16s -> 30s）
 * 3. 断点续传（重连时携带最新 seq）
 * 4. 连接状态通知
 */
export function useGroupStreamReconnect(options: UseGroupStreamReconnectOptions) {
  const { groupId, afterSeq, onConnectionChange } = options;
  
  const heartbeatTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isActiveRef = useRef(true);
  const lastSeqRef = useRef(afterSeq);
  const connectionStatusRef = useRef<'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('disconnected');
  const groupIdRef = useRef(groupId);
  const onConnectionChangeRef = useRef(onConnectionChange);

  // 保持 refs 同步
  useEffect(() => {
    groupIdRef.current = groupId;
    lastSeqRef.current = afterSeq;
    onConnectionChangeRef.current = onConnectionChange;
  }, [groupId, afterSeq, onConnectionChange]);

  // 更新连接状态
  const updateStatus = useCallback((status: typeof connectionStatusRef.current) => {
    if (connectionStatusRef.current === status) return;
    connectionStatusRef.current = status;
    onConnectionChangeRef.current?.(status);
  }, []);

  // 清理所有定时器
  const clearTimers = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      window.clearTimeout(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // 执行订阅
  const subscribe = useCallback(async (seq: number) => {
    const gid = groupIdRef.current;
    if (!gid) return false;
    
    try {
      await invoke('subscribe_group_messages', { 
        groupId: gid, 
        afterSeq: seq 
      });
      return true;
    } catch (error) {
      console.error('[useGroupStreamReconnect] 订阅失败:', error);
      return false;
    }
  }, []);

  // 启动心跳检测（使用 ref 避免闭包陷阱）
  const startHeartbeat = useCallback(() => {
    clearTimers();
    heartbeatTimerRef.current = window.setTimeout(() => {
      if (!isActiveRef.current) return;
      console.warn('[useGroupStreamReconnect] 心跳超时（45s 无消息），开始重连');
      updateStatus('reconnecting');
      
      // 直接执行重连逻辑（避免循环依赖）
      const executeReconnect = async () => {
        if (!isActiveRef.current || !groupIdRef.current) return;
        
        clearTimers();
        
        // 计算退避延迟
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        reconnectAttemptsRef.current += 1;
        
        console.log(`[useGroupStreamReconnect] 将在 ${delay}ms 后重连（尝试 #${reconnectAttemptsRef.current}）`);
        
        reconnectTimerRef.current = window.setTimeout(async () => {
          if (!isActiveRef.current || !groupIdRef.current) return;
          
          updateStatus('reconnecting');
          
          // 先取消旧连接
          try {
            await invoke('cancel_stream', { kind: 'group' });
          } catch (e) {
            // 忽略
          }
          
          // 使用最新的 seq 重新订阅
          const success = await subscribe(lastSeqRef.current);
          
          if (success) {
            console.log('[useGroupStreamReconnect] 重连成功');
            startHeartbeat(); // 重新启动心跳
          } else {
            console.warn('[useGroupStreamReconnect] 重连失败，继续重试');
            executeReconnect(); // 继续重连
          }
        }, delay);
      };
      
      executeReconnect();
    }, 45000);
  }, [clearTimers, updateStatus, subscribe]);

  // 重置心跳（收到消息时调用）
  const resetHeartbeat = useCallback(() => {
    if (connectionStatusRef.current !== 'connected') {
      updateStatus('connected');
      reconnectAttemptsRef.current = 0;
    }
    startHeartbeat();
  }, [startHeartbeat, updateStatus]);

  // 手动重连
  const manualReconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    updateStatus('reconnecting');
    
    const executeReconnect = async () => {
      if (!isActiveRef.current || !groupIdRef.current) return;
      
      clearTimers();
      
      try {
        await invoke('cancel_stream', { kind: 'group' });
      } catch (e) {
        // 忽略
      }
      
      const success = await subscribe(lastSeqRef.current);
      
      if (success) {
        console.log('[useGroupStreamReconnect] 手动重连成功');
        startHeartbeat();
      } else {
        console.warn('[useGroupStreamReconnect] 手动重连失败');
      }
    };
    
    executeReconnect();
  }, [clearTimers, updateStatus, subscribe, startHeartbeat]);

  // 初始订阅（只在 groupId 变化时触发）
  useEffect(() => {
    if (!groupId) {
      isActiveRef.current = false;
      clearTimers();
      invoke('cancel_stream', { kind: 'group' }).catch(() => {});
      updateStatus('disconnected');
      return;
    }

    console.log('[useGroupStreamReconnect] 初始订阅 groupId:', groupId, 'afterSeq:', afterSeq);
    
    isActiveRef.current = true;
    reconnectAttemptsRef.current = 0;
    updateStatus('connecting');

    // 执行初始订阅
    (async () => {
      const success = await subscribe(afterSeq);
      if (success && isActiveRef.current) {
        startHeartbeat();
      } else if (!success && isActiveRef.current) {
        console.warn('[useGroupStreamReconnect] 初始订阅失败，开始重连');
        updateStatus('reconnecting');
        manualReconnect();
      }
    })();

    // 清理函数
    return () => {
      console.log('[useGroupStreamReconnect] 清理订阅 groupId:', groupId);
      isActiveRef.current = false;
      clearTimers();
      invoke('cancel_stream', { kind: 'group' }).catch(() => {});
    };
  }, [groupId]); // 只依赖 groupId

  // 更新 seq（外部调用，用于同步最新的 seq）
  const updateSeq = useCallback((newSeq: number) => {
    lastSeqRef.current = newSeq;
  }, []);

  return {
    resetHeartbeat,
    updateSeq,
    reconnect: manualReconnect,
    connectionStatus: connectionStatusRef.current
  };
}
