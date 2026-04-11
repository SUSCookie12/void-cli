import NatAPI from 'nat-api';
import https from 'node:https';

export async function tryPortForward(publicPort: number, localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      console.log(`[UPnP] Attempting to map ${publicPort} -> ${localPort} using NatAPI...`);
      const client = new NatAPI();
      
      client.map({ publicPort, privatePort: localPort, protocol: 'TCP' }, (err) => {
        if (err) {
          console.error('[UPnP] Port mapping failed:', err);
          resolve(false);
        } else {
          console.log(`[UPnP] Successfully mapped ${publicPort} -> ${localPort} (TCP)`);
          resolve(true);
        }
        client.destroy();
      });
    } catch (err) {
      console.error('[UPnP] Unexpected error:', err);
      resolve(false);
    }
  });
}

export async function removePortForward(publicPort: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const client = new NatAPI();
      client.unmap({ publicPort, protocol: 'TCP' }, () => {
         console.log(`[UPnP] Unmapped port ${publicPort}`);
         client.destroy();
         resolve();
      });
    } catch {
      resolve();
    }
  });
}

export async function getPublicIp(): Promise<string | null> {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', (err) => {
      console.error('[IP] Failed to get public IP:', err);
      resolve(null);
    });
  });
}
