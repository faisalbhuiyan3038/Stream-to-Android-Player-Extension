# Protocol handler (`vlc://`, `mpv://`) and VLC HTTP setup

The extension can open a stream in an external desktop player in three ways. **Native Messaging is the default** and the most capable (it forwards Referer, user agent, title and subtitles, and it can download). The two options below are alternatives that do not need the native host.

| Method | Needs | Forwards headers / subtitles |
|---|---|---|
| Native Messaging (default) | `native-host/install.bat` (or `install.sh`) | yes |
| Protocol Handler | a handler registered for `vlc://` (this guide) | no |
| VLC HTTP Interface | VLC's web interface switched on (this guide) | Referer + user agent (VLC `option=`) |

## 1. Protocol handler

### Why "the address wasn't understood"?
The extension opens a link such as `vlc://https%3A%2F%2Fcdn.example%2Fvideo.m3u8`. Browsers only know `http`, `https` and a few more schemes; for anything else they ask the **operating system** which program owns it. VLC does not register `vlc://` itself, so nothing answers and the browser reports an unknown address. You have to register a small helper once. This repo ships one: `native-host/protocol-handler/handler.py`. It turns the link back into the real URL and starts VLC (or mpv for `mpv://`).

### URL format (popup → External Player → Protocol Handler)
* **Encoded** (default): `vlc://https%3A%2F%2Fhost%2Fvideo.m3u8`. One unambiguous token; browsers cannot mangle it. (The old raw form `vlc://https://host/…` is rewritten by Chromium to `vlc://https//host/…` because `https:` looks like a host name.)
* **Raw**: the old shape, for third-party handlers that expect it.

`handler.py` understands encoded, raw and the browser-mangled raw form.

### Windows
1. Install Python 3 (python.org, tick **Add python.exe to PATH**). VLC in the default folder is found automatically; otherwise set the environment variable `VLC_PATH` to `vlc.exe`.
2. Double-click `native-host\protocol-handler\register-windows.bat` (add `mpv` as an argument to register `mpv://` too). It writes only to `HKEY_CURRENT_USER`; no administrator rights.
3. Test without a browser: `python native-host\protocol-handler\handler.py "vlc://https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8"` — VLC should start playing.
4. In the popup choose **Protocol Handler**, protocol `vlc://`, format **Encoded**, and click 🖥️ on a stream.
5. The first time, the browser asks which application opens `vlc` links. In Firefox pick the Python entry and tick "Always use…"; in Chrome/Edge click *Open* and tick "Always allow".
6. Undo: `unregister-windows.bat`.

### Linux
Run `native-host/protocol-handler/register-linux.sh` (needs `python3`, `xdg-mime`; add `mpv` to also register `mpv://`). VLC must be on `PATH` or in `VLC_PATH`.

### macOS
A URL scheme needs an application bundle, which this repo does not ship. Use Native Messaging (`native-host/install.sh`) instead, or an app such as *Platypus* wrapping `handler.py` with the `vlc` scheme.

### Troubleshooting
* Nothing happens after the browser prompt: read `%TEMP%\stream-player-handler.log` (Linux/macOS: `$TMPDIR` or `/tmp`). `ERROR … VLC was not found` → set `VLC_PATH`.
* The browser still says the address is not understood: the registration is missing for this Windows user; run `register-windows.bat` again and restart the browser.
* An empty tab stays open after clicking: that is the browser's way of handing the link to the OS; close it.
* Wrong stream / 404 in VLC: switch the URL format to the one your handler expects.

## 2. VLC HTTP interface

The extension sends `http://localhost:8080/requests/status.xml?command=in_play&input=<stream>` to VLC. VLC only listens on that port if its web interface is on.

1. VLC → **Tools → Preferences**, bottom-left **Show settings: All**.
2. **Interface → Main interfaces** → tick **Web**.
3. **Interface → Main interfaces → Lua** → *Lua HTTP* → set a **Password** (required; VLC rejects requests without one). **Save**, then **quit and restart VLC**.
4. Check: open `http://localhost:8080` in a browser, leave the user name empty, type the password. You should see VLC's web page.
5. In the popup choose **VLC HTTP Interface** and enter the same password. VLC must be running when you click 🖥️.

One-off alternative, no preferences: `vlc.exe --extraintf=http --http-password=yourpassword`.

| Message in the extension | Meaning |
|---|---|
| `Failed to fetch` | VLC is not running, or the web interface is off / on another port |
| `HTTP 401` | wrong password |

The port (8080) and host (`localhost`) are fixed in the extension.
