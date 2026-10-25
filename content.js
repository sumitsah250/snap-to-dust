// Isolated-world content script: owns the vanish/return state, mutes and unmutes Meet's
// microphone, hosts the detector iframe and shows small status toasts.
(() => {
  'use strict';
  const DEFAULTS = { enabled: true, mode: 'person', sensitivity: 'normal', debug: false, autoMute: true };
  let settings = { ...DEFAULTS };
  let phase = 'visible';
  let camera = false;
  let detectorStatus = 'idle';
  let busyUntil = 0;
  let iframe = null;
  let readyToastShown = false;
  let roomTipShown = false;
  let room = 0;

  // ---------------------------------------------------------------- settings
  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    pushSettings();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    pushSettings();
    styleIframe();
  });

  const toPage = (msg) => window.postMessage({ __snapdust: 1, from: 'content', ...msg }, '*');
  function pushSettings() {
    toPage({ type: 'settings', settings: { enabled: settings.enabled, mode: settings.mode } });
  }
  toPage({ type: 'hello' });

  // ---------------------------------------------------------------- messages
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.__snapdust !== 1) return;
    if (e.source === window && m.from === 'page') {
      if (m.type === 'hello') pushSettings();
      else if (m.type === 'need-detector') ensureDetector();
      else if (m.type === 'state') { phase = m.state; camera = m.camera; room = m.room || 0; }
      return;
    }
    if (iframe && e.source === iframe.contentWindow && m.from === 'detector') {
      if (m.type === 'snap') toggle('snap');
      else if (m.type === 'status') onDetectorStatus(m);
      else if (m.type === 'size' && settings.debug) iframe.style.height = `${Math.min(400, m.h | 0)}px`;
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'toggle') {
      const did = toggle('manual');
      reply({ ok: true, did, phase });
    } else if (msg?.type === 'status') {
      reply({ ok: true, phase, camera, detector: detectorStatus, enabled: settings.enabled });
    }
  });

  function onDetectorStatus(m) {
    detectorStatus = m.status;
    if (m.status === 'ready' && !readyToastShown && settings.enabled) {
      readyToastShown = true;
      toast('Snap to Dust is ready', 'Snap your fingers on camera to vanish.');
    } else if (m.status === 'error') {
      toast('Snap detection failed to start', m.error || 'Shortcut Alt+Shift+S still works.', 6000);
    }
  }

  // ---------------------------------------------------------------- vanish / return
  function toggle(source) {
    if (source === 'snap' && !settings.enabled) return false;
    const now = Date.now();
    if (now < busyUntil) return false;
    if (phase === 'visible' || phase === 'returning') vanish();
    else comeBack();
    return true;
  }

  function vanish() {
    busyUntil = Date.now() + 1600;
    phase = 'vanishing';
    toPage({ type: 'cmd', action: 'vanish' });
    if (settings.autoMute) setMicMuted(true);
    toast('Snap.', settings.autoMute ? 'You turned to dust. Mic muted.' : 'You turned to dust.');
    if (settings.mode === 'person' && camera && room < 0.93 && !roomTipShown) {
      roomTipShown = true;
      setTimeout(() => toast('Tip:', 'step out of view for ~3 s once. It learns your empty room, so you vanish without a trace.', 7000), 3000);
    }
  }

  function comeBack() {
    busyUntil = Date.now() + 1600;
    phase = 'returning';
    toPage({ type: 'cmd', action: 'return' });
    if (settings.autoMute) setTimeout(() => setMicMuted(false), camera ? 1100 : 0);
    toast('You’re back.', settings.autoMute ? 'Mic on.' : '');
  }

  // ---------------------------------------------------------------- microphone
  // Meet's mic toggle: current builds expose data-is-muted on the button; older builds
  // only had an English tooltip. We try both, and fall back to Meet's Ctrl/Cmd+D shortcut.
  const MIC_RE = /micro|mikro|\bmic\b|mikrof|マイク|麦克风|麥克風|마이크|микрофон|माइक|ميكروفون|מיקרופון/i;
  const CAM_RE = /cam|kamera|câmera|caméra|cámara|カメラ|摄像头|攝影機|카메라|камер|कैमरा|كاميرا|מצלמה|video/i;
  let shortcutToggled = false; // we pressed Ctrl+D blind and must undo it on return

  const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-tooltip'), el.getAttribute('title')].filter(Boolean).join(' ');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const isMicLabel = (el) => { const l = labelOf(el); return MIC_RE.test(l) && !CAM_RE.test(l); };

  function findMicToggle() {
    const flagged = [...document.querySelectorAll('[data-is-muted]')].filter(visible);
    const labelled = [...document.querySelectorAll('button[aria-label],[role="button"][aria-label],[data-tooltip]')].filter(visible);
    return flagged.find(isMicLabel)
      || labelled.find(isMicLabel)
      // Unlabelled fallback: Meet always places the mic toggle before the camera toggle.
      || flagged.find((el) => !CAM_RE.test(labelOf(el)))
      || null;
  }

  function mutedState(el) {
    const flag = el.closest('[data-is-muted]') || el.querySelector('[data-is-muted]');
    if (flag) return flag.getAttribute('data-is-muted') === 'true';
    const l = labelOf(el);
    if (/turn on micro|unmute/i.test(l)) return true;
    if (/turn off micro|\bmute\b/i.test(l)) return false;
    return null;
  }

  function clickTarget(el) {
    return el.matches('button,[role="button"]') ? el : el.querySelector('button,[role="button"]') || el;
  }

  function setMicMuted(muted, attempt = 0) {
    const el = findMicToggle();
    if (!el) {
      // No button found (e.g. hidden toolbar): toggle blind once and remember it.
      if (attempt === 0 && (muted ? !shortcutToggled : shortcutToggled)) {
        pressMeetShortcut();
        shortcutToggled = muted;
      }
      return;
    }
    const state = mutedState(el);
    if (state === muted) { shortcutToggled = false; return; }
    if (state === null && attempt > 0) return; // can't verify; one click is all we risk
    clickTarget(el).click();
    if (attempt < 2) setTimeout(() => setMicMuted(muted, attempt + 1), 450);
  }

  function pressMeetShortcut() {
    const mac = /Mac/i.test(navigator.platform);
    const init = { key: 'd', code: 'KeyD', keyCode: 68, which: 68, bubbles: true, cancelable: true, ctrlKey: !mac, metaKey: mac };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // ---------------------------------------------------------------- detector iframe
  function ensureDetector() {
    if (iframe?.isConnected) return;
    iframe = document.createElement('iframe');
    iframe.id = '__snapdust_detector';
    iframe.src = chrome.runtime.getURL('detector.html');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    styleIframe();
    document.documentElement.appendChild(iframe);
  }
  setInterval(() => { if (iframe && !iframe.isConnected) { iframe = null; ensureDetector(); } }, 3000);

  function styleIframe() {
    if (!iframe) return;
    iframe.style.cssText = settings.debug
      ? 'position:fixed;left:16px;bottom:96px;width:256px;height:178px;border:0;border-radius:12px;z-index:2147483646;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.45);color-scheme:normal;background:transparent'
      : 'position:fixed;left:0;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;z-index:-1';
  }

  // ---------------------------------------------------------------- toasts
  let toastRoot = null, toastTimer = 0;
  function toast(title, body = '', ms = 2800) {
    if (!toastRoot) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none';
      toastRoot = host.attachShadow({ mode: 'closed' });
      toastRoot.innerHTML = `<style>
        .t{display:flex;gap:10px;align-items:center;padding:10px 16px 10px 12px;border-radius:999px;
           background:rgba(22,20,26,.92);color:#f4efe6;font:500 13px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
           box-shadow:0 10px 30px rgba(0,0,0,.35);opacity:0;transform:translateY(-8px);transition:opacity .25s,transform .25s;white-space:nowrap}
        .t.on{opacity:1;transform:none}
        .g{width:22px;height:22px;flex:none}
        b{font-weight:650;margin-right:4px}
        span{color:#cfc6b8}
      </style><div class="t"><svg class="g" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="9" cy="12" r="5.5" fill="#e8b45a"/><g fill="#e8b45a"><rect x="16" y="6" width="2.2" height="2.2" opacity=".9"/>
        <rect x="19.5" y="9.5" width="1.8" height="1.8" opacity=".7"/><rect x="16.5" y="13" width="1.6" height="1.6" opacity=".55"/>
        <rect x="20" y="16" width="1.3" height="1.3" opacity=".4"/></g></svg><div><b></b><span></span></div></div>`;
      document.documentElement.appendChild(host);
    }
    const el = toastRoot.querySelector('.t');
    toastRoot.querySelector('b').textContent = title;
    toastRoot.querySelector('span').textContent = body;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
})();
