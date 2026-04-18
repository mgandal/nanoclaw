import fs from 'fs';

export interface WriteSecureOptions {
  mode: number; // e.g. 0o600
}

/**
 * Atomically write a file and set its mode. Write to `{target}.tmp`,
 * fsync, rename over the target, then chmod. Used for any file that
 * holds a secret (OAuth tokens, state files with session metadata).
 *
 * On any failure the temp file is removed and the exception propagates.
 */
export function writeFileSecure(
  target: string,
  content: string | Buffer,
  opts: WriteSecureOptions,
): void {
  if (target.includes('\x00')) {
    throw new Error('writeFileSecure: target contains NUL byte');
  }
  const tmp = `${target}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w', opts.mode);
    fs.writeSync(fd, content as any);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    // Belt-and-braces: chmod after rename in case an fs layer ignored mode on open
    fs.chmodSync(target, opts.mode);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp may not exist */
    }
    throw err;
  }
}
