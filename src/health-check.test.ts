import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkMcpEndpoint } from './health-check.js';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const accept = req.headers['accept'];
    if (!accept?.includes('text/event-stream')) {
      res.writeHead(406);
      res.end('Not Acceptable');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

describe('checkMcpEndpoint', () => {
  it('reports reachable for a running server', async () => {
    const result = await checkMcpEndpoint(`http://127.0.0.1:${port}/mcp`, 2000);
    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('sends the correct Accept header', async () => {
    const result = await checkMcpEndpoint(`http://127.0.0.1:${port}/mcp`, 2000);
    expect(result.statusCode).toBe(200);
  });

  it('reports reachable even on non-200 status codes', async () => {
    const result = await checkMcpEndpoint(
      `http://127.0.0.1:${port}/unknown`,
      2000,
    );
    expect(result.reachable).toBe(true);
    expect(result.statusCode).toBeDefined();
  });

  it('reports unreachable for a dead port', async () => {
    const result = await checkMcpEndpoint('http://127.0.0.1:19999/mcp', 1000);
    expect(result.reachable).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });
});
