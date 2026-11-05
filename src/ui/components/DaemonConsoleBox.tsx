import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { getDaemonLogs, subscribeDaemonLogs, type DaemonLogEntry } from '../../utils/activityLogger.js';

interface DaemonConsoleBoxProps {
  width: number;
  height: number;
}

const TYPE_COLORS: Record<DaemonLogEntry['type'], string> = {
  webrtc: 'cyan',
  server: 'green',
  system: 'white',
  auth: 'magenta',
  warn: 'yellow',
  error: 'red',
};

export const DaemonConsoleBox: React.FC<DaemonConsoleBoxProps> = ({ width, height }) => {
  const [logs, setLogs] = useState<DaemonLogEntry[]>(() => getDaemonLogs());

  useEffect(() => {
    const unsub = subscribeDaemonLogs(() => {
      setLogs(getDaemonLogs());
    });
    return () => unsub();
  }, []);

  const safeWidth = Math.max(24, width);
  const safeHeight = Math.max(12, height);
  // Total capacity = height minus top border, title, divider line, bottom border
  const maxLines = Math.max(4, safeHeight - 4);
  const visibleLogs = logs.slice(-maxLines);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      width={safeWidth}
      height={safeHeight}
    >
      <Box justifyContent="space-between" marginBottom={0}>
        <Box gap={1}>
          <Text bold color="cyan">DAEMON CONSOLE</Text>
        </Box>
        <Text color="green" bold>● LIVE</Text>
      </Box>

      <Box marginBottom={0}>
        <Text color="gray" dimColor>{'─'.repeat(Math.max(10, safeWidth - 4))}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {visibleLogs.length === 0 ? (
          <Box paddingY={1}>
            <Text color="gray" dimColor>Listening for WebRTC & server events...</Text>
          </Box>
        ) : (
          visibleLogs.map(log => {
            const availWidth = Math.max(8, safeWidth - 14);
            const truncated = log.message.length > availWidth
              ? log.message.slice(0, availWidth - 1) + '…'
              : log.message;
            const color = TYPE_COLORS[log.type] || 'white';

            return (
              <Box key={log.id}>
                <Text color="gray" dimColor>{log.timestamp} </Text>
                <Text color={color} wrap="truncate">{truncated}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};
