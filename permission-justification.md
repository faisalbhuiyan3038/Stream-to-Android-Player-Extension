Permission justifications for store review (Chrome Web Store "Privacy practices" tab, addons.mozilla.org review notes).
Plain text on purpose: paste each block into the matching field. Applies to version 1.6.

==================================================
SINGLE PURPOSE
==================================================
Stream to Android Player finds the video streams (HLS .m3u8, DASH .mpd, MP4 and similar) that the page the user is viewing loads, and lets the user play them in a video player of their choice: an Android app (VLC, MX Player, mpv), a desktop player (VLC, mpv), the extension's own built-in web player, or save them as an MP4 file. Everything else (subtitles, quality choice, page title) supports that one purpose.

==================================================
PERMISSIONS
==================================================

webRequest
Used to detect video streams and subtitle files. The extension watches the network requests a page makes (request URL, response content type and status) to recognise stream playlists (.m3u8, .mpd) and video files, and reads the page's Referer, Origin and User-Agent request headers so the same values can be passed to the player (many video servers refuse requests without them). Requests are only observed; nothing is blocked or changed through webRequest.

declarativeNetRequest
Used to make the extension's own requests look like the page's. When the user opens a stream in the built-in player or downloader, a session rule limited to that player tab sets the page's Referer/Origin (and Cookie only if the user turned on "Forward cookies"). When the extension reads a stream's playlist to show its duration and qualities, a temporary rule limited to that single URL does the same and is removed right after. If the user turns on "Open stream links in the built-in player" (off by default), a redirect rule sends top-level navigations to .m3u8/.mpd (optionally .mp4) files to the built-in player page.

scripting
Used to find video sources in the page's DOM (<video>, <source>, <track> elements, including inside embedded player iframes) when the network requests alone are not enough, and to copy a stream URL to the clipboard when the user chooses "Copy" from the right-click menu or the keyboard shortcut.

tabs
Used to read the URL and title of the tab in which a stream was found (the title becomes the stream's display name and the downloaded file name; the URL is sent as the Referer and is used to drop streams of pages the user has left), to open the built-in player, downloader and player links in a new tab, to show the current tab's streams in the popup, and to clear a tab's list when it is closed or navigates away.

storage
Stores the user's settings, the list of streams detected per tab (cleared when the browser starts or the tab closes) and the floating button position. Data is stored locally only. (The built-in player's resume positions are kept in the extension page's own localStorage, also local.)

notifications
Shows a notification when an action the user started fails, for example when the external player could not be launched, the native host is not installed, or a download could not start. (Used by the notify() function in background.js.)

clipboardWrite
Copies a stream URL to the clipboard when the user clicks the copy button, or chooses "Copy" from the right-click menu or keyboard shortcut (in that case the copy runs in the page, without a click inside it, which needs this permission).

contextMenus
Adds four right-click menu entries on links, videos and audio elements: "Open in external player", "Play in browser player", "Copy stream URL" and "Download video". (Not available on Firefox for Android, where the menu API does not exist; the extension checks for it.)

nativeMessaging (optional permission, requested only when the user selects "Native Messaging" in the popup on desktop)
Talks to the optional native helper program the user installs themselves, which launches the user's desktop player (VLC, mpv) with the stream URL, or downloads the stream with yt-dlp/ffmpeg.

==================================================
HOST PERMISSION (<all_urls>)
==================================================
Videos can be on any website and are usually served from separate video servers (CDNs) whose addresses cannot be known in advance. Access to all sites is needed to: run the content script that shows the stream button/menu on any page, observe the page's requests with webRequest, read stream playlists from the video server to show duration and quality, and let the built-in player and downloader load the stream with the page's headers. The extension does nothing on a page until it loads a video; the user can disable it per site or entirely from the popup.

==================================================
REMOTE CODE
==================================================
No, the extension does not use remote code. All JavaScript, including the video players (Shaka Player, Vidstack, hls.js), is bundled in the package. The only things fetched from the network are the video streams, playlists and subtitle files the user's pages already use.

==================================================
DATA USAGE
==================================================
The extension does not collect, sell or send any user data to the developer or any third party. There are no analytics and no servers of our own.
- Stream URLs, page titles and the page's request headers stay in the browser's local extension storage and are cleared when the browser restarts or the tab closes.
- Data leaves the browser only to where the user sends it: to the video servers of the page they are watching (to play or download the stream), to the player app they chose, or to their own native helper program.
- Cookies are read and passed on only if the user turns on "Forward cookies" (off by default), and only to the player/downloader the user opens.
Data categories to tick: "Web history" and "Website content" (handled locally only, to provide the single purpose). Certify: not sold, not used for unrelated purposes, not used for creditworthiness or lending.

==================================================
NOTE FOR REVIEWERS (version 1.6)
==================================================
The "downloads" permission flagged in version 1.4 has been removed: videos are saved through a normal browser download link created by the extension's download page, which needs no permission. The "notifications" permission is now used for the error alerts described above.
