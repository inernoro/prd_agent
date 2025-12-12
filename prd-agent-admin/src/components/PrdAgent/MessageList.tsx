import { useRef, useEffect } from 'react';
import { usePrdMessageStore } from '../../stores/prdMessageStore';
import ReactMarkdown from 'react-markdown';
import { UserOutlined, RobotOutlined } from '@ant-design/icons';

export default function MessageList() {
  const { messages, streamingContent, isStreaming } = usePrdMessageStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex gap-3 ${message.role === 'User' ? 'flex-row-reverse' : 'flex-row'}`}
        >
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
            message.role === 'User' 
              ? 'bg-blue-600' 
              : 'bg-gradient-to-br from-purple-600 to-pink-600'
          }`}>
            {message.role === 'User' ? (
              <UserOutlined className="text-white text-sm" />
            ) : (
              <RobotOutlined className="text-white text-sm" />
            )}
          </div>
          
          <div
            className={`max-w-[75%] p-4 rounded-2xl ${
              message.role === 'User'
                ? 'bg-blue-600 text-white rounded-tr-md'
                : 'bg-white/5 border border-white/10 text-gray-100 rounded-tl-md'
            }`}
          >
            {message.role === 'User' ? (
              <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
            ) : (
              <div className="prose prose-sm prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-black/30 prose-code:text-pink-400">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
            
            {message.viewRole && (
              <p className="text-xs opacity-60 mt-2">
                以 {message.viewRole} 视角
              </p>
            )}
          </div>
        </div>
      ))}

      {isStreaming && (
        <div className="flex gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-purple-600 to-pink-600">
            <RobotOutlined className="text-white text-sm" />
          </div>
          <div className="max-w-[75%] p-4 rounded-2xl rounded-tl-md bg-white/5 border border-white/10 text-gray-100">
            <div className="prose prose-sm prose-invert max-w-none">
              <ReactMarkdown>{streamingContent || '思考中...'}</ReactMarkdown>
            </div>
            <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1 rounded-sm" />
          </div>
        </div>
      )}

      {messages.length === 0 && !isStreaming && (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-2xl flex items-center justify-center">
              <RobotOutlined className="text-4xl text-blue-400" />
            </div>
            <p className="text-xl text-white mb-2">👋 你好！</p>
            <p className="text-gray-400">有什么关于这份 PRD 的问题，尽管问我</p>
            <p className="text-gray-500 text-sm mt-2">我可以从 PM、DEV、QA 不同视角为你解答</p>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

