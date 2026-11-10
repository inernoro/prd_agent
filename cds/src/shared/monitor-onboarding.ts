/** Only these two endpoints carry the short-lived, draft-only session credential. */
export function isMonitorOnboardingAgentRoute(method: string, path: string): boolean {
  return (method === 'GET' && /^\/api\/uptime\/onboarding-agent\/[a-f0-9]{32}\/instructions$/.test(path))
    || (method === 'POST' && /^\/api\/uptime\/onboarding-agent\/[a-f0-9]{32}\/proposals$/.test(path));
}
