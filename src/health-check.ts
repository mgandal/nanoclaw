import http from 'http';

export interface HealthCheckResult {
  reachable: boolean;
  statusCode?: number;
}

export function checkMcpEndpoint(
  url: string,
  timeoutMs = 3000,
): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'GET',
          headers: { Accept: 'application/json, text/event-stream' },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume(); // drain response to free socket
          resolve({ reachable: true, statusCode: res.statusCode });
        },
      );
      req.on('error', () => {
        resolve({ reachable: false });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false });
      });
      req.end();
    } catch {
      resolve({ reachable: false });
    }
  });
}
