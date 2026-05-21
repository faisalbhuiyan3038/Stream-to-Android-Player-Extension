import sys
import json
import struct
import subprocess
import os
import tempfile

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

def launch(cmd):
    """Launch a GUI application on the user's interactive desktop.

    Firefox runs native messaging hosts inside a Windows Job Object that
    prevents child processes from getting a visible window — every approach
    (Popen, os.startfile, cmd /c start) still creates a child inside the
    same job.  The only reliable escape is the Windows Task Scheduler:
    schtasks /run executes through svchost.exe, a completely independent
    system service, so the launched program gets its own desktop session
    and a fully visible window.
    """
    if os.name == 'nt':
        # Write a temporary batch file with the full command.
        # This avoids issues with long URLs or special characters in
        # schtasks /tr arguments, which have strict escaping rules.
        bat_path = os.path.join(tempfile.gettempdir(), 'stream_player_launch.bat')
        with open(bat_path, 'w') as f:
            exe = cmd[0]
            args = ' '.join(f'"{a}"' for a in cmd[1:]) if len(cmd) > 1 else ''
            f.write(f'@start "" "{exe}" {args}\n')

        # Create a one-shot scheduled task (overwrites any previous one)
        task_name = 'StreamPlayerLaunch'
        no_window = 0x08000000  # CREATE_NO_WINDOW — hide schtasks console
        run_opts = dict(
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=no_window,
        )

        subprocess.run(
            ['schtasks', '/create', '/tn', task_name,
             '/tr', bat_path, '/sc', 'once', '/st', '00:00', '/f'],
            **run_opts,
        )

        # Execute immediately — this runs through svchost.exe, completely
        # outside Firefox's process tree, so the app gets a visible window.
        subprocess.run(
            ['schtasks', '/run', '/tn', task_name],
            **run_opts,
        )
    else:
        # macOS / Linux: start_new_session detaches from parent
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

def main():
    while True:
        try:
            msg = get_message()
            if 'command' in msg:
                launch(msg['command'])
                send_message({'status': 'launched'})
        except Exception as e:
            send_message({'status': 'error', 'error': str(e)})

if __name__ == '__main__':
    main()
