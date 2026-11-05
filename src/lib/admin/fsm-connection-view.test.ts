import { describe, expect, it } from 'vitest';
import { fsmConnectErrorMessage, fsmConnectionView } from './fsm-connection-view';

describe('fsmConnectionView', () => {
  it('prefers the org connection, then the server key', () => {
    expect(fsmConnectionView({ connected: true, configured: true })).toBe('connected');
    expect(fsmConnectionView({ connected: false, configured: true })).toBe('server_key');
    expect(fsmConnectionView({ connected: false, configured: false })).toBe('not_connected');
  });
});

describe('fsmConnectErrorMessage', () => {
  it('maps codes to human copy and never echoes the server message', () => {
    expect(fsmConnectErrorMessage('FieldPulse', { error: { code: 'FORBIDDEN', message: 'Forbidden' } })).toBe(
      'Only the account owner can connect FieldPulse.',
    );
    const generic = fsmConnectErrorMessage('FieldPulse', { error: { code: 'INVALID_KEY', message: 'HTTP 403' } });
    expect(generic).toBe("Couldn't connect FieldPulse. Check the API key and try again.");
    expect(fsmConnectErrorMessage('Housecall Pro', null)).toMatch(/Housecall Pro/);
  });
});
