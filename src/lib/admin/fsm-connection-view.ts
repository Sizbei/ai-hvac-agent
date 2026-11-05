/**
 * How a Settings › Integrations FSM panel (FieldPulse, Housecall Pro) reads
 * its /status response. Must agree with /admin/integrations
 * (integrations-status.ts): an org served by the server's env key is
 * connected there, so the panel must not say "Not connected".
 */
export type FsmConnectionView = 'connected' | 'server_key' | 'not_connected';

export function fsmConnectionView(status: {
  readonly connected: boolean;
  readonly configured: boolean;
}): FsmConnectionView {
  if (status.connected) return 'connected';
  return status.configured ? 'server_key' : 'not_connected';
}

/** Human copy for a failed connect, by error code. Never the server's raw message. */
export function fsmConnectErrorMessage(provider: string, body: unknown): string {
  const code =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error?: { code?: unknown } }).error?.code
      : undefined;
  if (code === 'FORBIDDEN') return `Only the account owner can connect ${provider}.`;
  if (code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute and try again.';
  return `Couldn't connect ${provider}. Check the API key and try again.`;
}
