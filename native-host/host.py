import sys
import json
import struct
import subprocess
import os

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

def main():
    while True:
        try:
            msg = get_message()
            if 'command' in msg:
                cmd = msg['command']
                subprocess.Popen(cmd)
                send_message({"status": "launched", "cmd": cmd})
        except Exception as e:
            send_message({"status": "error", "error": str(e)})

if __name__ == '__main__':
    main()
