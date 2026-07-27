import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

describe('claw skill script', () => {
  it('exits zero after successful structured output even if the runtime is terminated', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-skill-test-'));
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    // claw refuses to run without the credential proxy's token file.
    fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'store', '.credential-proxy-token'),
      'test-proxy-token-abc',
    );

    const runtimePath = path.join(binDir, 'container');
    fs.writeFileSync(
      runtimePath,
      `#!/bin/sh
cat >/dev/null
printf '%s\n' '---NANOCLAW_OUTPUT_START---' '{"status":"success","result":"4","newSessionId":"sess-1"}' '---NANOCLAW_OUTPUT_END---'
sleep 30
`,
    );
    fs.chmodSync(runtimePath, 0o755);

    const result = spawnSync(
      'python3',
      ['.claude/skills/claw/scripts/claw', '-j', 'tg:123', 'What is 2+2?'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NANOCLAW_DIR: tempDir,
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
        timeout: 15000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('4');
    expect(result.stderr).toContain('[session: sess-1]');
  }, 20000);

  // The container never reads credentials from the JSON payload — agent-runner
  // builds its SDK env from process.env alone (container/agent-runner/src/
  // index.ts:890). claw used to ship an inert `secrets` payload field instead,
  // so every run reached the SDK unauthenticated and died with "Claude Code
  // process exited with code 1" while claw itself reported nothing wrong.
  describe('credential wiring', () => {
    function runClaw(extra: Record<string, string> = {}) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-cred-test-'));
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'store', '.credential-proxy-token'),
        'test-proxy-token-abc',
      );
      fs.writeFileSync(
        path.join(tempDir, '.env'),
        'CLAUDE_CODE_OAUTH_TOKEN=sk-should-never-reach-the-container\n',
      );

      const argvDump = path.join(tempDir, 'argv.txt');
      const runtimePath = path.join(binDir, 'container');
      fs.writeFileSync(
        runtimePath,
        `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a" >>${argvDump}; done
cat >${path.join(tempDir, 'payload.json')}
printf '%s\\n' '---NANOCLAW_OUTPUT_START---' '{"status":"success","result":"ok"}' '---NANOCLAW_OUTPUT_END---'
`,
      );
      fs.chmodSync(runtimePath, 0o755);

      const result = spawnSync(
        'python3',
        ['.claude/skills/claw/scripts/claw', '-j', 'tg:123', 'hi'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            NANOCLAW_DIR: tempDir,
            PATH: `${binDir}:${process.env.PATH || ''}`,
            ...extra,
          },
          timeout: 15000,
        },
      );
      const argv = fs.existsSync(argvDump)
        ? fs.readFileSync(argvDump, 'utf8').split('\n').filter(Boolean)
        : [];
      const payload = fs.existsSync(path.join(tempDir, 'payload.json'))
        ? JSON.parse(fs.readFileSync(path.join(tempDir, 'payload.json'), 'utf8'))
        : {};
      return { result, argv, payload };
    }

    it('routes the container at the credential proxy via ANTHROPIC_BASE_URL', () => {
      const { argv } = runClaw();
      expect(argv).toContain(
        'ANTHROPIC_BASE_URL=http://192.168.64.1:3002/test-proxy-token-abc',
      );
    });

    it('sends a placeholder auth token so the SDK triggers the proxy exchange', () => {
      const { argv } = runClaw();
      expect(argv).toContain('ANTHROPIC_AUTH_TOKEN=placeholder');
    });

    it('never puts the real OAuth token in the container args or payload', () => {
      const { argv, payload } = runClaw();
      const blob = `${argv.join('\n')}\n${JSON.stringify(payload)}`;
      expect(blob).not.toContain('sk-should-never-reach-the-container');
      expect(payload).not.toHaveProperty('secrets');
    });

    it('warns instead of running unauthenticated when the proxy token is missing', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-notok-'));
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const runtimePath = path.join(binDir, 'container');
      fs.writeFileSync(runtimePath, '#!/bin/sh\ncat >/dev/null\n');
      fs.chmodSync(runtimePath, 0o755);

      const result = spawnSync(
        'python3',
        ['.claude/skills/claw/scripts/claw', '-j', 'tg:123', 'hi'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            NANOCLAW_DIR: tempDir,
            PATH: `${binDir}:${process.env.PATH || ''}`,
          },
          timeout: 15000,
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/credential proxy|NanoClaw.*running/i);
    });
  });
});
