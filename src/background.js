import { judgePopup, judgeNavigation, siteOf, sitePatterns, isWebUrl } from './shared.js';

// State lives in chrome.storage so it survives the service worker going to sleep
// (the idle redirect can happen minutes after the last event).
//   local:   disabledSites[], learnedHosts[], stats {popups, redirects, overlays}
//   session: tab:<id> -> { url, gesture: {time, href} }, pending:<id> -> openerUrl

const LEARNED_RULE_BASE = 10_000; // dynamic rule ids >= this are learned hosts
const DISABLED_RULE_BASE = 1_000; // dynamic rule ids in [1000, 10000) are per-site allow rules
const MAX_LEARNED = 500;

// Hosts we never learn, even if they show up on an ad call stack.
const NEVER_LEARN = new Set([
  'googleapis.com', 'gstatic.com', 'cloudflare.com', 'jsdelivr.net', 'cdnjs.com',
  'jquery.com', 'unpkg.com', 'jwplayer.com', 'jwpcdn.com', 'cloudfront.net',
]);

async function getLocal() {
  const { disabledSites = [], learnedHosts = [], stats = { popups: 0, redirects: 0, overlays: 0 } } =
    await chrome.storage.local.get(['disabledSites', 'learnedHosts', 'stats']);
  return { disabledSites, learnedHosts, stats };
}

async function getTab(tabId) {
  const key = `tab:${tabId}`;
  return (await chrome.storage.session.get(key))[key] ?? {};
}

async function patchTab(tabId, patch) {
  const key = `tab:${tabId}`;
  const cur = (await chrome.storage.session.get(key))[key] ?? {};
  await chrome.storage.session.set({ [key]: { ...cur, ...patch } });
}

async function countBlocked(kind, tabId) {
  const { stats } = await getLocal();
  stats[kind] = (stats[kind] ?? 0) + 1;
  await chrome.storage.local.set({ stats });
  if (tabId == null || tabId < 0) return;
  const tab = await getTab(tabId);
  const count = (tab.count ?? 0) + 1;
  await patchTab(tabId, { count });
  chrome.action.setBadgeText({ tabId, text: String(count) }).catch(() => {});
}

// ---------- content script registration (respects per-site disable) ----------

async function registerScripts() {
  const { disabledSites } = await getLocal();
  const excludeMatches = disabledSites.flatMap(sitePatterns);
  const common = {
    matches: ['<all_urls>'],
    excludeMatches,
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
  };
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  await chrome.scripting.registerContentScripts([
    { id: 'main-world', js: ['src/main-world.js'], world: 'MAIN', ...common },
    { id: 'isolated', js: ['src/isolated.js'], world: 'ISOLATED', ...common },
  ]);
}

// ---------- dynamic DNR rules: per-site disable + learned ad hosts ----------

async function syncRules() {
  const { disabledSites, learnedHosts } = await getLocal();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = [
    ...disabledSites.map((site, i) => ({
      id: DISABLED_RULE_BASE + i,
      priority: 100,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: [site], resourceTypes: ['main_frame', 'sub_frame'] },
    })),
    ...learnedHosts.map((host, i) => ({
      id: LEARNED_RULE_BASE + i,
      priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: [host],
        domainType: 'thirdParty',
        resourceTypes: ['script', 'sub_frame', 'xmlhttprequest', 'ping', 'image'],
      },
    })),
  ];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules,
  });
}

async function learnHost(scriptUrl, pageUrl) {
  if (!isWebUrl(scriptUrl)) return;
  const host = siteOf(scriptUrl);
  // Never learn the site itself: blocking its own scripts would break it.
  if (!host || host === siteOf(pageUrl) || NEVER_LEARN.has(host)) return;
  const { learnedHosts, disabledSites } = await getLocal();
  if (learnedHosts.includes(host) || disabledSites.includes(siteOf(pageUrl))) return;
  learnedHosts.push(host);
  await chrome.storage.local.set({ learnedHosts: learnedHosts.slice(-MAX_LEARNED) }); // onChanged syncs rules
}

// ---------- popups / pop-unders ----------

async function decidePopup(tabId, openerUrl, targetUrl, openerTabId) {
  const { disabledSites } = await getLocal();
  const { gesture } = await getTab(openerTabId);
  const verdict = judgePopup({ openerUrl, targetUrl, disabledSites, gesture });
  if (verdict === 'wait') {
    await chrome.storage.session.set({ [`pending:${tabId}`]: { openerUrl, openerTabId } });
    return;
  }
  await chrome.storage.session.remove(`pending:${tabId}`);
  if (verdict === 'close') {
    await chrome.tabs.remove(tabId).catch(() => {});
    await countBlocked('popups', openerTabId);
  }
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(async details => {
  const opener = await getTab(details.sourceTabId);
  const openerUrl = opener.url ?? (await chrome.tabs.get(details.sourceTabId).catch(() => null))?.url;
  await decidePopup(details.tabId, openerUrl, details.url, details.sourceTabId);
});

// A blank popup that's now being sent somewhere: judge it before the page loads,
// so an ad never gets a chance to render. Returns false if the tab was closed.
async function settlePending(tabId, url) {
  if (url === 'about:blank') return true;
  const pendingKey = `pending:${tabId}`;
  const pending = (await chrome.storage.session.get(pendingKey))[pendingKey];
  if (!pending) return true;
  await decidePopup(tabId, pending.openerUrl, url, pending.openerTabId);
  return !!(await chrome.tabs.get(tabId).catch(() => null));
}

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId === 0) settlePending(details.tabId, details.url);
});

// ---------- top-frame hijacks (idle redirects, iframe-driven navigations) ----------

chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  if (!(await settlePending(tabId, url))) return;

  const tab = await getTab(tabId);
  const { disabledSites } = await getLocal();
  const verdict = judgeNavigation({
    fromUrl: tab.url,
    toUrl: url,
    transitionType: details.transitionType,
    transitionQualifiers: details.transitionQualifiers,
    disabledSites,
    gesture: tab.gesture,
  });

  if (verdict === 'revert') {
    await chrome.tabs.update(tabId, { url: tab.url }).catch(() => {});
    await countBlocked('redirects', tabId);
    return; // keep tab.url pointing at the page the user was on
  }
  await patchTab(tabId, { url, count: siteOf(url) === siteOf(tab.url) ? tab.count : 0 });
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove([`tab:${tabId}`, `pending:${tabId}`]);
});

// ---------- messages from content scripts ----------

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  if (msg.type === 'gesture' && sender.frameId === 0) {
    patchTab(tabId, { gesture: { time: Date.now(), href: msg.href ?? null } });
  } else if (msg.type === 'blocked') {
    countBlocked(msg.kind, tabId);
    if (msg.scriptUrl) learnHost(msg.scriptUrl, sender.tab.url);
  }
});

// ---------- settings changes from the popup ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.disabledSites) registerScripts();
  if (changes.disabledSites || changes.learnedHosts) syncRules();
});

chrome.action.setBadgeBackgroundColor({ color: '#e0756d' });
chrome.action.setBadgeTextColor?.({ color: '#f1f3e3' });

async function init() {
  await registerScripts();
  await syncRules();
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
