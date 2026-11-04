import React, { useState, useEffect, useLayoutEffect } from 'react';
import { render } from 'ink';
import { AuthScreen } from './screens/AuthScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { CreateServerScreen } from './screens/CreateServerScreen.js';
import { ServerDetailScreen } from './screens/ServerDetailScreen.js';
import { loadSession, clearSession, type UserSession } from '../auth/session.js';
import { getServerMeta } from '../server/manager.js';
import { initWebRTCSignaling } from '../network/webrtc.js';
import { registerSessionRevokedHandler } from '../auth/sessionEvents.js';

type View = 'auth' | 'home' | 'create' | 'server';

const VoidApp: React.FC = () => {
  const [session, setSession] = useState<UserSession | null>(() => loadSession());
  const [view, setView] = useState<View>(() => (loadSession() ? 'home' : 'auth'));
  const [selectedServer, setSelectedServer] = useState<string | null>(null);

  useLayoutEffect(() => {
    registerSessionRevokedHandler(() => {
      setSession(null);
      setView('auth');
      setSelectedServer(null);
    });
    return () => registerSessionRevokedHandler(null);
  }, []);

  useEffect(() => {
    if (session && session.uid && session.daemonId) {
      const unsub = initWebRTCSignaling(session.uid, session.daemonId);
      return () => unsub();
    }
  }, [session]);

  const handleAuthenticated = (s: UserSession) => {
    setSession(s);
    setView('home');
  };

  const handleLogout = () => {
    clearSession();
    setSession(null);
    setView('auth');
  };

  if (view === 'auth') {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  if (view === 'create') {
    return (
      <CreateServerScreen
        onDone={() => setView('home')}
        onBack={() => setView('home')}
      />
    );
  }

  if (view === 'server' && selectedServer) {
    const meta = getServerMeta(selectedServer);
    if (!meta) {
      setView('home');
      return null;
    }
    return (
      <ServerDetailScreen
        meta={meta}
        session={session!}
        onBack={() => setView('home')}
      />
    );
  }

  return (
    <HomeScreen
      session={session!}
      onCreateServer={() => setView('create')}
      onOpenServer={name => {
        setSelectedServer(name);
        setView('server');
      }}
      onLogout={handleLogout}
    />
  );
};

function initializeLogic() {
  const session = loadSession();
  if (session && session.uid && session.daemonId) {
    console.log(`[VOID] Initializing WebRTC Signaling for Daemon: ${session.daemonId}`);
    initWebRTCSignaling(session.uid, session.daemonId);
  } else {
    console.warn('[VOID] No active session found. WebRTC signaling will not start until authenticated.');
  }
}

export function startUI(): void {
  // Always initialize background logic (WebRTC) regardless of TTY
  initializeLogic();

  if (!process.stdin.isTTY) {
    console.log('[VOID] Running in headless mode (no TTY). WebRTC active.');
    // Keep the process alive
    setInterval(() => {}, 1000 * 60 * 60); 
    return;
  }
  
  try {
    render(<VoidApp />);
  } catch (err) {
    console.error('[VOID] Failed to start UI, staying in headless mode:', err);
    setInterval(() => {}, 1000 * 60 * 60);
  }
}
