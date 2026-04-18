"""Atomic secure file writes for tokens and state files.

Write to `{target}.tmp` with mode 0o600, fsync, rename over target.
Used for any file holding a secret (OAuth tokens, state files).
"""

import os
from pathlib import Path
from typing import Union


def write_file_secure(
    target: Union[str, Path],
    content: Union[str, bytes],
    *,
    mode: int = 0o600,
) -> None:
    target = Path(target)
    tmp = target.with_name(target.name + ".tmp")

    fd = None
    try:
        # O_WRONLY | O_CREAT | O_TRUNC, create with requested mode
        fd = os.open(
            tmp,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            mode,
        )
        if isinstance(content, str):
            data = content.encode("utf-8")
        else:
            data = content
        os.write(fd, data)
        os.fsync(fd)
        os.close(fd)
        fd = None

        os.replace(tmp, target)
        # Belt-and-braces chmod in case O_CREAT mode was filtered by umask
        os.chmod(target, mode)
    except Exception:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass
        raise
