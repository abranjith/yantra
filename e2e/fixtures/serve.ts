import { readFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), 'site');

export interface FixtureServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Start the browser fixture on an ephemeral loopback port. */
export async function serveFixtureSite(): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    void serveRequest(request.url ?? '/', response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function serveRequest(path: string, response: ServerResponse): Promise<void> {
  try {
    const pathname = new URL(path, 'http://fixture').pathname;
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safe = normalize(relative);
    if (safe.startsWith('..')) throw new Error('invalid fixture path');
    const body = await readFile(join(siteRoot, safe));
    response.writeHead(200, { 'content-type': contentType(extname(safe)) });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function contentType(extension: string): string {
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  return 'text/plain; charset=utf-8';
}
