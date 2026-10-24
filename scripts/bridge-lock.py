#!/usr/bin/env python3
"""Hold a private, stable-inode flock for the Node parent's pipe lifetime."""
import errno
import fcntl
import json
import os
import stat
import sys


class UnsafePath(Exception):
    pass


class AlreadyRunning(Exception):
    pass


def same_inode(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def require_owned(info, directory=False):
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid != os.getuid() or (not directory and info.st_nlink != 1):
        raise UnsafePath()


def main():
    directory, parent_pid, nonce = sys.argv[1:]
    parent_pid = int(parent_pid)
    if parent_pid != os.getppid() or len(nonce) != 36:
        raise UnsafePath()
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock_fd = None
    locked = False
    try:
        directory_info = os.fstat(directory_fd)
        require_owned(directory_info, directory=True)
        os.fchmod(directory_fd, 0o700)
        if not same_inode(directory_info, os.stat(directory, follow_symlinks=False)):
            raise UnsafePath()
        flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            lock_fd = os.open('bridge.lock', flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
        except FileExistsError:
            lock_fd = os.open('bridge.lock', flags, dir_fd=directory_fd)
        lock_info = os.fstat(lock_fd)
        require_owned(lock_info)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EACCES):
                raise AlreadyRunning() from None
            raise
        locked = True
        # Refuse a path that changed while being opened; never follow or unlink it.
        if not same_inode(lock_info, os.stat('bridge.lock', dir_fd=directory_fd, follow_symlinks=False)):
            raise UnsafePath()
        if not same_inode(directory_info, os.stat(directory, follow_symlinks=False)):
            raise UnsafePath()
        os.fchmod(lock_fd, 0o600)
        record = json.dumps({'pid': parent_pid, 'nonce': nonce}).encode('utf-8')
        os.ftruncate(lock_fd, 0)
        written = 0
        while written < len(record):
            count = os.write(lock_fd, record[written:])
            if count <= 0:
                raise OSError()
            written += count
        os.fsync(lock_fd)
        print('{"ready":true}', flush=True)
        # No serial/device input: only our parent holds the write end of this pipe.
        while sys.stdin.buffer.read(4096):
            pass
        # Metadata is informational. Only clear our nonce and never touch a
        # replacement path; the kernel lock, not PID liveness, is authoritative.
        try:
            current = os.stat('bridge.lock', dir_fd=directory_fd, follow_symlinks=False)
            os.lseek(lock_fd, 0, os.SEEK_SET)
            saved = json.loads(os.read(lock_fd, 4096))
            if same_inode(lock_info, current) and saved.get('nonce') == nonce and saved.get('pid') == parent_pid:
                os.ftruncate(lock_fd, 0)
                os.fsync(lock_fd)
        except (OSError, ValueError, AttributeError):
            pass
    finally:
        if lock_fd is not None:
            if locked:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
        os.close(directory_fd)


try:
    main()
except UnsafePath:
    print('{"code":"BRIDGE_LOCK_UNSAFE"}', flush=True)
    sys.exit(1)
except AlreadyRunning:
    print('{"code":"BRIDGE_ALREADY_RUNNING"}', flush=True)
    sys.exit(1)
except OSError as error:
    code = ('BRIDGE_LOCK_UNSAFE' if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR)
            else 'BRIDGE_LOCK_UNAVAILABLE')
    print(json.dumps({'code': code}), flush=True)
    sys.exit(1)
except Exception:
    print('{"code":"BRIDGE_LOCK_UNAVAILABLE"}', flush=True)
    sys.exit(1)
