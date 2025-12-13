import MessageList from './MessageList';
import ChatInput from './ChatInput';
import RoleSelector from './RoleSelector';
import { usePrdSessionStore } from '../../stores/prdSessionStore';
import { usePrdMessageStore } from '../../stores/prdMessageStore';
import { IconFile, IconCode, IconExport } from '@arco-design/web-react/icon';
import { Tooltip, Button, Popconfirm } from '@arco-design/web-react';

export default function ChatContainer() {
  const { document, clearSession } = usePrdSessionStore();
  const { clearMessages } = usePrdMessageStore();

  const handleEndSession = () => {
    clearMessages();
    clearSession();
  };

  return (
    <div 
      className="flex-1 flex flex-col overflow-hidden"
      style={{
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* 头部信息栏 */}
      <div 
        className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}
      >
        <div className="flex items-center gap-4">
          {document && (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <IconFile style={{ color: 'var(--accent)', fontSize: 16 }} />
                <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: 14 }}>
                  {document.title}
                </span>
              </div>
              <div className="flex items-center gap-4" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                <span className="flex items-center gap-1">
                  <IconCode style={{ fontSize: 12 }} />
                  {document.charCount.toLocaleString()} 字
                </span>
                <span>约 {document.tokenEstimate.toLocaleString()} tokens</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          <RoleSelector />
          <Popconfirm
            title="确定要结束当前会话吗？聊天记录将被清空。"
            onOk={handleEndSession}
            okText="确定"
            cancelText="取消"
          >
            <Tooltip content="结束会话">
              <Button 
                type="text" 
                icon={<IconExport />}
                style={{ color: 'var(--text-muted)' }}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      </div>
      
      {/* 消息列表 */}
      <div className="flex-1 overflow-hidden">
        <MessageList />
      </div>
      
      {/* 输入框 */}
      <ChatInput />
    </div>
  );
}
