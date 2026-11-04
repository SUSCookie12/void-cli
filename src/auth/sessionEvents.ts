export type SessionRevokedHandler = () => void;

let handler: SessionRevokedHandler | null = null;

/** Called from Ink `VoidApp` so remote revoke can return the user to the auth screen. */
export function registerSessionRevokedHandler(fn: SessionRevokedHandler | null): void {
  handler = fn;
}

export function notifySessionRevoked(): void {
  try {
    handler?.();
  } catch (e) {
    console.error('[VOID] session revoke handler failed:', e);
  }
}
