import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteOf, isAuthUrl, judgePopup, judgeNavigation } from '../src/shared.js';

const SITE = 'https://topcinemaa.vip/some-episode/watch/';
const NOW = 1_000_000;

test('siteOf groups subdomains and handles two-label suffixes', () => {
  assert.equal(siteOf('https://www.topcinemaa.vip/x'), 'topcinemaa.vip');
  assert.equal(siteOf('https://down.vidtube.one/embed.html'), 'vidtube.one');
  assert.equal(siteOf('https://news.bbc.co.uk/'), 'bbc.co.uk');
  assert.equal(siteOf('blob:https://player.example.com/uuid'), 'example.com');
  assert.equal(siteOf('not a url'), '');
});

test('isAuthUrl only matches sign-in pages, not all of google', () => {
  assert.ok(isAuthUrl('https://accounts.google.com/o/oauth2/auth'));
  assert.ok(!isAuthUrl('https://www.google.com/search?q=Sadanews'));
});

test('popup: ad tabs observed on topcinemaa are closed', () => {
  for (const targetUrl of [
    'https://www.sadanews.ps/news/348607.html',
    'https://hibt.com/btcxxxxibtt/kxwa/index.html?s0=138848',
    'https://www.google.com/search?q=Sadanews',
    'data:text/html,<script>location="https://ad.example"</script>',
  ]) {
    assert.equal(judgePopup({ openerUrl: SITE, targetUrl, now: NOW }), 'close', targetUrl);
  }
});

test('popup: same site, sign-in and disabled sites are allowed', () => {
  assert.equal(judgePopup({ openerUrl: SITE, targetUrl: 'https://topcinemaa.vip/other', now: NOW }), 'allow');
  assert.equal(judgePopup({ openerUrl: SITE, targetUrl: 'https://accounts.google.com/signin', now: NOW }), 'allow');
  assert.equal(judgePopup({
    openerUrl: SITE, targetUrl: 'https://ads.example/x', disabledSites: ['topcinemaa.vip'], now: NOW,
  }), 'allow');
});

test('popup: about:blank waits for its real URL', () => {
  assert.equal(judgePopup({ openerUrl: SITE, targetUrl: 'about:blank', now: NOW }), 'wait');
});

test('popup: a real link click to that site allows it, but only briefly and only for that site', () => {
  const gesture = { time: NOW - 500, href: 'https://t.me/topcinema' };
  assert.equal(judgePopup({ openerUrl: SITE, targetUrl: 'https://t.me/topcinema', gesture, now: NOW }), 'allow');
  assert.equal(judgePopup({ openerUrl: SITE, targetUrl: 'https://ads.example/', gesture, now: NOW }), 'close');
  assert.equal(judgePopup({
    openerUrl: SITE, targetUrl: 'https://t.me/topcinema', gesture: { ...gesture, time: NOW - 5000 }, now: NOW,
  }), 'close');
});

test('popup: tabs opened from non-web pages are left alone', () => {
  assert.equal(judgePopup({ openerUrl: 'chrome://newtab/', targetUrl: 'https://ads.example/', now: NOW }), 'allow');
});

test('navigation: idle cross-site redirect is reverted', () => {
  assert.equal(judgeNavigation({
    fromUrl: SITE, toUrl: 'https://ads.example/landing', transitionType: 'link',
    transitionQualifiers: ['client_redirect'], now: NOW,
  }), 'revert');
});

test('navigation: user-driven or same-site navigations are allowed', () => {
  const base = { fromUrl: SITE, toUrl: 'https://other.example/', now: NOW };
  assert.equal(judgeNavigation({ ...base, transitionType: 'typed' }), 'allow');
  assert.equal(judgeNavigation({ ...base, transitionType: 'auto_bookmark' }), 'allow');
  assert.equal(judgeNavigation({ ...base, transitionType: 'link', transitionQualifiers: ['forward_back'] }), 'allow');
  assert.equal(judgeNavigation({ ...base, transitionType: 'link', gesture: { time: NOW - 300 } }), 'allow');
  assert.equal(judgeNavigation({ ...base, toUrl: 'https://topcinemaa.vip/next', transitionType: 'link' }), 'allow');
  assert.equal(judgeNavigation({ ...base, transitionType: 'link', disabledSites: ['topcinemaa.vip'] }), 'allow');
});
