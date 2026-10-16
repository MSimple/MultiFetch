'use strict';

// Floating "download this video" button. Appears when hovering a real video
// element, but ONLY when a direct (non-blob) media URL can actually be handed
// over — the desktop engine downloads plain HTTP, so a button that sends a
// page URL or blob would just produce garbage. Top frame only.

(function () {
  if (window.top !== window.self) return;

  const MIN_W = 160;
  const MIN_H = 90;
  const OVERLAY_ID = 'dmq-video-btn';

  let overlay = null;
  let hideTimer = null;
  let target = null;
  let videos = [];

  // Labels come from the service worker (page scripts cannot load the
  // extension's i18n module); English defaults cover the pre-load moment.
  let LABELS = {
    downloadVideo: '⬇ Download this video',
    sending: 'Sending…',
    sent: 'Sent ✓',
    sendFailed: 'Send failed',
  };

  function isCandidate(el) {
    if (!(el instanceof HTMLVideoElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return false;
    if (el.readyState === 0 && !el.currentSrc && !el.querySelector('source')) return false;
    return true;
  }

  function refreshVideos() {
    videos = [...document.querySelectorAll('video')].filter(isCandidate);
  }

  function videoUnderPoint(x, y) {
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = v;
        }
      }
    }
    return best;
  }

  function directSrc(video) {
    for (const u of [video.currentSrc, video.src]) {
      if (u && /^https?:/i.test(u)) return u;
    }
    for (const s of video.querySelectorAll('source')) {
      if (s.src && /^https?:/i.test(s.src)) return s.src;
    }
    return null;
  }

  function ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function loadLabels() {
    const resp = await ask({
      type: 'get-labels',
      keys: ['content.downloadVideo', 'content.sending', 'content.sent', 'content.sendFailed'],
    });
    if (resp && resp.ok && resp.labels) {
      LABELS = {
        downloadVideo: resp.labels['content.downloadVideo'],
        sending: resp.labels['content.sending'],
        sent: resp.labels['content.sent'],
        sendFailed: resp.labels['content.sendFailed'],
      };
      if (overlay) {
        const btn = overlay.querySelector('button');
        if (btn && !btn.dataset.busy) btn.textContent = LABELS.downloadVideo;
      }
    }
  }

  async function bestSniffedMedia() {
    const resp = await ask({ type: 'get-sniffed-for-tab' });
    const items = (resp && resp.items) || [];
    const media = items.filter(
      (r) => r.category === 'video' || r.category === 'audio' || /\.(mp4|webm|mkv|mov|m4v|mp3|m4a|flac)(\?|$)/i.test(r.url)
    );
    if (media.length === 0) return null;
    media.sort((a, b) => (b.size || 0) - (a.size || 0));
    return media[0];
  }

  function buildOverlay() {
    if (overlay) return overlay;
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    Object.assign(el.style, {
      position: 'fixed',
      zIndex: '2147483647',
      display: 'none',
      pointerEvents: 'auto',
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = LABELS.downloadVideo;
    Object.assign(btn.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '7px 12px',
      border: 'none',
      borderRadius: '8px',
      background: 'linear-gradient(135deg,#3b82f0,#2456c8)',
      color: '#fff',
      font: '600 13px/1 "Microsoft YaHei",system-ui,sans-serif',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,.35)',
      whiteSpace: 'nowrap',
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void triggerDownload(btn);
    });
    el.appendChild(btn);
    el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    el.addEventListener('mouseleave', scheduleHide);
    (document.body || document.documentElement).appendChild(el);
    overlay = el;
    return el;
  }

  function positionOverlay(video) {
    const el = buildOverlay();
    const r = video.getBoundingClientRect();
    el.style.display = 'block';
    el.style.top = Math.max(6, r.top + 10) + 'px';
    const w = el.offsetWidth || 140;
    el.style.left = Math.min(window.innerWidth - w - 6, r.right - w - 10) + 'px';
  }

  async function showOverlayFor(video) {
    if (!isCandidate(video)) return;
    target = video;
    if (directSrc(video)) {
      positionOverlay(video);
      return;
    }
    // blob/MSE source: only offer the button when the network sniffer actually
    // saw a direct media URL on this page.
    const pick = await bestSniffedMedia();
    if (pick && target === video) {
      video.__dmqPick = pick;
      positionOverlay(video);
    } else if (target === video) {
      scheduleHide();
    }
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (overlay) overlay.style.display = 'none';
    }, 600);
  }

  async function triggerDownload(btn) {
    const video = target;
    let item = null;
    if (video && video.__dmqPick) {
      item = { url: video.__dmqPick.url, filename: video.__dmqPick.filename || document.title + '.mp4' };
    } else if (video) {
      const src = directSrc(video);
      if (src) item = { url: src, filename: guessFilename(src) };
    }
    if (!item) {
      const pick = await bestSniffedMedia();
      if (pick) item = { url: pick.url, filename: pick.filename || document.title + '.mp4' };
    }
    if (!item) return;

    btn.dataset.busy = '1';
    btn.textContent = LABELS.sending;
    const resp = await ask({ type: 'send-items', items: [{ url: item.url, filename: item.filename, referer: location.href }] });
    const ok = resp && resp.ok && (resp.sent > 0 || resp.queued > 0);
    btn.textContent = ok ? LABELS.sent : LABELS.sendFailed;
    setTimeout(() => {
      delete btn.dataset.busy;
      btn.textContent = LABELS.downloadVideo;
    }, 1800);
  }

  function guessFilename(url) {
    try {
      const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (base && base.includes('.')) return base;
    } catch {
      /* fall through */
    }
    return (document.title || 'video') + '.mp4';
  }

  // Hit-testing on document mousemove: many sites stack transparent
  // control layers over <video>, so element-level mouseenter never fires.
  // Geometry does not care what sits on top.
  let lastMove = 0;
  document.addEventListener(
    'mousemove',
    (e) => {
      const now = Date.now();
      if (now - lastMove < 80) return;
      lastMove = now;
      const v = videoUnderPoint(e.clientX, e.clientY);
      if (v) {
        void showOverlayFor(v);
      } else if (overlay && overlay.style.display !== 'none') {
        const o = overlay.getBoundingClientRect();
        const onBtn = e.clientX >= o.left && e.clientX <= o.right && e.clientY >= o.top && e.clientY <= o.bottom;
        if (!onBtn) scheduleHide();
      }
    },
    true
  );

  window.addEventListener(
    'scroll',
    () => {
      if (overlay && overlay.style.display !== 'none' && target) positionOverlay(target);
    },
    true
  );
  window.addEventListener('resize', () => {
    refreshVideos();
    if (overlay && overlay.style.display !== 'none' && target) positionOverlay(target);
  });
  setInterval(refreshVideos, 2000);
  void loadLabels();
  refreshVideos();
})();
