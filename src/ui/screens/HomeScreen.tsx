import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { Header } from '../components/Header.js';
import { listServers, type ServerMeta } from '../../server/manager.js';
import { isRunning } from '../../server/instance.js';
import type { UserSession } from '../../auth/session.js';

interface HomeScreenProps {
  session: UserSession;
  onCreateServer: () => void;
  onOpenServer: (name: string) => void;
  onLogout: () => void;
}

interface SelectItem {
  label: string;
  value: string;
}

// Custom indicator
const Indicator: React.FC<{ isSelected?: boolean }> = ({ isSelected }) => (
  <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
);

// Server list item — note: ink-select-input only passes isSelected+label to itemComponent.
// We detect running state by parsing the server name from the label's first segment.
const ServerItem: React.FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => {
  // Name is the first segment before ' │'
  const name = label.split(' │')[0].trim();
  const running = isRunning(name);
  return (
    <Box>
      <Text color={running ? 'green' : 'red'}>{running ? '● ' : '○ '}</Text>
      <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
        {label}
      </Text>
    </Box>
  );
};

// Action list item
const ActionItem: React.FC<{ isSelected?: boolean; label: string }> = ({ isSelected, label }) => (
  <Text color={isSelected ? 'cyan' : 'gray'}>{label}</Text>
);

export const HomeScreen: React.FC<HomeScreenProps> = ({
  session,
  onCreateServer,
  onOpenServer,
  onLogout,
}) => {
  const { exit } = useApp();
  const [servers, setServers] = useState<ServerMeta[]>([]);
  const [focusArea, setFocusArea] = useState<'servers' | 'actions'>('servers');

  const refresh = useCallback(() => setServers(listServers()), []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (servers.length === 0 && focusArea === 'servers') {
      setFocusArea('actions');
    }
  }, [servers.length, focusArea]);

  useInput((input, key) => {
    if (key.tab) {
      if (servers.length > 0) {
        setFocusArea(prev => prev === 'servers' ? 'actions' : 'servers');
      }
    }
  });

  const serverItems: SelectItem[] = servers.map(s => ({
    label: `${s.name.padEnd(22)} │ ${(s.type[0].toUpperCase() + s.type.slice(1)).padEnd(8)} ${s.version.padEnd(10)} │ ${s.ram} │ :${s.port}`,
    value: s.name,
  }));

  const actionItems: SelectItem[] = [
    { label: '  + Create New Server', value: 'create' },
    { label: '  ⟳ Refresh', value: 'refresh' },
    { label: '  → Logout', value: 'logout' },
    { label: '  ✕ Quit', value: 'quit' },
  ];

  return (
    <Box flexDirection="column">
      <Header session={session} />

      {/* Server list */}
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingX={1} marginBottom={0} gap={1}>
          <Text bold color="white">MY SERVERS</Text>
          <Text color={servers.length > 0 ? 'cyan' : 'gray'}>({servers.length})</Text>
          {focusArea === 'servers' && <Text bold color="yellow"> [Active]</Text>}
        </Box>

        {servers.length === 0 ? (
          <Box borderStyle="single" borderColor="gray" paddingX={2} paddingY={1}>
            <Text color="gray">No servers yet — create your first one below!</Text>
          </Box>
        ) : (
          <Box flexDirection="column" borderStyle="single" borderColor={focusArea === 'servers' ? 'cyan' : 'gray'}>
            <Box paddingX={2}>
              <Text color="gray" dimColor>
                {'Status  Name                    │ Type     Version    │ RAM  │ Port'}
              </Text>
            </Box>
            <Box paddingX={0}>
              <Text color="gray" dimColor>{'─'.repeat(71)}</Text>
            </Box>
            <Box paddingX={0}>
              <SelectInput
                isFocused={focusArea === 'servers'}
                items={serverItems}
                onSelect={item => onOpenServer(item.value)}
                indicatorComponent={Indicator}
                itemComponent={ServerItem}
              />
            </Box>
          </Box>
        )}
      </Box>

      {/* Actions */}
      <Box flexDirection="column" marginBottom={0}>
        <Box paddingX={1} marginBottom={0} gap={1}>
          <Text bold color="white">ACTIONS</Text>
          {focusArea === 'actions' && <Text bold color="yellow"> [Active]</Text>}
        </Box>

        <Box flexDirection="column" borderStyle="single" borderColor={focusArea === 'actions' ? 'cyan' : 'gray'} paddingX={1} paddingY={0}>
          <SelectInput
            isFocused={focusArea === 'actions'}
            items={actionItems}
            onSelect={item => {
              if (item.value === 'create') onCreateServer();
              else if (item.value === 'refresh') refresh();
              else if (item.value === 'logout') onLogout();
              else if (item.value === 'quit') process.emit('SIGINT');
            }}
            indicatorComponent={Indicator}
            itemComponent={ActionItem}
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>↑↓ Navigate  │  Enter Select  │  Tab Switch Pane</Text>
      </Box>
    </Box>
  );
};
