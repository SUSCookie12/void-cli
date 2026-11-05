import React, { useState, useEffect, useLayoutEffect } from 'react';
import { Box, render } from 'ink';
import { AuthScreen } from './screens/AuthScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { CreateServerScreen } from './screens/CreateServerScreen.js';
import { ServerDetailScreen } from './screens/ServerDetailScreen.js';
import { DaemonConsoleBox } from './components/DaemonConsoleBox.js';
import { loadSession, clearSession, type UserSession } from '../auth/session.js';
import { getServerMeta } from '../server/manager.js';
import { initWebRTCSignaling } from '../network/webrtc.js';
import { registerSessionRevokedHandler } from '../auth/sessionEvents.js';
import { setupTuiLogger, restoreConsoleLogger } from '../utils/activityLogger.js';

type View = 'auth' | 'home' | 'create' | 'server';

const VoidApp: React.FC = () => {
  const [session, setSession] = useState<UserSession | null>(() => loadSession());
  const [view, setView] = useState<View>(() => (loadSession() ? 'home' : 'auth'));
  const [selectedServer, setSelectedServer] = useState<string | null>(null);

  const [termSize, setTermSize] = useState(() => ({
    columns: process.stdout.columns || 110,
    rows: process.stdout.rows || 30,
  }));

  useEffect(() => {
    const handleResize = () => {
      setTermSize({
        columns: process.stdout.columns || 110,
        rows: process.stdout.rows || 30,
      });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.removeListener('resize', handleResize);
    };
  }, []);

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

  let content: React.ReactNode = null;
  if (view === 'auth') {
    content = <AuthScreen onAuthenticated={handleAuthenticated} />;
  } else if (view === 'create') {
    content = (
      <CreateServerScreen
        onDone={() => setView('home')}
        onBack={() => setView('home')}
      />
    );
  } else if (view === 'server' && selectedServer) {
    const meta = getServerMeta(selectedServer);
    if (!meta) {
      setView('home');
    } else {
      content = (
        <ServerDetailScreen
          meta={meta}
          session={session!}
          onBack={() => setView('home')}
        />
      );
    }
  } else {
    content = (
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
  }

  // Calculate layout widths
  // Left content needs ~76 columns for the main TUI cards
  const totalCols = termSize.columns || 110;
  const isWide = totalCols >= 96;
  const leftWidth = isWide ? Math.min(78, totalCols - 34) : totalCols;
  const rightWidth = isWide ? Math.max(32, totalCols - leftWidth - 2) : totalCols;
  const consoleHeight = Math.max(22, (termSize.rows || 28) - 2);

  if (!isWide) {
    return (
      <Box flexDirection="column">
        {content}
        <Box marginTop={1}>
          <DaemonConsoleBox width={totalCols} height={12} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Box flexDirection="column" width={leftWidth}>
        {content}
      </Box>
      <Box flexDirection="column" width={rightWidth} marginLeft={1}>
        <DaemonConsoleBox width={rightWidth} height={consoleHeight} />
      </Box>
    </Box>
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
  if (process.stdin.isTTY) {
    setupTuiLogger();
    try {
      process.stdout.write('\x1b[2J\x1b[H');
    } catch {}
  }

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
    restoreConsoleLogger();
    console.error('[VOID] Failed to start UI, staying in headless mode:', err);
    setInterval(() => {}, 1000 * 60 * 60);
  }
}
