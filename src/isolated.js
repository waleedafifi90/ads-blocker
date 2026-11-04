// Runs in the extension's isolated world at document_start, in every frame.
// - kills invisible click-trap overlays (proactively and at click time)
// - tells the background about real user clicks (so it can tell them apart from ad popups)
// - relays "blocked" reports from main-world.js
(() => {
  if (window.__watchShieldIsolated) return;
  window.__watchShieldIsolated = true;

  const MIN_Z = 1000;
  const isTop = window.top === window;
  const send = msg => { try { chrome.runtime.sendMessage(msg); } catch { /* extension reloaded */ } };

  // ---------- click-trap detection ----------

  const MEDIA = 'iframe, video, embed, object, canvas';
  const CONTENT_TAGS = new Set(['IMG', 'VIDEO', 'IFRAME', 'CANVAS', 'SVG', 'svg', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'EMBED', 'OBJECT']);

  function effectiveZ(el) {
    let z = 0;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const v = parseInt(getComputedStyle(n).zIndex, 10);
      if (!Number.isNaN(v)) z = Math.max(z, v);
    }
    return z;
  }

  function isTransparent(cs) {
    if (parseFloat(cs.opacity) < 0.05) return true;
    if (cs.backgroundImage !== 'none') return false;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return cs.backgroundColor === 'transparent';
    const alpha = m[1].split(',')[3];
    return alpha !== undefined && parseFloat(alpha) < 0.05;
  }

  function hasVisibleContent(el) {
    if ((el.innerText || '').trim().length > 0) return true;
    for (const child of el.querySelectorAll('*')) {
      if (CONTENT_TAGS.has(child.tagName)) return true;
      const cs = getComputedStyle(child);
      if (cs.backgroundImage !== 'none' || !isTransparent(cs)) return true;
    }
    return false;
  }

  function overlapRatio(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / (b.width * b.height || 1);
  }

  // A trap is a big, empty, see-through layer stacked high above the page,
  // either covering most of the screen or sitting on top of a player.
  function isClickTrap(el) {
    if (!(el instanceof HTMLElement) || CONTENT_TAGS.has(el.tagName)) return false;
    if (el === document.body || el === document.documentElement) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (effectiveZ(el) < MIN_Z) return false;
    if (!isTransparent(cs) || hasVisibleContent(el)) return false;

    const r = el.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return false;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
    if (overlapRatio(r, viewport) >= 0.4) return true;
    for (const media of document.querySelectorAll(MEDIA)) {
      if (el.contains(media)) continue;
      const mr = media.getBoundingClientRect();
      if (mr.width > 100 && mr.height > 80 && overlapRatio(r, mr) >= 0.6) return true;
    }
    return false;
  }

  const seenTraps = new Set(); // count each trap "kind" once per page, they respawn every few ms
  function neutralize(el) {
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    const kind = el.tagName + '|' + el.parentElement?.tagName + '|' + Math.round(el.offsetWidth / 100);
    if (!seenTraps.has(kind)) {
      seenTraps.add(kind);
      send({ type: 'blocked', kind: 'overlays' });
    }
  }

  function scan(node) {
    if (!(node instanceof HTMLElement)) return;
    // Nothing legitimate lives directly under <html> besides <head> and <body>.
    if (node.parentElement === document.documentElement && node !== document.head && node !== document.body
        && !hasVisibleContent(node)) {
      neutralize(node);
      return;
    }
    if (isClickTrap(node)) { neutralize(node); return; }
    for (const child of node.children) if (isClickTrap(child)) neutralize(child);
  }

  // Batch mutation checks per frame: layout reads are expensive.
  let queue = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const nodes = queue; queue = new Set();
    for (const n of nodes) if (n.isConnected) scan(n);
  };
  new MutationObserver(records => {
    for (const r of records) for (const n of r.addedNodes) queue.add(n);
    if (!scheduled && queue.size) { scheduled = true; requestAnimationFrame(flush); }
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Style/class changes aren't observed (players animate constantly); the
  // click-time guard below covers overlays that are revealed that way.

  // Tabs from the right-click menu look like any other opened tab, so tell the
  // background a menu is up. Clicking the page again means it's gone.
  window.addEventListener('contextmenu', e => {
    if (e.isTrusted) send({ type: 'menu', open: true });
  }, { capture: true });
  window.addEventListener('pointerdown', e => {
    if (e.isTrusted && e.button !== 2) send({ type: 'menu', open: false });
  }, { capture: true });

  // Click-time guard: whatever slipped past the observer gets caught here,
  // before the ad's own listeners run (we registered first, at document_start).
  const GUARDED = ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click', 'auxclick'];
  for (const type of GUARDED) {
    window.addEventListener(type, e => {
      if (!e.isTrusted) return;
      const point = e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
      const top = document.elementFromPoint(point.clientX, point.clientY);
      const trap = top && (isClickTrap(top) ? top : top.closest('a') && isClickTrap(top.closest('a')) ? top.closest('a') : null);
      if (trap) {
        e.preventDefault();
        e.stopImmediatePropagation();
        neutralize(trap);
        return;
      }
      if (isTop && (type === 'click' || type === 'auxclick')) {
        send({ type: 'gesture', href: top?.closest('a[href]')?.href ?? null });
      }
    }, { capture: true });
  }
  if (isTop) {
    window.addEventListener('keydown', e => {
      if (e.isTrusted && (e.key === 'Enter' || e.key === ' ')) {
        send({ type: 'gesture', href: document.activeElement?.closest?.('a[href]')?.href ?? null });
      }
    }, { capture: true });
  }

  // ---------- relay from main-world.js ----------

  // Only trust a script URL that this page really loaded, so a page can't
  // trick us into "learning" some innocent host.
  const loadedScript = url =>
    !!url && performance.getEntriesByType('resource').some(e => e.initiatorType === 'script' && e.name.startsWith(url));

  // A download link clicked from code counts as the user's click on that link,
  // but only while the user really is interacting (pages can fire this event too).
  if (isTop) {
    document.addEventListener('watch-shield:download', e => {
      const href = e.detail?.href;
      if (typeof href === 'string' && navigator.userActivation?.isActive) send({ type: 'gesture', href });
    });
  }

  document.addEventListener('watch-shield:blocked', e => {
    const { kind, scriptUrl } = e.detail ?? {};
    if (kind !== 'popups' && kind !== 'redirects') return;
    send({ type: 'blocked', kind, scriptUrl: loadedScript(scriptUrl) ? scriptUrl : null });
  });
})();
