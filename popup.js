const DEFAULTS = { enabled: true, mode: 'person', sensitivity: 'normal', debug: false, autoMute: true };
const $ = (s) => document.querySelector(s);
let tabId = null;

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const k of ['enabled', 'autoMute', 'debug']) {
    const el = $('#' + k);
    el.checked = !!s[k];
    el.addEventListener('change', () => chrome.storage.sync.set({ [k]: el.checked }));
  }
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.key;
    const mark = (v) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    mark(s[key]);
    if (key === 'mode') hint(s[key]);
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      mark(b.dataset.v);
      if (key === 'mode') hint(b.dataset.v);
      chrome.storage.sync.set({ [key]: b.dataset.v });
    });
  });
});

function hint(mode) {
  $('#modeHint').textContent = mode === 'person'
    ? 'Your room stays. Step out of view for a few seconds once so it can learn the empty room.'
    : 'The whole picture crumbles away and leaves a dark frame.';
}

function setStatus(text, cls = '') {
  $('#statusText').textContent = text;
  $('#status').className = cls;
}

async function refresh() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  let st = null;
  if (tabId != null) st = await chrome.tabs.sendMessage(tabId, { type: 'status' }).catch(() => null);
  const btn = $('#toggle');
  if (!st) {
    btn.disabled = true;
    setStatus('Open a Google Meet tab (reload it if it was already open)');
    return;
  }
  btn.disabled = false;
  const gone = st.phase === 'vanished' || st.phase === 'vanishing';
  $('#toggleLabel').textContent = gone ? 'Come back' : 'Vanish now';
  if (!st.enabled) setStatus('Snap detection is off — shortcut still works', 'warn');
  else if (!st.camera) setStatus('Turn your camera on to snap', 'warn');
  else if (st.detector === 'error') setStatus('Hand tracking failed — use the shortcut', 'warn');
  else if (st.detector !== 'ready') setStatus('Loading hand tracking…', 'warn');
  else setStatus(gone ? 'You’re dust — snap to come back' : 'Ready — snap to vanish', 'ok');
}

$('#toggle').addEventListener('click', async () => {
  if (tabId == null) return;
  await chrome.tabs.sendMessage(tabId, { type: 'toggle' }).catch(() => null);
  setTimeout(refresh, 150);
});

refresh();
setInterval(refresh, 1000);
