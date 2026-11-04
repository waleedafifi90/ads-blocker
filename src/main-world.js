// Runs in the page's own JS world at document_start, in every frame, before any
// site script. Ad tags grab window.open early, so we must be first.
// Talks to isolated.js through a DOM event (we have no chrome.* here).
(() => {
  const FLAG = Symbol.for('watch-shield');
  if (window[FLAG]) return;
  window[FLAG] = true;

  const EVENT = 'watch-shield:blocked';
  const DOWNLOAD_EVENT = 'watch-shield:download';
  const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com',
    'login.live.com', 'www.paypal.com', 'checkout.stripe.com'];

  // Same rough eTLD+1 as shared.js; duplicated because this world can't import modules.
  const TWO_LABEL = /\.(co|com|org|net|gov|ac)\.[a-z]{2}$/;
  const siteOf = host => {
    const parts = host.replace(/^www\./, '').split('.');
    return parts.slice(TWO_LABEL.test(host) ? -3 : -2).join('.');
  };
  const pageSite = siteOf(location.hostname);

  const report = (kind, scriptUrl) =>
    document.dispatchEvent(new CustomEvent(EVENT, { detail: { kind, scriptUrl } }));

  // The first stack frame that isn't us is the ad script that made the call.
  function callerScript() {
    const lines = (new Error().stack || '').split('\n').slice(2);
    for (const line of lines) {
      const m = line.match(/(https?:\/\/[^\s)]+?):\d+:\d+/);
      if (m) return m[1];
    }
    return null;
  }

  // Returns true when opening/navigating to this URL from here looks like an ad.
  function isAdTarget(rawUrl) {
    const str = String(rawUrl ?? '').trim();
    if (!str || str === 'about:blank') return false; // see deferredWindow()
    let u;
    try { u = new URL(str, location.href); } catch { return false; }
    if (u.protocol === 'data:' || u.protocol === 'javascript:') return true;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (AUTH_HOSTS.includes(u.hostname)) return false;
    return siteOf(u.hostname) !== pageSite;
  }

  // Make our wrappers look native, since some tags check open.toString().
  const nativeToString = Function.prototype.toString;
  const disguised = new WeakMap();
  const toStringProxy = function toString() {
    return disguised.has(this) ? disguised.get(this) : nativeToString.call(this);
  };
  disguised.set(toStringProxy, nativeToString.call(nativeToString));
  Function.prototype.toString = toStringProxy;
  const disguise = (fake, real) => {
    disguised.set(fake, nativeToString.call(real));
    Object.defineProperty(fake, 'length', { value: real.length });
    Object.defineProperty(fake, 'name', { value: real.name });
    return fake;
  };

  // A window-like object so the tag thinks its popup worked and doesn't fall back
  // to hijacking the current tab.
  function fakeWindow() {
    const noop = () => {};
    const loc = { href: 'about:blank', assign: noop, replace: noop, reload: noop };
    return new Proxy({}, {
      get(_, key) {
        if (key === 'closed') return false;
        if (key === 'location') return loc;
        if (key === 'document') return document.implementation.createHTMLDocument('');
        if (key === 'window' || key === 'self' || key === 'opener') return null;
        return noop;
      },
      set: () => true,
    });
  }

  // Pop-under libraries open an empty tab first and send it to the ad a moment
  // later, so the URL passed to open() tells us nothing. Hand back a stand-in and
  // only open a real tab once we see where it's being sent.
  function deferredWindow(name, features) {
    let real = null;
    const go = url => {
      if (real) { real.location.href = url; return; }
      if (isAdTarget(url)) { report('popups', callerScript()); return; }
      real = nativeOpen.call(window, url, name, features);
    };
    const noop = () => {};
    const loc = { assign: go, replace: go, reload: noop, toString: () => 'about:blank' };
    Object.defineProperty(loc, 'href', { get: () => real?.location.href ?? 'about:blank', set: go });
    // document.write into a blank popup is only ever used for ad redirects here.
    const doc = new Proxy(document.implementation.createHTMLDocument(''), {
      get: (target, key) => (key === 'write' || key === 'writeln' || key === 'open' || key === 'close')
        ? noop : Reflect.get(target, key),
    });
    return new Proxy({}, {
      get(_, key) {
        if (key === 'closed') return false;
        if (key === 'location') return loc;
        if (key === 'document') return doc;
        if (key === 'window' || key === 'self') return null;
        if (key === 'close') return () => real?.close();
        return noop;
      },
      set(_, key, value) {
        if (key === 'location') go(value);
        return true;
      },
    });
  }

  // ---- window.open ----
  const nativeOpen = window.open;
  const guardedOpen = disguise(function open(url, name, features) {
    if (isAdTarget(url)) {
      report('popups', callerScript());
      return fakeWindow();
    }
    const blank = !String(url ?? '').trim() || String(url).trim() === 'about:blank';
    if (blank) return deferredWindow(name, features);
    return nativeOpen.call(window, url, name, features);
  }, nativeOpen);
  window.open = guardedOpen;

  // Scripts create a same-origin iframe and borrow its pristine window.open.
  const patchWindow = w => {
    try { if (w && w.open !== guardedOpen) w.open = guardedOpen; } catch { /* cross-origin */ }
  };
  const rawContentWindow = new Map();
  for (const proto of [HTMLIFrameElement.prototype, HTMLFrameElement.prototype, HTMLObjectElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'contentWindow');
    if (!desc?.get) continue;
    rawContentWindow.set(proto, desc.get);
    Object.defineProperty(proto, 'contentWindow', {
      ...desc,
      get: disguise(function () { const w = desc.get.call(this); patchWindow(w); return w; }, desc.get),
    });
  }
  // window.frames[i].open skips the getter above, so also patch each frame the
  // instant it's inserted (scripts insert and use it in the same tick).
  const rawIframeWindow = rawContentWindow.get(HTMLIFrameElement.prototype);
  const patchInserted = node => {
    if (node instanceof HTMLIFrameElement) patchWindow(rawIframeWindow.call(node));
    else if (node?.querySelectorAll) for (const f of node.querySelectorAll('iframe')) patchWindow(rawIframeWindow.call(f));
  };
  for (const [proto, method] of [[Node.prototype, 'appendChild'], [Node.prototype, 'insertBefore'],
    [Node.prototype, 'replaceChild'], [Element.prototype, 'append'], [Element.prototype, 'prepend'],
    [Element.prototype, 'after'], [Element.prototype, 'before'], [Element.prototype, 'replaceWith']]) {
    const native = proto[method];
    proto[method] = disguise(function (...args) {
      const result = native.apply(this, args);
      for (const a of args) patchInserted(a);
      return result;
    }, native);
  }

  // ---- synthetic clicks on links: a.click() / dispatchEvent(new MouseEvent('click')) ----
  // Download buttons do the same thing: build <a href=file download> and click it,
  // often with the file on a storage host. Ads never set `download`, so let those
  // through and tell the background, in case the link also opens a new tab.
  const isAdClick = a => {
    if (!isAdTarget(a.href)) return false;
    if (!a.hasAttribute('download')) return true;
    document.dispatchEvent(new CustomEvent(DOWNLOAD_EVENT, { detail: { href: a.href } }));
    return false;
  };

  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = disguise(function click() {
    if (isAdClick(this)) { report('popups', callerScript()); return; }
    return nativeAnchorClick.call(this);
  }, nativeAnchorClick);

  const nativeDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = disguise(function dispatchEvent(event) {
    if (this instanceof HTMLAnchorElement && event?.type === 'click' && isAdClick(this)) {
      report('popups', callerScript());
      return false;
    }
    return nativeDispatch.call(this, event);
  }, nativeDispatch);

  // ---- top-frame redirects without a user click (the "idle" redirect) ----
  if (window.top === window && window.navigation) {
    window.navigation.addEventListener('navigate', e => {
      if (!e.cancelable || e.userInitiated || e.downloadRequest != null || navigator.userActivation?.isActive) return;
      if (e.navigationType !== 'push' && e.navigationType !== 'replace') return;
      if (!isAdTarget(e.destination.url)) return;
      e.preventDefault();
      report('redirects', callerScript());
    });
  }
})();
