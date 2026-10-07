#!/usr/bin/env python3
# claude agents 행의 백킹 PTY 안에서 워커 tmux pane 에 붙는다.
# bg-pty-host 가 출력 이력을 다시 재생하면 바깥 터미널이 tmux 의 오래된 질의에 또 답한다.
# tmux 는 늦게 온 응답을 키 입력으로 넘기므로 여기서 응답 시퀀스를 걸러 낸다.
import fcntl
import os
import pty
import re
import select
import signal
import sys
import termios
import tty

# DA1/DA2/DA3, 창 크기 보고(CSI ... t), DECRQM, kitty 키보드 플래그 응답, DCS, OSC
REPLY = re.compile(
    rb"\x1b\[[?>=][0-9;]*c"
    rb"|\x1b\[[0-9]+(?:;[0-9]+)*t"
    rb"|\x1b\[\?[0-9;]*\$y"
    rb"|\x1b\[\?[0-9]*u"
    rb"|\x1bP[^\x1b]*\x1b\\"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
)
# 응답이 read 경계에서 잘렸을 때 잠깐 붙잡아 둘 접두
PARTIAL = re.compile(
    rb"(?:\x1b\[[?>=]?[0-9;$]*|\x1bP[^\x1b]*\x1b?|\x1b\][^\x07\x1b]*\x1b?)\Z"
)
HOLD_SEC = 0.05


def strip_replies(buf):
    """걸러 낸 바이트와, 다음 read 까지 보류할 꼬리를 돌려준다."""
    cleaned = REPLY.sub(b"", buf)
    m = PARTIAL.search(cleaned)
    if m and cleaned[m.start():] != b"\x1b":
        return cleaned[: m.start()], cleaned[m.start():]
    return cleaned, b""


def copy_winsize(src, dst):
    try:
        size = fcntl.ioctl(src, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(dst, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def relay(argv, env):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(argv[0], argv, env)
    stdin = sys.stdin.fileno()
    stdout = sys.stdout.fileno()
    copy_winsize(stdin, fd)
    signal.signal(signal.SIGWINCH, lambda *_: copy_winsize(stdin, fd))
    saved = termios.tcgetattr(stdin) if os.isatty(stdin) else None
    if saved:
        tty.setraw(stdin)
    pending = b""
    try:
        while True:
            try:
                ready, _, _ = select.select([stdin, fd], [], [], HOLD_SEC if pending else None)
            except InterruptedError:
                continue
            if not ready and pending:
                os.write(fd, pending)
                pending = b""
                continue
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(stdout, data)
            if stdin in ready:
                data = os.read(stdin, 65536)
                if not data:
                    break
                out, pending = strip_replies(pending + data)
                if out:
                    os.write(fd, out)
    finally:
        if saved:
            termios.tcsetattr(stdin, termios.TCSADRAIN, saved)
    # 행 PTY 가 닫히면 attach client 도 끝낸다. 워커 방은 그대로 남는다.
    os.close(fd)
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


def main():
    # 사용법: agents-row-attach.py -- <tmux attach 명령>
    argv = sys.argv[1:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        print("usage: agents-row-attach.py -- <command>", file=sys.stderr)
        return 2
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    return relay(argv, env)


if __name__ == "__main__":
    sys.exit(main())
