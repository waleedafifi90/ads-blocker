# topcinemaa.vip — ad flow analysis (2026-10-31)

Test page: `/…doctor-x-mafia-in-white-…-7-…/watch/` (player server: VideoTube)

## Layer 1 — the main site (topcinemaa.vip)

- Inline loader injects `https://llvpn.com/tag.min.js` with `data-zone="6969540"` (Monetag/PropellerAds style "OnClick" pop-under).
- Related traffic: `my.rtmark.net/gid.js` (fingerprinting, called repeatedly), `luugy.com/5/6969540/`, `ay267.com/ct?zoneid=6969540` (click tracking, POST).
- **Click trap:** a `<div>` with a random class (e.g. `rkmcqs`) is appended directly to `<html>` (outside `<body>`),
  `position:absolute; z-index:2147483647; background:transparent`. The container has `pointer-events:none`, but it holds two children with `pointer-events:auto`:
  - one sized exactly like the player iframe (796x520) and placed over it
  - one covering the whole page
- The div is **removed and re-added every ~300ms**, so deleting it once does nothing.
- On a click: POST to `ay267.com/ct`, then a new tab opens through a `data:` URL (strips the referrer), then the advertiser's page loads.
- `window.open` was not the native function after load. The tag keeps its own reference, so overriding `window.open` late (after page scripts) doesn't catch it. It has to be overridden at `document_start` in the MAIN world.
- Anti-devtools: `console.log(Object.defineProperties(new Error,{message:{get(){window._xxx()}}}))`, which fires a callback when DevTools inspects the object.

## Layer 2 — the player iframe (down.vidtube.one/embed-*.html)

Cross-origin, so the top page's scripts can't touch it. It needs its own content script (`all_frames: true`).

Scripts/hosts seen:
- `portalfluently.com/sfp.js`
- `5gn.bext7jc1p8yb8wxzpjcni.cfd/…` (random subdomain on a throwaway TLD)
- `dressedoutrageousrun.com/ed/d1/17/<hash>.js` (random-word domain, Adsterra-style)
- `jnbhi.com/tag.min.js` (Monetag again)
- 27KB obfuscated inline loader (string-shuffled), probably ad recovery that works around ad blockers
- also seen: `protrafficinspector.com`, `wpfsuxpusdtswd.com`, `smockeddesmoid.qpon`, `spendsdetachment.com`, `jcphi.com`
- same anti-devtools trick
- an injected "Download this video" bar on top of the player (fake download CTA)

## Observed click flow

| Click | Landed on | Result |
|---|---|---|
| 1 | top-page overlay | new tab → sadanews.ps (via data: URL) |
| 2 | inside player iframe | new tab → hibt.com (crypto) + fake "Download this video" bar appears |
| 3 | inside player iframe | new tab → google.com/search?q=Sadanews… (fake search traffic) |

The video never started after 3 clicks.

## Idle redirect

Not reproduced during ~45s of idle watching. The user reports that the current tab gets redirected
after some time. Likely candidates: Monetag "vignette/interstitial" formats, or a timer in the
iframe that calls `top.location = …` (the iframe has no `sandbox` attribute, so it can navigate the top window).

## Implications for the extension

1. **Domain lists alone won't hold**: the iframe uses rotating random domains. Use them as a first layer only
   (DNR rules for known hosts: llvpn.com, rtmark.net, luugy.com, ay267.com, jnbhi.com, …).
2. **Behavioral blocking in the MAIN world at `document_start`, in all frames**:
   - wrap `window.open` (and `open` from created iframes' contentWindow), allowing only same-site or user-intended opens
   - block `<a target=_blank>` clicks synthesized on elements outside the real UI
   - neutralize max-z-index transparent overlays: watch `document.documentElement` with a MutationObserver
     and remove `DIV`s attached outside `<body>`, plus any transparent full-size element above an iframe
3. **Stop top-frame hijacks from the player**: use the Navigation API (`navigation.addEventListener('navigate', …)`)
   to cancel cross-site navigations that the user didn't trigger, and/or a DNR rule blocking `main_frame` requests
   to ad hosts. Option: inject `sandbox="allow-scripts allow-same-origin allow-presentation"` on player iframes
   (no `allow-top-navigation` / `allow-popups`). Test per host, because some players break when sandboxed.
4. **Cosmetic**: hide the fake "Download this video" bar inside the player frame.
