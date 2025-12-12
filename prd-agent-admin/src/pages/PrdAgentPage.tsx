import { usePrdSessionStore } from '../stores/prdSessionStore';
import DocumentUpload from '../components/PrdAgent/DocumentUpload';
import ChatContainer from '../components/PrdAgent/ChatContainer';

export default function PrdAgentPage() {
  const { documentLoaded } = usePrdSessionStore();

  return (
    <div className="h-full flex flex-col">
      {/* 统一页面内容宽度与对齐，避免标题左上 + 主体居中造成的割裂 */}
      <div className="w-full max-w-5xl mx-auto flex flex-col flex-1 min-h-0">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">PRD Agent 体验</h1>
          <p className="text-gray-400 text-sm mt-1">
            上传 PRD 文档，与 AI 进行多角色对话
          </p>
        </div>

        <div className="flex-1 min-h-0">
          {!documentLoaded ? <DocumentUpload /> : <ChatContainer />}
        </div>
      </div>
    </div>
  );
}

