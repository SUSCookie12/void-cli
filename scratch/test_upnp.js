import * as upnp from 'upnp-client';
console.log('Testing upnp-client...');
try {
  upnp.searchGateway(1000, (err, gateway) => {
    if (err) {
      console.error('Search failed:', err);
    } else if (gateway) {
      console.log('Found gateway:', gateway.host);
    } else {
      console.log('No gateway found.');
    }
    process.exit(0);
  });
} catch (e) {
  console.error('Crash during searchGateway:', e);
  process.exit(1);
}
