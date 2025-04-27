// background.js
let detectedStreams = new Map();

// Helper function to check if URL is a potential stream
function isStreamUrl(url) {
  // Common video file extensions and patterns
  const videoPatterns = [
    '.mp4', '.m3u8', '.m3u', 'urlset',
    '/video/', '/media/', '/stream/',
    'manifest', 'playlist', 'master.json'
  ];

  return videoPatterns.some(pattern => url.toLowerCase().includes(pattern));
}

// Helper function to extract quality from URL or name
function extractQuality(url, name) {
  const qualityPatterns = [
    { regex: /[^a-z](4320p|8k)[^a-z]/i, quality: '8K (4320p)' },
    { regex: /[^a-z](2160p|4k)[^a-z]/i, quality: '4K (2160p)' },
    { regex: /[^a-z](1440p|2k)[^a-z]/i, quality: '2K (1440p)' },
    { regex: /[^a-z]1080p[^a-z]/i, quality: '1080p' },
    { regex: /[^a-z]720p[^a-z]/i, quality: '720p' },
    { regex: /[^a-z]480p[^a-z]/i, quality: '480p' },
    { regex: /[^a-z]360p[^a-z]/i, quality: '360p' },
    { regex: /[^a-z]240p[^a-z]/i, quality: '240p' },
    { regex: /[^a-z]144p[^a-z]/i, quality: '144p' }
  ];

  const testString = `${url} ${name}`;
  for (const pattern of qualityPatterns) {
    if (pattern.regex.test(testString)) {
      return pattern.quality;
    }
  }
  return null;
}

// Helper function to check content type
function isStreamContent(contentType) {
  const streamTypes = [
    'video/',
    'application/x-mpegurl',
    'application/vnd.apple.mpegurl',
    'application/octet-stream'
  ];

  return streamTypes.some(type => contentType.toLowerCase().includes(type));
}

// Add function to extract video source URLs from a page
function extractVideoSources(tabId) {
  browser.tabs.executeScript(tabId, {
    code: `
      (function() {
        let sources = [];

        // Check video elements
        document.querySelectorAll('video').forEach(video => {
          if (video.src) {
            const fileName = video.src.split('/').pop().split('?')[0];
            const quality = extractQuality(video.src, fileName);
            sources.push({
              url: video.src,
              type: 'video',
              name: fileName,
              quality: quality
            });
          }

          // Check source elements within video
          video.querySelectorAll('source').forEach(source => {
            if (source.src) {
              const fileName = source.src.split('/').pop().split('?')[0];
              const quality = extractQuality(source.src, fileName);
              sources.push({
                url: source.src,
                type: source.type?.includes('m3u') ? 'm3u8' : 'video',
                name: fileName,
                quality: quality
              });
            }
          });
        });

        // Check data-source attributes (common for m3u8 players)
        document.querySelectorAll('[data-source]').forEach(el => {
          const source = el.getAttribute('data-source');
          if (source) {
            const fileName = source.split('/').pop().split('?')[0];
            const quality = extractQuality(source, fileName);
            sources.push({
              url: source,
              type: source.includes('.m3u8') ? 'm3u8' : 'video',
              name: fileName,
              quality: quality
            });
          }
        });

        return sources;
      })();
    `
  }).then(results => {
    if (!results?.[0]) return;

    let streams = detectedStreams.get(tabId) || [];
    const newSources = results[0];

    // Add any new sources found
    newSources.forEach(source => {
      if (!streams.some(s => s.url === source.url)) {
        streams.push(source);
      }
    });

    if (streams.length > 0) {
      detectedStreams.set(tabId, streams);
      browser.tabs.sendMessage(tabId, {
        type: "streamDetected",
        streams: streams
      }).catch(console.error);
    }
  }).catch(console.error);
}

// Clear streams when tab is updated or removed
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    detectedStreams.delete(tabId);
  } else if (changeInfo.status === 'complete') {
    // Scan for video sources when page loads
    extractVideoSources(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  detectedStreams.delete(tabId);
});

// Listen for web requests to detect streams
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const url = details.url;
    const contentType = details.responseHeaders
      .find(h => h.name.toLowerCase() === 'content-type')?.value || '';

    if (isStreamUrl(url) || isStreamContent(contentType)) {
      let streams = detectedStreams.get(details.tabId) || [];
      const fileName = url.split('/').pop().split('?')[0];

      if (!streams.some(s => s.url === url)) {
        const quality = extractQuality(url, fileName);
        streams.push({
          url,
          name: fileName,
          type: contentType.includes('m3u') ? 'm3u8' : 'video',
          quality: quality
        });
        detectedStreams.set(details.tabId, streams);
        browser.tabs.sendMessage(details.tabId, {
          type: "streamDetected",
          streams: streams
        }).catch(console.error);
      }
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "object", "other"]
  },
  ["responseHeaders"]
);

// Monitor response content for m3u8 playlists
browser.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method === 'GET') {
      try {
        const response = await fetch(details.url);
        const content = await response.text();

        // Check for M3U8 playlist content
        if (content.trim().startsWith('#EXTM3U')) {
          let streams = detectedStreams.get(details.tabId) || [];
          if (!streams.some(s => s.url === details.url)) {
            const fileName = details.url.split('/').pop().split('?')[0];
            const quality = extractQuality(details.url, fileName);
            streams.push({
              url: details.url,
              name: fileName,
              type: 'm3u8',
              quality: quality
            });
            detectedStreams.set(details.tabId, streams);
            browser.tabs.sendMessage(details.tabId, {
              type: "streamDetected",
              streams: streams
            }).catch(console.error);
          }
        }
      } catch (err) {
        console.error('Error checking response content:', err);
      }
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["xmlhttprequest"]
  }
);

// Add periodic scanning for dynamically added videos
browser.tabs.onActivated.addListener(({ tabId }) => {
  extractVideoSources(tabId);

  // Scan periodically for new videos
  const intervalId = setInterval(() => {
    browser.tabs.get(tabId).then(tab => {
      if (tab.active) {
        extractVideoSources(tabId);
      } else {
        clearInterval(intervalId);
      }
    }).catch(() => clearInterval(intervalId));
  }, 5000);
});
