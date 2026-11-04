import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { Header } from '../components/Header.js';
import {
  startServer,
  stopServer,
  killServer,
  sendCommand,
  isRunning,
  getServerLogs,
  subscribeToLogs,
  type LogLine,
} from '../../server/instance.js';
import { deleteServer, type ServerMeta } from '../../server/manager.js';
import type { UserSession } from '../../auth/session.js';
import { FileExplorerScreen } from './FileExplorerScreen.js';
import { ShareAccessScreen } from './ShareAccessScreen.js';

interface Props {
  meta: ServerMeta;
  session: UserSession;
  onBack: () => void;
}

type Pane = 'actions' | 'console' | 'files' | 'share';

const LOG_COLOR: Record<string, string> = {
  info: 'white',
  warn: 'yellow',
  error: 'red',
  system: 'cyan',
};

const Indicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
);
const Item: React.FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => (
  <Text color={isSelected ? 'cyan' : 'white'}>{label}</Text>
);

export const ServerDetailScreen: React.FC<Props> = ({ meta, session, onBack }) => {
  const [pane, setPane] = useState<Pane>('actions');
  const [logs, setLogs] = useState<LogLine[]>(() => getServerLogs(meta.name));
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(() => isRunning(meta.name));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const logRef = useRef<LogLine[]>([]);

  const refreshRunning = useCallback(() => setRunning(isRunning(meta.name)), [meta.name]);

  useEffect(() => {
    const timer = setInterval(refreshRunning, 1000);
    return () => clearInterval(timer);
  }, [refreshRunning]);

  useEffect(() => {
    const initialLogs = getServerLogs(meta.name);
    logRef.current = initialLogs;
    setLogs([...initialLogs]);

    const unsub = subscribeToLogs(meta.name, log => {
      logRef.current = [...logRef.current.slice(-499), log];
      setLogs([...logRef.current]);
    });
    return unsub;
  }, [meta.name]);

  useInput((input, key) => {
    if (pane === 'share') return;
    if (key.escape) {
      if (pane === 'console') setPane('actions');
      else onBack();
    }
    if (input === 'c' || input === 'C') setPane('console');
    if (input === 'a' || input === 'A') setPane('actions');
    if (input === 'f' || input === 'F') setPane('files');
    if (input === 's' || input === 'S') setPane('share');
  });

  const sendCmd = useCallback((cmd: string) => {
    sendCommand(meta.name, cmd);
    setCommand('');
  }, [meta.name]);

  const visibleLogs = logs.slice(-20);

  const statusColor = running ? 'green' : 'red';
  const statusText = running ? '● RUNNING' : '○ STOPPED';

  return (
    <Box flexDirection="column">
      <Header session={session} />

      {/* Server info bar */}
      <Box
        borderStyle="single"
        borderColor="cyan"
        paddingX={2}
        paddingY={0}
        marginBottom={1}
        gap={2}
      >
        <Text bold color="white">{meta.name}</Text>
        <Text color={statusColor} bold>{statusText}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">
          {meta.type === 'paper' ? 'Paper' : meta.type === 'fabric' ? 'Fabric' : meta.type === 'forge' ? 'Forge' : meta.type === 'purpur' ? 'Purpur' : meta.type === 'neoforge' ? 'NeoForge' : meta.type === 'quilt' ? 'Quilt' : meta.type === 'arclight' ? 'Arclight' : 'Vanilla'} {meta.version}
        </Text>
        <Text color="gray">│</Text>
        <Text color="gray">RAM: {meta.ram}</Text>
        <Text color="gray">│</Text>
        <Text color="gray">Port: :{meta.port}</Text>
      </Box>

      {/* Tab bar */}
      <Box paddingX={2} marginBottom={1} gap={2}>
        <Text
          color={pane === 'actions' ? 'cyan' : 'gray'}
          bold={pane === 'actions'}
          underline={pane === 'actions'}
        >
          [A] Actions
        </Text>
        <Text
          color={pane === 'console' ? 'cyan' : 'gray'}
          bold={pane === 'console'}
          underline={pane === 'console'}
        >
          [C] Console
        </Text>
        <Text
          color={pane === 'files' ? 'cyan' : 'gray'}
          bold={pane === 'files'}
          underline={pane === 'files'}
        >
          [F] Files
        </Text>
        <Text
          color={pane === 'share' ? 'cyan' : 'gray'}
          bold={pane === 'share'}
          underline={pane === 'share'}
        >
          [S] Share Access
        </Text>
        <Text color="gray">  Esc to go back</Text>
      </Box>

      {/* ── PANE: ACTIONS ── */}
      {pane === 'actions' && (
        <Box flexDirection="column" gap={1} paddingX={1}>
          {!confirmDelete ? (
            <SelectInput
              items={[
                ...(running
                  ? [
                      { label: '  ■ Stop Server    (graceful)', value: 'stop' },
                      { label: '  ✕ Kill Server    (force)', value: 'kill' },
                    ]
                  : [{ label: '  ▶ Start Server', value: 'start' }]),
                { label: '  ⌨  Open Console', value: 'console' },
                { label: '  📂 File Explorer', value: 'files' },
                { label: '  🤝 Share Access', value: 'share' },
                { label: '  ✕ Delete Server', value: 'delete' },
                { label: '  ← Back', value: 'back' },
              ]}
              onSelect={item => {
                if (item.value === 'start') {
                  startServer(meta);
                  refreshRunning();
                } else if (item.value === 'stop') {
                  stopServer(meta.name);
                } else if (item.value === 'kill') {
                  killServer(meta.name);
                } else if (item.value === 'console') {
                  setPane('console');
                } else if (item.value === 'files') {
                  setPane('files');
                } else if (item.value === 'share') {
                  setPane('share');
                } else if (item.value === 'delete') {
                  setConfirmDelete(true);
                } else if (item.value === 'back') {
                  onBack();
                }
              }}
              indicatorComponent={Indicator}
              itemComponent={Item}
            />
          ) : (
            <Box flexDirection="column" gap={1}>
              <Text color="red" bold> ⚠  Are you sure you want to DELETE "{meta.name}"?</Text>
              <Text color="gray"> This action cannot be undone. All world data will be lost.</Text>
              <SelectInput
                items={[
                  { label: '  ✕ Yes, Delete Permanently', value: 'confirm' },
                  { label: '  ← No, Cancel', value: 'cancel' },
                ]}
                onSelect={item => {
                  if (item.value === 'confirm') {
                    if (running) killServer(meta.name);
                    deleteServer(meta.name);
                    onBack();
                  } else {
                    setConfirmDelete(false);
                  }
                }}
                indicatorComponent={Indicator}
                itemComponent={Item}
              />
            </Box>
          )}
        </Box>
      )}

      {/* ── PANE: CONSOLE ── */}
      {pane === 'console' && (
        <Box flexDirection="column">
          {/* Log output */}
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            height={22}
          >
            {visibleLogs.length === 0 ? (
              <Text color="gray" dimColor>  No log output yet...</Text>
            ) : (
              visibleLogs.map((log, i) => (
                <Box key={i}>
                  <Text color="gray" dimColor>
                    {log.timestamp.toTimeString().slice(0, 8)}{' '}
                  </Text>
                  <Text color={LOG_COLOR[log.level] ?? 'white'}>
                    {log.text}
                  </Text>
                </Box>
              ))
            )}
          </Box>

          {/* Command input */}
          <Box paddingX={1} paddingY={0} gap={1} borderStyle="single" borderColor="cyan">
            <Text color="cyan" bold>❯</Text>
            {running ? (
              <TextInput
                value={command}
                onChange={setCommand}
                onSubmit={sendCmd}
                placeholder="Type a command and press Enter..."
              />
            ) : (
              <Text color="gray" dimColor> Server is not running</Text>
            )}
          </Box>
        </Box>
      )}

      {/* ── PANE: FILES ── */}
      {pane === 'files' && (
        <FileExplorerScreen 
          serverName={meta.name}
          onBack={() => setPane('actions')} 
        />
      )}

      {/* ── PANE: SHARE ACCESS ── */}
      {pane === 'share' && (
        <ShareAccessScreen
          serverName={meta.name}
          session={session}
          onBack={() => setPane('actions')}
        />
      )}
    </Box>
  );
};
