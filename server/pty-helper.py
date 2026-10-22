#!/usr/bin/env python3
# Runs a command (a login shell, or a tmux client) on a pseudo-terminal for the
# dashboard's web terminal, so the server needs no native Node modules.
#
#   pty-helper.py COMMAND [ARGS...]
#
# stdin/stdout carry the terminal data; fd 3 receives resize requests as "cols rows" lines.
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

STDIN, STDOUT, CONTROL = 0, 1, 3

command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.close(CONTROL)
    os.execvp(command[0], command)


def write_all(target, data):
    while data:
        data = data[os.write(target, data):]


def hang_up(*_):
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    sys.exit(0)


signal.signal(signal.SIGTERM, hang_up)
signal.signal(signal.SIGHUP, hang_up)

inputs = [fd, STDIN, CONTROL]
pending = b''
while True:
    readable, _, _ = select.select(inputs, [], [])
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError:  # EIO once the shell has exited
            data = b''
        if not data:
            break
        write_all(STDOUT, data)
    if STDIN in readable:
        data = os.read(STDIN, 65536)
        if not data:
            hang_up()
        write_all(fd, data)
    if CONTROL in readable:
        data = os.read(CONTROL, 1024)
        if not data:
            inputs.remove(CONTROL)
        pending += data
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            cols, rows = (int(n) for n in line.split())
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
