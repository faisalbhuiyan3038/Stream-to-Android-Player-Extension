#!/usr/bin/env python3
"""Native messaging host for "Stream to Android Player" (protocol version 2).

Messages are length-prefixed JSON on stdin/stdout. Supported requests:

  {"action": "ping"}
  {"action": "launch",   "command": [exe, arg, ...]}      ("command" alone also works)
  {"action": "download", "url": ..., "title": ..., "dir": ...,
                         "headers": {"referer": ..., "userAgent": ..., "cookie": ...}}

Every request gets exactly one reply: {"status": "ok" | "launched" | "error", ...}.
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

VERSION = 2

DETACHED_PROCESS = 0x00000008
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000


def get_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        sys.exit(0)
    message_length = struct.unpack('@I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)


def send_message(message):
    encoded = json.dumps(message).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def validate_command(cmd):
    if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
        raise ValueError('command must be a non-empty list of strings')
    if not cmd[0].strip():
        raise ValueError('command[0] (the player executable) is empty')
    return [a.replace('\x00', '') for a in cmd]


def bat_quote(arg):
    """Quote one argument for a generated .bat line.

    Inside double quotes cmd.exe treats & | < > ^ literally, so only % (variable
    expansion) and " (ends the quoting) need care. Quotes are replaced instead of
    escaped because there is no reliable escape that works for every program.
    """
    arg = re.sub(r'[\r\n]+', ' ', arg)
    arg = arg.replace('%', '%%').replace('"', "'")
    arg = re.sub(r'(\\+)$', r'\1\1', arg)  # a trailing backslash would swallow the closing quote
    return '"%s"' % arg


def build_bat_line(cmd):
    return '@start "" ' + ' '.join(bat_quote(a) for a in cmd) + '\n'


def launch_via_scheduler(cmd):
    """Windows fallback when the host's job object forbids breaking away.

    A one-shot scheduled task runs through the Task Scheduler service, completely
    outside the browser's process tree, so the program gets a visible window.
    """
    bat_path = os.path.join(tempfile.gettempdir(), 'stream_player_launch.bat')
    with open(bat_path, 'w', encoding='utf-8') as f:
        f.write(build_bat_line(cmd))
    run_opts = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    task_name = 'StreamPlayerLaunch'
    subprocess.run(['schtasks', '/create', '/tn', task_name, '/tr', '"%s"' % bat_path,
                    '/sc', 'once', '/st', '00:00', '/f'], check=True, **run_opts)
    subprocess.run(['schtasks', '/run', '/tn', task_name], check=True, **run_opts)


def launch(cmd, console=False):
    """Start `cmd` detached from the browser. Arguments are passed as an argv list."""
    cmd = validate_command(cmd)
    if os.name == 'nt':
        flags = CREATE_NEW_PROCESS_GROUP | (CREATE_NEW_CONSOLE if console else DETACHED_PROCESS)
        try:
            subprocess.Popen(
                cmd,
                creationflags=flags | CREATE_BREAKAWAY_FROM_JOB,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            return 'direct'
        except FileNotFoundError:
            raise
        except OSError:
            # The browser's job object does not allow breakaway
            launch_via_scheduler(cmd)
            return 'scheduler'
    subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return 'direct'


def which(*names):
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def safe_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name or '').strip(' .')
    return (name or 'stream')[:120]


def default_download_dir():
    return os.path.join(os.path.expanduser('~'), 'Downloads')


def build_download_command(msg):
    """Returns (command, output_description). Prefers yt-dlp, falls back to ffmpeg."""
    url = msg.get('url')
    if not isinstance(url, str) or not url.startswith(('http://', 'https://')):
        raise ValueError('download needs an http(s) url')
    headers = msg.get('headers') or {}
    out_dir = msg.get('dir') or default_download_dir()
    os.makedirs(out_dir, exist_ok=True)
    title = safe_filename(msg.get('title'))

    ytdlp = which('yt-dlp', 'yt-dlp.exe')
    if ytdlp:
        cmd = [ytdlp, '--no-playlist']
        if headers.get('referer'):
            cmd += ['--referer', headers['referer']]
        if headers.get('userAgent'):
            cmd += ['--user-agent', headers['userAgent']]
        if headers.get('cookie'):
            cmd += ['--add-header', 'Cookie:' + headers['cookie']]
        template = os.path.join(out_dir, title.replace('%', '%%') + '.%(ext)s')
        return cmd + ['-o', template, url], 'yt-dlp'

    ffmpeg = which('ffmpeg', 'ffmpeg.exe')
    if ffmpeg:
        header_lines = ''
        if headers.get('referer'):
            header_lines += 'Referer: %s\r\n' % headers['referer']
        if headers.get('userAgent'):
            header_lines += 'User-Agent: %s\r\n' % headers['userAgent']
        if headers.get('cookie'):
            header_lines += 'Cookie: %s\r\n' % headers['cookie']
        cmd = [ffmpeg]
        if header_lines:
            cmd += ['-headers', header_lines]
        return cmd + ['-i', url, '-c', 'copy', os.path.join(out_dir, title + '.mkv')], 'ffmpeg'

    raise RuntimeError('Neither yt-dlp nor ffmpeg was found on PATH')


def handle(msg):
    action = msg.get('action') or ('launch' if 'command' in msg else None)
    if action == 'ping':
        return {
            'status': 'ok',
            'version': VERSION,
            'os': sys.platform,
            'python': sys.version.split()[0],
            'ytdlp': bool(which('yt-dlp', 'yt-dlp.exe')),
            'ffmpeg': bool(which('ffmpeg', 'ffmpeg.exe')),
        }
    if action == 'launch':
        method = launch(msg.get('command'))
        return {'status': 'launched', 'method': method}
    if action == 'download':
        cmd, tool = build_download_command(msg)
        method = launch(cmd, console=True)
        return {'status': 'launched', 'tool': tool, 'method': method}
    raise ValueError('unknown action: %r' % (action,))


def main():
    while True:
        try:
            msg = get_message()
            send_message(handle(msg))
        except SystemExit:
            raise
        except Exception as e:
            send_message({'status': 'error', 'error': str(e)})


if __name__ == '__main__':
    main()
