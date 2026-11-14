// setTimeout that keeps its pace in a background tab: the timer runs in a dedicated worker
// (timer-worker.js, packaged next to the player pages). Falls back to the page's own timers.

let worker = null;
let failed = false;
let nextId = 1;
const callbacks = new Map();

function getWorker() {
  if (worker || failed || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('timer-worker.js', globalThis.location.href));
    worker.onmessage = (e) => {
      const fn = callbacks.get(e.data);
      callbacks.delete(e.data);
      if (fn) fn();
    };
    worker.onerror = () => { failed = true; worker = null; };
  } catch {
    failed = true;
    worker = null;
  }
  return worker;
}

export function setTimer(fn, ms) {
  const w = getWorker();
  if (!w) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }
  const id = nextId++;
  callbacks.set(id, fn);
  w.postMessage({ id, ms });
  return () => {
    if (callbacks.delete(id)) w.postMessage({ id, cancel: true });
  };
}
