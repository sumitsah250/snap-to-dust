// Runs inside a hidden extension iframe on the Meet page (its own process), so model
// inference never blocks Meet. Receives small camera frames from the page, runs hand
// tracking (+ person segmentation when needed) and reports snaps and masks back.
import { HandLandmarker, ImageSegmenter } from './lib/vision_bundle.mjs';
import { SnapDetector } from './snap.js';

const TAG = '[Snap to Dust]';
const ORIGIN = location.ancestorOrigins?.[0] || '*';
const DEFAULTS = { enabled: true, mode: 'person', sensitivity: 'normal', debug: false };
let settings = { ...DEFAULTS };
const snap = new SnapDetector(settings.sensitivity);

const post = (msg, transfer = []) => parent.postMessage({ __snapdust: 1, from: 'detector', ...msg }, ORIGIN, transfer);
const url = (p) => chrome.runtime.getURL(p);
const fileset = {
  wasmLoaderPath: url('wasm/vision_wasm_internal.js'),
  wasmBinaryPath: url('wasm/vision_wasm_internal.wasm'),
};

// ---------------------------------------------------------------- settings
function applySettings() {
  snap.setSensitivity(settings.sensitivity);
  document.body.classList.toggle('debug', !!settings.debug);
  lastSize = 0; // re-announce size when the overlay is shown again (runs after module init)
}
chrome.storage.sync.get(DEFAULTS, (s) => { settings = { ...DEFAULTS, ...s }; applySettings(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  applySettings();
});

// ---------------------------------------------------------------- models
let hands = null, handsLoading = null;
let seg = null, segLoading = null, segFailed = false;
let personIndex = -1; // which confidence mask is "person"; worked out on first masks

// The GPU delegate is fastest on real graphics hardware but crawls on software
// renderers (blocklisted GPUs), where the CPU delegate is far quicker.
function softwareRenderer() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return true;
  }
}
let delegates = softwareRenderer() ? ['CPU'] : ['GPU', 'CPU'];

async function create(Cls, options) {
  let lastErr;
  for (const delegate of delegates) {
    try {
      return await Cls.createFromOptions(fileset, { ...options, baseOptions: { ...options.baseOptions, delegate } });
    } catch (err) {
      lastErr = err;
      console.warn(TAG, `model init with ${delegate} failed`, err);
    }
  }
  throw lastErr;
}

function loadHands() {
  handsLoading ??= (async () => {
    post({ type: 'status', status: 'loading' });
    try {
      hands = await create(HandLandmarker, {
        baseOptions: { modelAssetPath: url('models/hand_landmarker.task') },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      post({ type: 'status', status: 'ready' });
    } catch (err) {
      post({ type: 'status', status: 'error', error: String(err?.message || err) });
    }
  })();
  return handsLoading;
}

function loadSeg() {
  // Loaded after the hand model: both share one wasm loader global, so never in parallel.
  segLoading ??= (async () => {
    await loadHands();
    try {
      seg = await create(ImageSegmenter, {
        baseOptions: { modelAssetPath: url('models/selfie_segmenter_landscape.tflite') },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    } catch (err) {
      segFailed = true;
    }
  })();
  return segLoading;
}

// If inference turns out slow on this machine's GPU path, rebuild the models on CPU once.
let speedSamples = 0, speedTotal = 0;
function watchSpeed(ms) {
  if (delegates.length < 2 || speedSamples >= 20) return;
  speedSamples++; speedTotal += ms;
  if (speedSamples === 20 && speedTotal / 20 > 60) {
    console.info(TAG, `hand tracking slow on GPU (${(speedTotal / 20).toFixed(0)} ms), switching to CPU`);
    delegates = ['CPU'];
    const old = [hands, seg];
    hands = seg = null; handsLoading = segLoading = null;
    old.forEach((m) => m?.close?.());
    loadHands();
  }
}

// ---------------------------------------------------------------- frames
let lastTs = 0;
let firedAt = -1e9;

window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.__snapdust !== 1 || m.to !== 'detector' || e.source !== parent) return;
  if (m.type === 'frame') onFrame(m.bitmap, !!m.wantMask);
});

function toMask(mp) {
  const f = mp.getAsFloat32Array();
  const u8 = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) u8[i] = f[i] * 255;
  return { w: mp.width, h: mp.height, data: u8 };
}

