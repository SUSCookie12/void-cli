import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import { URL } from 'node:url';

/**
 * Downloads a file to `dest` using native Node http/https modules,
 * automatically following HTTP redirects (up to `maxRedirects`).
 * Tracks progress via `res.on('data')` and content-length header.
 * Cleans up partial files and streams on any error.
 */
export function downloadFile(
  url: string,
  dest: string,
  onProgress?: (pct: number) => void,
  maxRedirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirectCount = 0;
    let fileStream: fs.WriteStream | null = null;
    let finished = false;

    const cleanup = (unlinkDest = true) => {
      if (fileStream) {
        try {
          fileStream.destroy();
        } catch {}
        fileStream = null;
      }
      if (unlinkDest && fs.existsSync(dest)) {
        try {
          fs.unlinkSync(dest);
        } catch {}
      }
    };

    const fail = (err: Error) => {
      if (finished) return;
      finished = true;
      cleanup(true);
      reject(err);
    };

    const succeed = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    const makeRequest = (currentUrl: string) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(currentUrl);
      } catch (e: any) {
        fail(new Error(`Invalid URL: ${currentUrl} (${e?.message || e})`));
        return;
      }

      const client = parsedUrl.protocol === 'http:' ? http : https;
      const req = client.get(
        parsedUrl,
        {
          headers: {
            'User-Agent': 'VoidServer/1.0',
            Accept: '*/*',
          },
        },
        (res) => {
          // Follow HTTP redirects (301, 302, 303, 307, 308)
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            res.headers.location
          ) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
              res.resume();
              fail(new Error(`Too many redirects (exceeded limit of ${maxRedirects}) while downloading ${url}`));
              return;
            }
            res.resume();
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            makeRequest(nextUrl);
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            fail(new Error(`Download failed: HTTP ${res.statusCode ?? 'unknown'} (${res.statusMessage ?? ''})`));
            return;
          }

          const rawLength = res.headers['content-length'];
          const total = rawLength ? parseInt(rawLength, 10) : 0;
          let downloaded = 0;

          fileStream = createWriteStream(dest);

          fileStream.on('error', (err) => {
            res.destroy();
            fail(err);
          });

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            if (total > 0 && onProgress) {
              const pct = Math.min(100, Math.floor((downloaded / total) * 100));
              onProgress(pct);
            }
          });

          res.on('error', (err) => {
            fail(err);
          });

          fileStream.on('finish', () => {
            if (fileStream) {
              fileStream.close(() => succeed());
            } else {
              succeed();
            }
          });

          res.pipe(fileStream);
        }
      );

      req.on('error', (err) => {
        fail(err);
      });

      req.setTimeout(60000, () => {
        req.destroy(new Error(`Download timed out after 60s for ${currentUrl}`));
      });
    };

    makeRequest(url);
  });
}
