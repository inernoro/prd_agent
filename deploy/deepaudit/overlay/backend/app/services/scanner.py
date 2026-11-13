"""
仓库扫描服务 - 支持GitHub, GitLab 和 Gitea 仓库扫描
"""

import asyncio
import httpx
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
from urllib.parse import urlparse, quote
from sqlalchemy.ext.asyncio import AsyncSession

from app.utils.repo_utils import parse_repository_url
from app.models.audit import AuditTask, AuditIssue
from app.models.project import Project
from app.services.llm.service import LLMService
from app.services.scan_errors import record_scan_error
from app.services.scan_snapshot import RepositoryEvidenceError, MAX_FILES
from app.core.config import settings


from app.services.scan_options import get_analysis_config


TEXT_EXTENSIONS = [
    ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", 
    ".cpp", ".c", ".h", ".cc", ".hh", ".cs", ".php", ".rb", 
    ".kt", ".swift", ".sql", ".sh", ".json", ".yml", ".yaml"
]

# 排除的目录和文件模式
EXCLUDE_PATTERNS = [
    "node_modules/", "vendor/", "dist/", "build/", ".git/",
    "__pycache__/", ".pytest_cache/", "coverage/", ".nyc_output/",
    ".vscode/", ".idea/", ".vs/", "target/", "out/",
    "__MACOSX/", ".DS_Store", "package-lock.json", "yarn.lock",
    "pnpm-lock.yaml", ".min.js", ".min.css", ".map"
]


def is_text_file(path: str) -> bool:
    """检查是否为文本文件"""
    return any(path.lower().endswith(ext) for ext in TEXT_EXTENSIONS)


def should_exclude(path: str, exclude_patterns: List[str] = None) -> bool:
    """检查是否应该排除该文件"""
    all_patterns = EXCLUDE_PATTERNS + (exclude_patterns or [])
    return any(pattern in path for pattern in all_patterns)


def get_language_from_path(path: str) -> str:
    """从文件路径获取语言类型"""
    ext = path.split('.')[-1].lower() if '.' in path else ''
    language_map = {
        'js': 'javascript', 'jsx': 'javascript',
        'ts': 'typescript', 'tsx': 'typescript',
        'py': 'python', 'java': 'java', 'go': 'go',
        'rs': 'rust', 'cpp': 'cpp', 'c': 'cpp',
        'cc': 'cpp', 'h': 'cpp', 'hh': 'cpp',
        'cs': 'csharp', 'php': 'php', 'rb': 'ruby',
        'kt': 'kotlin', 'swift': 'swift'
    }
    return language_map.get(ext, 'text')


class TaskControlManager:
    """任务控制管理器 - 用于取消运行中的任务"""
    
    def __init__(self):
        self._cancelled_tasks: set = set()
    
    def cancel_task(self, task_id: str):
        """取消任务"""
        self._cancelled_tasks.add(task_id)
        print(f" 任务 {task_id} 已标记为取消")
    
    def is_cancelled(self, task_id: str) -> bool:
        """检查任务是否被取消"""
        return task_id in self._cancelled_tasks
    
    def cleanup_task(self, task_id: str):
        """清理已完成任务的控制状态"""
        self._cancelled_tasks.discard(task_id)


# 全局任务控制器
task_control = TaskControlManager()


async def repository_get(url, headers=None, json_response=False):
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.get(url, headers=headers or {})


async def github_api(url: str, token: str = None, request=None) -> Any:
    """调用GitHub API"""
    headers = {"Accept": "application/vnd.github+json"}
    t = token or settings.GITHUB_TOKEN
    if t:
        headers["Authorization"] = f"Bearer {t}"
    
    response = await (request or repository_get)(url, headers=headers, json_response=True)
    if response.status_code == 403:
        raise Exception("GitHub API 403：请配置 GITHUB_TOKEN 或确认仓库权限/频率限制")
    if response.status_code != 200:
        raise Exception(f"GitHub API {response.status_code}: {url}")
    return response.json()



