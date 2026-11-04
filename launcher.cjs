function launch() {
  try {
    require('./dist/bundle.cjs');
  } catch (err) {
    console.error('[VOID] Fatal Launch Error:');
    console.error(err);
    process.exit(1);
  }
}

launch();
