// A small menu that opens above a control-bar button (used by the Save and Audio controls):
// attached to the element that goes fullscreen, placed above the button, closed by a tap
// outside or Escape; taps on it never reach the player (play/pause, seek gestures).
//   owner: the control's element (taps on it do not count as "outside")
//   anchor: the button the menu is placed above
//   menuHost: the element the menu is attached to
export function createPopover({ owner, anchor, menuHost = document.body, className, onToggle = () => {} }) {
  if (menuHost !== document.body && getComputedStyle(menuHost).position === 'static') menuHost.style.position = 'relative';
  const menu = document.createElement('div');
  menu.className = className;
  menu.hidden = true;
  menuHost.appendChild(menu);

  // right edge at the button's, but never past the host's left edge (a button on the left side)
  const place = () => {
    const host = menuHost.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const right = Math.max(8, host.right - r.right);
    menu.style.right = `${Math.max(8, Math.min(right, host.width - menu.offsetWidth - 8))}px`;
    menu.style.bottom = `${Math.max(8, host.bottom - r.top + 8)}px`;
  };
  const pop = {
    menu,
    place,
    get isOpen() { return !menu.hidden; },
    open() {
      menu.hidden = false;
      place();
      onToggle(true);
    },
    close() {
      if (menu.hidden) return;
      menu.hidden = true;
      onToggle(false);
    },
    destroy() {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', esc);
      menu.remove();
    }
  };
  for (const ev of ['click', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'wheel']) menu.addEventListener(ev, e => e.stopPropagation());
  // keys typed in the menu (arrows on a slider) must not seek / change the volume
  menu.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  const outside = (e) => { if (!menu.hidden && !menu.contains(e.target) && !owner.contains(e.target)) pop.close(); };
  document.addEventListener('pointerdown', outside, true);
  const esc = (e) => { if (e.key === 'Escape') pop.close(); };
  document.addEventListener('keydown', esc);
  return pop;
}
