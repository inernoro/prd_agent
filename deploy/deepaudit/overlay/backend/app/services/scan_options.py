"""Options shared by both ordinary scan entry points."""
from app.core.config import settings


def get_analysis_config(user_config=None):
    config = user_config or {}
    request = config.get('scan_config') or {}
    other = config.get('otherConfig') or {}

    def value(request_key, user_key, default):
        explicit = request.get(request_key)
        if explicit is None:
            explicit = other.get(user_key)
        return default if explicit is None else explicit

    return {
        'max_analyze_files': max(0, int(value('max_analyze_files', 'maxAnalyzeFiles', settings.MAX_ANALYZE_FILES))),
        'llm_concurrency': min(8, max(1, int(value('llm_concurrency', 'llmConcurrency', settings.LLM_CONCURRENCY)))),
        'llm_gap_ms': max(0, int(value('llm_gap_ms', 'llmGapMs', settings.LLM_GAP_MS))),
    }
