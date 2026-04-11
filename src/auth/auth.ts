import {
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../config/firebase.js';
import { getDaemonId } from './session.js';

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

  // Create the document in the user's existing login_tokens collection
  await setDoc(doc(db, 'login_tokens', sessionId), {
    token: '',
    createdAt: serverTimestamp(),
    status: 'waiting',
    source: 'void_server',
    daemonId,
    uid: '',
    email: '',
  });

  const authUrl = `https://cspack.online/request?api=${sessionId}`;
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
              await updateDoc(doc(db, 'login_tokens', sessionId), {
                status: 'completed',
              });
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
