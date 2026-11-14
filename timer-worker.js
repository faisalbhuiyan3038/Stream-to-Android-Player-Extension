// Timers for the built-in players' whole-video download (src/timer.mjs). Browsers slow down
// timers of background tabs (Chrome: to once a minute after 5 minutes hidden), which would stall
// the download's retry delays; a dedicated worker's timers are not slowed that way.
const timers = new Map();
self.onmessage = (e) => {
  const { id, ms, cancel } = e.data || {};
  if (cancel) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    return;
  }
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    self.postMessage(id);
  }, ms));
};
