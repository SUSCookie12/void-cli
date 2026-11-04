// @ts-ignore
import NatAPI from 'nat-api';
import https from 'node:https';

export async function tryPortForward(publicPort: number, localPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      console.log(`[UPnP] Attempting to map ${publicPort} -> ${localPort} using NatAPI...`);
      const client = new NatAPI();
      
      client.map({ publicPort, privatePort: localPort, protocol: 'TCP' }, (err: any) => {
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

let cachedPublicIp: { ip: string | null; timestamp: number } | null = null;

export async function getPublicIp(): Promise<string | null> {
  if (cachedPublicIp && Date.now() - cachedPublicIp.timestamp < 300000) {
    return cachedPublicIp.ip;
  }

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val: string | null) => {
      if (!resolved) {
        resolved = true;
        if (val) cachedPublicIp = { ip: val, timestamp: Date.now() };
        resolve(val);
      }
    };

    const timer = setTimeout(() => {
      safeResolve(cachedPublicIp?.ip ?? null);
    }, 2500);

    const req = https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        safeResolve(data.trim() || null);
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      console.error('[IP] Failed to get public IP:', err);
      safeResolve(cachedPublicIp?.ip ?? null);
    });

    req.setTimeout(2500, () => {
      req.destroy();
      clearTimeout(timer);
      safeResolve(cachedPublicIp?.ip ?? null);
    });
  });
}
