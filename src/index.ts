#!/usr/bin/env node
import { startUI } from './ui/App.js';
import { initFirebase } from './config/firebase.js';
import { enforceVoidServerVersionFromRemote } from './config/remoteVersion.js';

import { stopAllServers, setShuttingDown } from './server/instance.js';

process.title = 'void-server';

// Handle graceful shutdown
const shutdown = async () => {
  try {
    setShuttingDown(true);
    console.log('\n[VOID] Shutting down Void Server gracefully...');
    await stopAllServers();
  } catch (err) {
    console.error('[VOID] Error during shutdown:', err);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main(): Promise<void> {
  await enforceVoidServerVersionFromRemote();
  initFirebase();
  startUI();
}

void main();
