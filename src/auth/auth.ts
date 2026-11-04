import { onSnapshot } from 'firebase/firestore';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../config/firebase.js';
import { getDaemonId } from './session.js';

const API_KEY = 'AIzaSyAxkQA5tBqp_5fco6Y_8i2mhI15ECJeNh0';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/cookiemovie-27669/databases/(default)';
const DOC_BASE = 'projects/cookiemovie-27669/databases/(default)/documents';

async function restCommit(writes: any[]): Promise<void> {
  try {
    await fetch(`${FIRESTORE_BASE}/documents:commit?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
  } catch {}
}

export interface AuthResult {
  uid: string;
  email: string;
  displayName?: string;
  token: string;
  sessionId: string;
}

export function generateSessionId(): string {
  return uuidv4().replace(/-/g, '');
}

export async function startAuthFlow(
  onLinkGenerated: (url: string, sessionId: string) => void
): Promise<AuthResult> {
  const db = getDb();
  const sessionId = generateSessionId();
  const daemonId = getDaemonId();

  // Create the login_tokens document via REST API
  await restCommit([{
    update: {
      name: `${DOC_BASE}/login_tokens/${sessionId}`,
      fields: {
        token: { stringValue: '' },
        status: { stringValue: 'pending' },
        source: { stringValue: 'void_server' },
        daemonId: { stringValue: daemonId },
        uid: { stringValue: '' },
        email: { stringValue: '' },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    },
  }]);

  const origin = (process.env.VOID_AUTH_HANDOFF_ORIGIN || 'https://void.borgov.dev').replace(/\/$/, '');
  const authUrl = `${origin}/api?login=${encodeURIComponent(sessionId)}`;
  onLinkGenerated(authUrl, sessionId);

  return new Promise<AuthResult>((resolve, reject) => {
    // 10 minute timeout
    const timeoutId = setTimeout(() => {
      unsubscribe();
      reject(new Error('Authentication timed out after 10 minutes. Please try again.'));
    }, 10 * 60 * 1000);

    const unsubscribe = onSnapshot(
      doc(db, 'login_tokens', sessionId),
      async snapshot => {
        const data = snapshot.data();
        if (!data) return;

        const actualUid = data.uid || data.userId;

        if ((data.status === 'send' || data.status === 'completed') && data.token && actualUid) {
          clearTimeout(timeoutId);
          unsubscribe();

          // Mark as completed (for the user's future dashboard)
          if (data.status !== 'completed') {
            try {
              await restCommit([{
                update: {
                  name: `${DOC_BASE}/login_tokens/${sessionId}`,
                  fields: { status: { stringValue: 'completed' } },
                },
              }]);
            } catch {
              // Non-critical, continue anyway
            }
          }

          resolve({
            uid: actualUid as string,
            email: (data.email as string) || '',
            displayName: data.displayName as string | undefined,
            token: data.token as string,
            sessionId,
          });
        }

        if (data.status === 'error') {
          clearTimeout(timeoutId);
          unsubscribe();
          reject(new Error('Authentication was rejected by the server.'));
        }
      },
      error => {
        clearTimeout(timeoutId);
        reject(new Error(`Firestore listener error: ${error.message}`));
      }
    );
  });
}
