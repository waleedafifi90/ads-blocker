import { siteOf, isWebUrl } from '../src/shared.js';

const $ = id => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const site = isWebUrl(tab?.url) ? siteOf(tab.url) : '';

async function render() {
  const { disabledSites = [], learnedHosts = [], stats = {} } =
    await chrome.storage.local.get(['disabledSites', 'learnedHosts', 'stats']);
  const tabState = (await chrome.storage.session.get(`tab:${tab?.id}`))[`tab:${tab?.id}`] ?? {};

  $('site').textContent = site || '—';
  $('enabled').checked = !!site && !disabledSites.includes(site);
  $('enabled').disabled = !site;
  $('tab-count').textContent = tabState.count ?? 0;
  $('popups').textContent = stats.popups ?? 0;
  $('redirects').textContent = stats.redirects ?? 0;
  $('overlays').textContent = stats.overlays ?? 0;
  $('learned').textContent = learnedHosts.length;
}

$('enabled').addEventListener('change', async e => {
  const { disabledSites = [] } = await chrome.storage.local.get('disabledSites');
  const next = e.target.checked ? disabledSites.filter(s => s !== site) : [...new Set([...disabledSites, site])];
  await chrome.storage.local.set({ disabledSites: next });
  $('reload-hint').hidden = false;
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ learnedHosts: [] });
  render();
});

render();
