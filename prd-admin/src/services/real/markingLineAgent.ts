/**
 * 赋码产线 Agent API（SSE 流式）
 */

/** POST SSE：根据简述生成产线示意图说明 */
export function getMarkingLineDiagramStreamUrl(): string {
  return '/api/marking-line-agent/diagram/stream';
}
