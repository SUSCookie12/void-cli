#!/usr/bin/env node
import { startUI } from './ui/App.js';
import { initFirebase } from './config/firebase.js';

process.title = 'void-server';

// Initialize Firebase before rendering UI or accessing the DB
initFirebase();

import { stopAllServers, setShuttingDown } from './server/instance.js';

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

startUI();
