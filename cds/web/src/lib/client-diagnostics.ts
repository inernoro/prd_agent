import { apiUrl } from '@/lib/api';

let lastRenderErrorSignature = '';
let lastRenderErrorAt = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export function reportDashboardRenderError(error: unknown, componentStack?: string): void {
  const message = errorMessage(error);
  const signature = `${message}:${componentStack || ''}`;
  const now = Date.now();
  if (signature === lastRenderErrorSignature && now - lastRenderErrorAt < 30_000) return;
  lastRenderErrorSignature = signature;
  lastRenderErrorAt = now;

  const payload = {
    type: 'render-error',
    message,
    stack: errorStack(error),
    componentStack,
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);

  try {
    if (navigator.sendBeacon) {
      const sent = navigator.sendBeacon(apiUrl('/api/client-events'), new Blob([body], { type: 'application/json' }));
      if (sent) return;
    }
    void fetch(apiUrl('/api/client-events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      keepalive: true,
      body,
    });
  } catch {
    // The console entry in the caller is still the local fallback.
  }
}
