import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { initFirebase } from '../../config/firebase.js';
import { startAuthFlow } from '../../auth/auth.js';
import { getDaemonId, saveSession, type UserSession } from '../../auth/session.js';
import { DAEMON_VERSION } from '../../version.js';
import qrcode from 'qrcode-terminal';

interface AuthScreenProps {
  onAuthenticated: (session: UserSession) => void;
}

type Status = 'init' | 'waiting' | 'success' | 'error';

const LOGO_LINES = [
  ' ██╗   ██╗ ██████╗ ██╗██████╗ ',
  ' ██║   ██║██╔═══██╗██║██╔══██╗',
  ' ██║   ██║██║   ██║██║██║  ██║',
  ' ╚██╗ ██╔╝██║   ██║██║██║  ██║',
  '  ╚████╔╝ ╚██████╔╝██║██████╔╝',
  '   ╚═══╝   ╚═════╝ ╚═╝╚═════╝ ',
];

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [status, setStatus] = useState<Status>('init');
  const [authUrl, setAuthUrl] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [qrLines, setQrLines] = useState<string[]>([]);

  const shouldRenderQr = useMemo(() => {
    // Only render QR when we have a real URL and the output is interactive.
    if (!authUrl) return false;
    return Boolean(process.stdout.isTTY);
  }, [authUrl]);

  useEffect(() => {
    if (!shouldRenderQr) {
      setQrLines([]);
      return;
    }

    try {
      // qrcode-terminal calls the callback with a pre-rendered multi-line string.
      qrcode.generate(authUrl, { small: true }, (qr: string) => {
        setQrLines(qr.split('\n').filter(Boolean));
      });
    } catch {
      setQrLines([]);
    }
  }, [authUrl, shouldRenderQr]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        initFirebase();

        const result = await startAuthFlow((url, sid) => {
          if (cancelled) return;
          setAuthUrl(url);
          setSessionId(sid);
          setStatus('waiting');
        });

        if (cancelled) return;

        const session: UserSession = {
          uid: result.uid,
          email: result.email,
          displayName: result.displayName,
          token: result.token,
          daemonId: getDaemonId(),
          authenticatedAt: new Date().toISOString(),
        };

        saveSession(session);
        setStatus('success');
        setTimeout(() => { if (!cancelled) onAuthenticated(session); }, 800);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    };

    run();
    return () => { cancelled = true; };
  }, []);

  return (
    <Box flexDirection="column" padding={2}>
      {/* Logo */}
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={0} marginBottom={1}>
        {LOGO_LINES.map((line, i) => (
          <Text key={i} color="cyan" bold>{line}</Text>
        ))}
        <Box>
          <Text color="gray">  SERVER DAEMON </Text>
          <Text color="cyan" bold>v{DAEMON_VERSION}</Text>
        </Box>
      </Box>

      {status === 'init' && (
        <Box gap={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="gray"> Connecting to Void Network...</Text>
        </Box>
      )}

      {status === 'waiting' && (
        <Box flexDirection="column" gap={1}>
          <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1}>
            <Text color="yellow" bold>⚡ Authentication Required</Text>
            <Text color="gray">Open this link in your browser to sign in:</Text>
            <Text> </Text>
            <Text color="cyan" bold>  {authUrl}</Text>
            <Text> </Text>
            {qrLines.length > 0 && (
              <Box flexDirection="column">
                <Text color="gray" dimColor>Scan on mobile:</Text>
                {qrLines.map((line, i) => (
                  <Text key={i}>{line}</Text>
                ))}
                <Text> </Text>
              </Box>
            )}
            <Text color="gray" dimColor>  Ctrl+Click (Windows/Linux)  or  Cmd+Click (Mac) to open</Text>
          </Box>
          <Box gap={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text color="gray"> Waiting for authentication</Text>
            <Text color="gray" dimColor>  (session: {sessionId.slice(0, 12)}...)</Text>
          </Box>
          <Text color="gray" dimColor>Session expires in 10 minutes</Text>
        </Box>
      )}

      {status === 'success' && (
        <Box gap={1}>
          <Text color="green" bold>✓</Text>
          <Text color="white"> Authenticated! Loading your dashboard...</Text>
        </Box>
      )}

      {status === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color="red" bold>✗ Authentication Failed</Text>
          <Text color="gray">{error}</Text>
          <Text color="yellow" dimColor>Restart Void Server to try again.</Text>
        </Box>
      )}
    </Box>
  );
};
