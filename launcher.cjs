const path = require('path');

function launch() {
  try {
    require(path.join(__dirname, 'dist', 'bundle.cjs'));
  } catch (err) {
    console.error('[VOID] Fatal Launch Error:');
    console.error(err);
    process.exit(1);
  }
}

launch();
