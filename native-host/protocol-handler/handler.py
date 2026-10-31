#!/usr/bin/env python3
"""Opens vlc:// and mpv:// links produced by the "Protocol Handler" option of the extension.

The operating system calls this script with the link as the only argument, for
example:  handler.py "vlc://https%3A%2F%2Fcdn.example%2Fvideo.m3u8"

Accepted link shapes (the scheme name decides the player: vlc -> VLC, mpv -> mpv):
  vlc://https%3A%2F%2Fhost%2Fpath     percent-encoded (extension default, unambiguous)
  vlc://https://host/path             raw
  vlc://https//host/path              raw, after a browser dropped the colon
Set VLC_PATH / MPV_PATH to use a player that is not in a standard location.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote

PLAYERS = {
    'vlc': {
        'which': ['vlc'],
        'windows': [r'%ProgramFiles%\VideoLAN\VLC\vlc.exe', r'%ProgramFiles(x86)%\VideoLAN\VLC\vlc.exe'],
        'mac': ['/Applications/VLC.app/Contents/MacOS/VLC'],
    },
    'mpv': {
        'which': ['mpv'],
        'windows': [r'%ProgramFiles%\mpv\mpv.exe', r'%LOCALAPPDATA%\Programs\mpv\mpv.exe', r'%ProgramFiles%\MPV Player\mpv.exe'],
        'mac': ['/Applications/mpv.app/Contents/MacOS/mpv', '/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'],
    },
}


def split_link(link):
    """Returns (scheme, rest) for 'scheme://rest' or 'scheme:rest'."""
    m = re.match(r'^([A-Za-z][A-Za-z0-9+.-]*):(?://)?(.*)$', link.strip().strip('"'), re.S)
    if not m:
        raise ValueError('not a link: %r' % link)
    return m.group(1).lower(), m.group(2)


def extract_url(rest):
    """Turns the part after 'vlc://' back into the original http(s) URL."""
    rest = rest.strip()
    if re.match(r'^https?%3a', rest, re.I):
        # A literal trailing slash is added by some browsers; a real one would be %2F
        rest = unquote(rest.rstrip('/'))
    rest = re.sub(r'^(https?)//', r'\1://', rest, flags=re.I)      # colon dropped by the browser
    rest = re.sub(r'^(https?):/(?!/)', r'\1://', rest, flags=re.I)  # one slash lost
    if not re.match(r'^https?://\S+$', rest, re.I):
        raise ValueError('no http(s) URL found in %r' % rest)
    return rest


def find_player(name):
    env = os.environ.get(name.upper() + '_PATH')
    if env and os.path.exists(env):
        return env
    spec = PLAYERS[name]
    for candidate in spec['which']:
        found = shutil.which(candidate)
        if found:
            return found
    for pattern in spec['windows'] if os.name == 'nt' else spec['mac'] if sys.platform == 'darwin' else []:
        path = os.path.expandvars(pattern)
        if os.path.exists(path):
            return path
    raise FileNotFoundError('%s was not found; set %s_PATH' % (name, name.upper()))


def launch(name, url):
    exe = find_player(name)
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == 'nt':
        kwargs['creationflags'] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs['start_new_session'] = True
    subprocess.Popen([exe, url], **kwargs)
    return exe


def log(message):
    try:
        with open(os.path.join(tempfile.gettempdir(), 'stream-player-handler.log'), 'a', encoding='utf-8') as f:
            f.write('%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), message))
    except OSError:
        pass


def main(argv):
    if len(argv) < 2:
        print('usage: handler.py <vlc://...|mpv://...>', file=sys.stderr)
        return 2
    try:
        scheme, rest = split_link(argv[1])
        if scheme not in PLAYERS:
            raise ValueError('unsupported scheme %r (use vlc or mpv)' % scheme)
        url = extract_url(rest)
        exe = launch(scheme, url)
        log('OK %s -> %s %s' % (argv[1], exe, url))
        return 0
    except Exception as e:  # runs without a console (pythonw), so errors go to the log file
        log('ERROR %s: %s' % (argv[1], e))
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