// With a single-mask model the mask is "person". With two masks, pick the one that is
// lower around the frame border (the border is almost always background).
function pickPerson(masks) {
  if (masks.length === 1) return masks[0];
  if (personIndex < 0) {
    const score = masks.map((mp) => {
      const f = mp.getAsFloat32Array(), w = mp.width, h = mp.height;
      let s = 0, n = 0;
      for (let x = 0; x < w; x += 4) { s += f[x] + f[(h - 1) * w + x]; n += 2; }
      for (let y = 0; y < h; y += 4) { s += f[y * w] + f[y * w + w - 1]; n += 2; }
      return s / n;
    });
    personIndex = score.indexOf(Math.min(...score));
  }
  return masks[personIndex];
}

function onFrame(bitmap, wantMask) {
  let mask = null;
  let handsSeen = 0;
  try {
    if (!settings.enabled) return;
    if (!hands) { loadHands(); return; }
    if (wantMask && !seg && !segFailed) loadSeg();

    let ts = performance.now();
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;

    const t0 = performance.now();
    const res = hands.detectForVideo(bitmap, ts);
    watchSpeed(performance.now() - t0);
    const list = (res.worldLandmarks || []).map((world, i) => ({
      key: res.handedness?.[i]?.[0]?.categoryName || String(i),
      world,
    }));
    handsSeen = list.length;
    const { fired, info } = snap.update(list, ts);
    if (fired) { firedAt = ts; post({ type: 'snap' }); }

    if (wantMask && seg) {
      seg.segmentForVideo(bitmap, ts, (r) => {
        if (r.confidenceMasks?.length) mask = toMask(pickPerson(r.confidenceMasks));
      });
    }
    if (settings.debug) drawDebug(bitmap, res, info, ts - firedAt < 700);
  } catch (err) {
    console.warn(TAG, err);
  } finally {
    bitmap.close();
    if (mask) post({ type: 'done', hands: handsSeen, mask: { w: mask.w, h: mask.h, data: mask.data.buffer } }, [mask.data.buffer]);
    else post({ type: 'done', hands: handsSeen });
  }
}

// ---------------------------------------------------------------- debug overlay
const view = document.getElementById('view');
const vctx = view.getContext('2d');
const dot = document.getElementById('dot');
const txt = document.getElementById('txt');
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

let lastSize = 0;
function drawDebug(bitmap, res, info, justFired) {
  const w = view.width, h = Math.round((w * bitmap.height) / bitmap.width);
  if (view.height !== h) view.height = h;
  const wrapH = document.getElementById('wrap').offsetHeight;
  if (wrapH && wrapH !== lastSize) { lastSize = wrapH; post({ type: 'size', h: wrapH }); }
  vctx.drawImage(bitmap, 0, 0, w, h);
  vctx.fillStyle = 'rgba(0,0,0,0.25)';
  vctx.fillRect(0, 0, w, h);
  (res.landmarks || []).forEach((lm, i) => {
    const st = info[i] || {};
    vctx.strokeStyle = st.armed ? '#ff7a45' : st.set ? '#f2b544' : 'rgba(255,255,255,0.75)';
    vctx.lineWidth = 2;
    vctx.beginPath();
    for (const [a, b] of BONES) { vctx.moveTo(lm[a].x * w, lm[a].y * h); vctx.lineTo(lm[b].x * w, lm[b].y * h); }
    vctx.stroke();
    for (const k of [4, 12]) { vctx.fillStyle = '#fff'; vctx.beginPath(); vctx.arc(lm[k].x * w, lm[k].y * h, 3, 0, 7); vctx.fill(); }
  });
  const a = info.find((x) => x.armed) || info.find((x) => x.set) || info[0];
  dot.className = justFired ? 'fired' : a?.armed ? 'armed' : a?.set ? 'set' : '';
  txt.textContent = justFired ? 'Snap!' : a
    ? `${a.armed ? 'Ready — snap!' : a.set ? 'Hold…' : 'Thumb + middle together'} · gap ${a.pinch.toFixed(2)} · reach ${a.ext.toFixed(2)}`
    : 'Show your hand';
}

post({ type: 'hello' });
