// Reads what a web-player page should play from its own location.
//   player.html?url=<encoded>&subs=<json>   opened by the extension (buttons, popup, menu)
//   player.html#https://cdn/x.m3u8          a direct link the user navigated to, redirected here by a
//                                           declarativeNetRequest rule (a regexSubstitution cannot
//                                           percent-encode, so the raw URL goes into the fragment)

export function getVideoUrl(loc) {
  const fromQuery = new URLSearchParams(loc.search || '').get('url');
  if (fromQuery) return fromQuery;
  const hash = String(loc.hash || '').replace(/^#/, '');
  if (/^https?:\/\//i.test(hash)) return hash;
  try {
    const decoded = decodeURIComponent(hash);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch { /* not encoded */ }
  return '';
}

// Display title (cleaned page title) passed as ?title=
export function getTitle(loc) {
  return (new URLSearchParams(loc.search || '').get('title') || '').trim().slice(0, 200);
}

export function getSubtitleList(loc) {
  try {
    const list = JSON.parse(new URLSearchParams(loc.search || '').get('subs') || '[]');
    return Array.isArray(list) ? list.filter(s => s && typeof s.url === 'string') : [];
  } catch (e) {
    console.warn('Ignoring malformed subs parameter:', e);
    return [];
  }
}
