/** 通知总览与实际投递共用原事件分类；不改变订阅、通道或投递行为。 */
export type AlarmEventKind = 'business-down' | 'business-recovered' | 'infra-down' | 'infra-recovered';

export function classifyAlert(type: string, source: string): AlarmEventKind {
  const business = source === 'custom';
  if (type === 'uptime.target.recovered') return business ? 'business-recovered' : 'infra-recovered';
  return business ? 'business-down' : 'infra-down';
}