async def gitea_api(url: str, token: str = None, request=None) -> Any:
    """调用Gitea API"""
    headers = {"Content-Type": "application/json"}
    t = token or settings.GITEA_TOKEN
    if t:
        headers["Authorization"] = f"token {t}"
    
    response = await (request or repository_get)(url, headers=headers, json_response=True)
    if response.status_code == 401:
        raise Exception("Gitea API 401：请配置 GITEA_TOKEN 或确认仓库权限")
    if response.status_code == 403:
        raise Exception("Gitea API 403：请确认仓库权限/频率限制")
    if response.status_code != 200:
        raise Exception(f"Gitea API {response.status_code}: {url}")
    return response.json()


async def gitlab_api(url: str, token: str = None, request=None) -> Any:
    """调用GitLab API"""
    headers = {"Content-Type": "application/json"}
    t = token or settings.GITLAB_TOKEN
    if t:
        headers["PRIVATE-TOKEN"] = t
    
    response = await (request or repository_get)(url, headers=headers, json_response=True)
    if response.status_code == 401:
        raise Exception("GitLab API 401：请配置 GITLAB_TOKEN 或确认仓库权限")
    if response.status_code == 403:
        raise Exception("GitLab API 403：请确认仓库权限/频率限制")
    if response.status_code != 200:
        raise Exception(f"GitLab API {response.status_code}: {url}")
    return response.json()


async def fetch_file_content(url: str, headers: Dict[str, str] = None, request=None) -> Optional[str]:
    """获取文件内容"""
    try:
        response = await (request or repository_get)(url, headers=headers or {}, json_response=False)
        if response.status_code == 200:
            return response.text
    except RepositoryEvidenceError:
        raise
    except Exception as e:
        print(f"获取文件内容失败: {type(e).__name__}")
    return None


async def get_github_branches(repo_url: str, token: str = None) -> List[str]:
    """获取GitHub仓库分支列表"""
    repo_info = parse_repository_url(repo_url, "github")
    owner, repo = repo_info['owner'], repo_info['repo']
    
    branches_url = f"https://api.github.com/repos/{owner}/{repo}/branches?per_page=100"
    branches_data = await github_api(branches_url, token)
    
    return [b["name"] for b in branches_data]





async def get_gitea_branches(repo_url: str, token: str = None) -> List[str]:
    """获取Gitea仓库分支列表"""
    repo_info = parse_repository_url(repo_url, "gitea")
    base_url = repo_info['base_url'] # This is {base}/api/v1
    owner, repo = repo_info['owner'], repo_info['repo']
    
    branches_url = f"{base_url}/repos/{owner}/{repo}/branches"
    branches_data = await gitea_api(branches_url, token)
    
    return [b["name"] for b in branches_data]


async def get_gitlab_branches(repo_url: str, token: str = None) -> List[str]:
    """获取GitLab仓库分支列表"""
    extracted_token = gitlab_repository_token(repo_url, token)
    
    repo_info = parse_repository_url(repo_url, "gitlab")
    base_url = repo_info['base_url']
    project_path = quote(repo_info['project_path'], safe='')
    
    branches_url = f"{base_url}/projects/{project_path}/repository/branches?per_page=100"
    branches_data = await gitlab_api(branches_url, extracted_token)
    
    return [b["name"] for b in branches_data]


def gitlab_repository_token(repo_url, token=None):
    parsed = urlparse(repo_url)
    if parsed.username:
        if parsed.username == 'oauth2' and parsed.password:
            return parsed.password
        if not parsed.password:
            return parsed.username
    return token


async def get_github_files(repo_url: str, branch: str, token: str = None, exclude_patterns: List[str] = None, request=None) -> List[Dict[str, str]]:
    """获取GitHub仓库文件列表"""
    # 解析仓库URL
    repo_info = parse_repository_url(repo_url, "github")
    owner, repo = repo_info['owner'], repo_info['repo']
    
    # 获取仓库文件树
    tree_url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{quote(branch)}?recursive=1"
    tree_data = await github_api(tree_url, token, request=request)
    if tree_data.get('truncated') is True:
        raise ValueError('Repository tree is incomplete')
    
    files = []
    for item in tree_data.get("tree", []):
        if item.get("type") == "blob" and is_text_file(item["path"]) and not should_exclude(item["path"], exclude_patterns):
            size = item.get("size", 0)
            if size <= settings.MAX_FILE_SIZE_BYTES:
                files.append({
                    "path": item["path"],
                    "url": f"https://raw.githubusercontent.com/{owner}/{repo}/{quote(branch)}/{quote(item['path'], safe='/')}"
                })
    
    return files


