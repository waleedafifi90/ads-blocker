// Pure decision logic shared by the background worker and the popup.
// No chrome.* APIs here, so it can be unit-tested with node.

// Public suffixes made of two labels that we care about. Not a full PSL,
// just enough so "news.co.uk" and "bbc.co.uk" aren't treated as the same site.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.br', 'com.tr',
  'com.sa', 'com.eg', 'com.kw', 'com.qa', 'co.il', 'com.ps',
]);

// Sign-in / payment popups that must never be closed.
const AUTH_URLS = [
  { host: 'accounts.google.com' },
  { host: 'appleid.apple.com' },
  { host: 'login.microsoftonline.com' },
  { host: 'login.live.com' },
  { host: 'www.facebook.com', path: '/dialog' },
  { host: 'www.facebook.com', path: '/v' }, // /v19.0/dialog/oauth
  { host: 'www.paypal.com' },
  { host: 'github.com', path: '/login' },
  { host: 'discord.com', path: '/oauth2' },
  { host: 'api.twitter.com', path: '/oauth' },
  { host: 'x.com', path: '/i/oauth2' },
  { host: 'checkout.stripe.com' },
];

export function parseUrl(url) {
  try {
    const u = new URL(url);
    // blob:https://site/uuid -> judge by the inner origin
    return u.protocol === 'blob:' ? new URL(u.pathname) : u;
  } catch {
    return null;
  }
}

export function isWebUrl(url) {
  const u = parseUrl(url);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
}

export function siteOf(url) {
  const u = parseUrl(url);
  if (!u || !u.hostname) return '';
  const host = u.hostname.replace(/^www\./, '');
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.')) return host;
  const parts = host.split('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_LABEL_SUFFIXES.has(lastTwo) && parts.length > 2
    ? parts.slice(-3).join('.')
    : lastTwo;
}

export function isAuthUrl(url) {
  const u = parseUrl(url);
  if (!u) return false;
  return AUTH_URLS.some(a => u.hostname === a.host && (!a.path || u.pathname.startsWith(a.path)));
}

// How long after a real click on a link we still credit the user for what it opens.
export const GESTURE_WINDOW_MS = 2000;
// A context menu can stay open for a while before the user picks an item.
export const MENU_WINDOW_MS = 60_000;

/**
 * A tab was opened by another tab. Decide its fate.
 * @returns {'allow'|'close'|'wait'} 'wait' = no real URL yet (about:blank), judge again on commit.
 */
export function judgePopup({ openerUrl, targetUrl, disabledSites = [], gesture = null, menu = null, now = Date.now() }) {
  if (!isWebUrl(openerUrl)) return 'allow';
  const openerSite = siteOf(openerUrl);
  if (disabledSites.includes(openerSite)) return 'allow';
  if (!targetUrl || targetUrl === 'about:blank') return 'wait';

  // Right after a right-click this is a menu item: open link or image, search for the
  // selection, and so on. Its URL can be anything, so only the timing tells us.
  if (menu && now - menu.time <= MENU_WINDOW_MS) return 'allow';

  // data:/javascript: tabs are the classic pop-under trampoline.
  if (!isWebUrl(targetUrl)) return 'close';

  const targetSite = siteOf(targetUrl);
  if (targetSite === openerSite || isAuthUrl(targetUrl)) return 'allow';

  // The user clicked a real link pointing at this site.
  if (gesture?.href && now - gesture.time <= GESTURE_WINDOW_MS && siteOf(gesture.href) === targetSite) {
    return 'allow';
  }
  return 'close';
}

// Transitions the user clearly asked for (address bar, bookmarks, reload, back/forward).
const USER_TRANSITIONS = new Set(['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'reload', 'start_page']);

/**
 * The top frame of a tab committed a new page. Was it hijacked?
 * @returns {'allow'|'revert'}
 */
export function judgeNavigation({
  fromUrl, toUrl, transitionType, transitionQualifiers = [],
  disabledSites = [], gesture = null, now = Date.now(),
}) {
  if (!isWebUrl(fromUrl) || !isWebUrl(toUrl)) return 'allow';
  const fromSite = siteOf(fromUrl);
  if (disabledSites.includes(fromSite)) return 'allow';
  if (siteOf(toUrl) === fromSite || isAuthUrl(toUrl)) return 'allow';
  if (USER_TRANSITIONS.has(transitionType) || transitionType === 'form_submit') return 'allow';
  if (transitionQualifiers.includes('forward_back') || transitionQualifiers.includes('from_address_bar')) return 'allow';

  // Any real click/keypress in the page shortly before counts as the user's intent.
  if (gesture && now - gesture.time <= GESTURE_WINDOW_MS) return 'allow';
  return 'revert';
}

export function sitePatterns(site) {
  return [`*://${site}/*`, `*://*.${site}/*`];
}
