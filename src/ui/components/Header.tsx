import React from 'react';
import { Box, Text } from 'ink';
import type { UserSession } from '../../auth/session.js';

interface HeaderProps {
  session?: UserSession | null;
}

const LOGO_LINES = [
  ' ██╗   ██╗ ██████╗ ██╗██████╗ ',
  ' ██║   ██║██╔═══██╗██║██╔══██╗',
  ' ██║   ██║██║   ██║██║██║  ██║',
  ' ╚██╗ ██╔╝██║   ██║██║██║  ██║',
  '  ╚████╔╝ ╚██████╔╝██║██████╔╝',
  '   ╚═══╝   ╚═════╝ ╚═╝╚═════╝ ',
];

export const Header: React.FC<HeaderProps> = ({ session }) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="cyan"
    paddingX={2}
    paddingY={0}
    marginBottom={1}
  >
    {LOGO_LINES.map((line, i) => (
      <Text key={i} color="cyan" bold>
        {line}
      </Text>
    ))}
    <Box>
      <Text color="gray">  SERVER DAEMON </Text>
      <Text color="cyan" bold>v0.1.0</Text>
      {session && (
        <>
          <Text color="gray">  │  </Text>
          <Text color="green">✓ </Text>
          <Text color="white">{session.email || session.uid}</Text>
        </>
      )}
    </Box>
  </Box>
);