async def get_gitlab_files(repo_url: str, branch: str, token: str = None, exclude_patterns: List[str] = None, request=None) -> List[Dict[str, str]]:
    """获取GitLab仓库文件列表"""
    extracted_token = gitlab_repository_token(repo_url, token)
    
    # 解析项目路径
    repo_info = parse_repository_url(repo_url, "gitlab")
    base_url = repo_info['base_url'] # {base}/api/v4
    project_path = quote(repo_info['project_path'], safe='')
    
    # 获取仓库文件树
    tree_url = f"{base_url}/projects/{project_path}/repository/tree?ref={quote(branch, safe='')}&recursive=true&per_page=100"
    tree_data, page = [], 1
    while True:
        entries = await gitlab_api(f'{tree_url}&page={page}', extracted_token, request=request)
        if not isinstance(entries, list):
            raise ValueError('Invalid repository tree page')
        if len(tree_data) + len(entries) > MAX_FILES:
            raise ValueError('Repository tree exceeds manifest limit')
        tree_data.extend(entries)
        if len(entries) < 100:
            break
        page += 1
    
    files = []
    for item in tree_data:
        if item.get("type") == "blob" and is_text_file(item["path"]) and not should_exclude(item["path"], exclude_patterns):
            files.append({
                "path": item["path"],
                "url": f"{base_url}/projects/{project_path}/repository/files/{quote(item['path'], safe='')}/raw?ref={quote(branch)}",
                "token": extracted_token
            })
    
    return files



async def get_gitea_files(repo_url: str, branch: str, token: str = None, exclude_patterns: List[str] = None, request=None) -> List[Dict[str, str]]:
    """获取Gitea仓库文件列表"""
    repo_info = parse_repository_url(repo_url, "gitea")
    base_url = repo_info['base_url']
    owner, repo = repo_info['owner'], repo_info['repo']
    
    # Gitea tree API: GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
    # 可以直接使用分支名作为sha
    tree_url = f"{base_url}/repos/{owner}/{repo}/git/trees/{quote(branch, safe='')}?recursive=true&per_page=100"
    entries, page = [], 1
    while True:
        tree_data = await gitea_api(f'{tree_url}&page={page}', token, request=request)
        current = tree_data.get('tree')
        if not isinstance(current, list):
            raise ValueError('Invalid repository tree page')
        if len(entries) + len(current) > MAX_FILES:
            raise ValueError('Repository tree exceeds manifest limit')
        entries.extend(current)
        if tree_data.get('truncated') is not True:
            break
        if not current:
            raise ValueError('Repository tree page made no progress')
        page += 1
    
    files = []
    for item in entries:
         # Gitea API returns 'type': 'blob' for files
        if item.get("type") == "blob" and is_text_file(item["path"]) and not should_exclude(item["path"], exclude_patterns):
            # 使用API raw endpoint: GET /repos/{owner}/{repo}/raw/{filepath}?ref={branch}
             files.append({
                "path": item["path"],
                "url": f"{base_url}/repos/{owner}/{repo}/raw/{quote(item['path'])}?ref={quote(branch)}",
                "token": token # 传递token以便fetch_file_content使用
            })
    
    return files
async def scan_repo_task(task_id: str, db_session_factory, user_config: dict = None):
    from app.services.static_runner import run_static_task
    from app.services.repository_snapshot import prepare_repository
    await run_static_task(task_id, db_session_factory, user_config, prepare_repository,
                          LLMService, task_control, is_text_file, should_exclude,
                          get_language_from_path)
