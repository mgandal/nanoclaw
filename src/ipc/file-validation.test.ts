import { describe, it, expect } from 'vitest';

import {
  isValidAgentName,
  isFileCredentialLike,
  isSendFileExtensionAllowed,
} from './file-validation.js';

describe('isValidAgentName', () => {
  it('accepts a plain alphanumeric name', () => {
    expect(isValidAgentName('claire')).toBe(true);
  });

  it('accepts underscores and hyphens in the body', () => {
    expect(isValidAgentName('agent_1')).toBe(true);
    expect(isValidAgentName('franklin-claw')).toBe(true);
  });

  it('rejects a leading hyphen or underscore', () => {
    expect(isValidAgentName('-bad')).toBe(false);
    expect(isValidAgentName('_bad')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isValidAgentName('..')).toBe(false);
    expect(isValidAgentName('../escape')).toBe(false);
    expect(isValidAgentName('a/b')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidAgentName('')).toBe(false);
  });

  it('accepts a 64-char name but rejects 65 (length cap)', () => {
    expect(isValidAgentName('a'.repeat(64))).toBe(true);
    expect(isValidAgentName('a'.repeat(65))).toBe(false);
  });
});

describe('isFileCredentialLike — filename patterns', () => {
  const empty = Buffer.alloc(0);

  it('flags credentials.json by name', () => {
    expect(isFileCredentialLike('/x/credentials.json', empty)).toBe(true);
  });

  it('flags .pem and .key extensions', () => {
    expect(isFileCredentialLike('/x/bundle.pem', empty)).toBe(true);
    expect(isFileCredentialLike('/x/server.key', empty)).toBe(true);
  });

  it('flags .env and ssh private keys by name', () => {
    expect(isFileCredentialLike('/x/.env', empty)).toBe(true);
    expect(isFileCredentialLike('/x/id_rsa', empty)).toBe(true);
    expect(isFileCredentialLike('/x/id_ed25519', empty)).toBe(true);
  });

  it('flags paperclip-*.json and oauth* by name', () => {
    expect(isFileCredentialLike('/x/paperclip-prod.json', empty)).toBe(true);
    expect(isFileCredentialLike('/x/oauth-token', empty)).toBe(true);
  });

  it('does not flag an innocuous report by name+empty body', () => {
    expect(isFileCredentialLike('/x/report.pdf', empty)).toBe(false);
  });
});

describe('isFileCredentialLike — content sample (rename bypass)', () => {
  it('flags a renamed file whose body contains a refresh_token', () => {
    const body = Buffer.from('{"refresh_token":"1//abc"}', 'utf-8');
    expect(isFileCredentialLike('/x/notes.json', body)).toBe(true);
  });

  it('flags a body containing a PEM private-key header', () => {
    const body = Buffer.from(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
      'utf-8',
    );
    expect(isFileCredentialLike('/x/data.txt', body)).toBe(true);
  });

  it('flags a slack bot token and a github PAT in the body', () => {
    expect(
      isFileCredentialLike(
        '/x/log.txt',
        Buffer.from('token=xoxb-1234567890-abcdef', 'utf-8'),
      ),
    ).toBe(true);
    expect(
      isFileCredentialLike(
        '/x/log.txt',
        Buffer.from('ghp_abcdefghijklmnopqrstuvwxyz0123', 'utf-8'),
      ),
    ).toBe(true);
  });

  it('passes a clean text body with an innocuous name', () => {
    const body = Buffer.from('the quick brown fox', 'utf-8');
    expect(isFileCredentialLike('/x/story.txt', body)).toBe(false);
  });

  it('only samples the first 64KB of the buffer', () => {
    // A secret beyond the 64KB cap must NOT be detected — documents the
    // DoS-guard boundary (read is capped at 65536 bytes).
    const padding = Buffer.alloc(65536, 0x20); // 64KB of spaces
    const secret = Buffer.from('refresh_token', 'utf-8');
    const body = Buffer.concat([padding, secret]);
    expect(isFileCredentialLike('/x/big.txt', body)).toBe(false);
  });
});

describe('isSendFileExtensionAllowed', () => {
  it('allows common produced formats', () => {
    expect(isSendFileExtensionAllowed('/x/report.pdf')).toBe(true);
    expect(isSendFileExtensionAllowed('/x/chart.png')).toBe(true);
    expect(isSendFileExtensionAllowed('/x/data.csv')).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isSendFileExtensionAllowed('/x/IMG.PNG')).toBe(true);
  });

  it('rejects extensionless files', () => {
    expect(isSendFileExtensionAllowed('/x/Makefile')).toBe(false);
  });

  it('rejects dotfiles', () => {
    expect(isSendFileExtensionAllowed('/x/.env')).toBe(false);
  });

  it('rejects extensions outside the allowlist', () => {
    expect(isSendFileExtensionAllowed('/x/archive.tar')).toBe(false);
    expect(isSendFileExtensionAllowed('/x/binary.exe')).toBe(false);
    expect(isSendFileExtensionAllowed('/x/db.sqlite')).toBe(false);
  });
});
