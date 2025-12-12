import MessageList from './MessageList';
import ChatInput from './ChatInput';
import RoleSelector from './RoleSelector';
import { usePrdSessionStore } from '../../stores/prdSessionStore';
import { usePrdMessageStore } from '../../stores/prdMessageStore';
import { FileTextOutlined, NumberOutlined, LogoutOutlined } from '@ant-design/icons';
import { Tooltip, Button, Popconfirm } from 'antd';

export default function ChatContainer() {
  const { document, clearSession } = usePrdSessionStore();
  const { clearMessages } = usePrdMessageStore();

  const handleEndSession = () => {
    clearMessages();
    clearSession();
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gradient-to-br from-gray-900/50 to-black/50 rounded-xl border border-white/10">
      {/* 头部信息栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/20">
        <div className="flex items-center gap-4">
          {document && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm">
                <FileTextOutlined className="text-blue-400" />
                <span className="text-white font-medium">{document.title}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <NumberOutlined />
                  {document.charCount.toLocaleString()} 字
                </span>
                <span>约 {document.tokenEstimate.toLocaleString()} tokens</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          <RoleSelector />
          <Tooltip title="结束会话">
            <Popconfirm
              title="结束当前会话"
              description="确定要结束当前会话吗？聊天记录将被清空。"
              onConfirm={handleEndSession}
              okText="确定"
              cancelText="取消"
            >
              <Button 
                type="text" 
                icon={<LogoutOutlined />}
                className="text-gray-400 hover:!text-red-400"
              />
            </Popconfirm>
          </Tooltip>
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

