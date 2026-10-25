// Runs in the page's own JS world on meet.google.com, before Meet's scripts.
// It wraps getUserMedia so the camera track Meet receives passes through our GPU
// renderer, which can dissolve you into drifting dust and bring you back.
(() => {
  'use strict';
  if (window.__snapToDustPage) return;
  Object.defineProperty(window, '__snapToDustPage', { value: true });

  const TAG = '[Snap to Dust]';
  const settings = { enabled: true, mode: 'person' };

  // ---------------------------------------------------------------- animation clock
  // One effective time cursor t (seconds). Vanish runs t forward 0 → tMax, return runs
  // it backward, so a snap mid-animation simply reverses direction from where it is.
  const FX = { sweep: 1.45, noise: 0.95, life: 2.0, windX: 0.30, windY: -0.11, returnSpeed: 1.55 };
  const T_MAX = FX.sweep + FX.noise * 0.5 + 0.12 + FX.life * 1.35 + 0.15;
  const T_RETURN_FROM = FX.sweep + FX.noise * 0.5 + FX.life * 0.8;
  const anim = { dir: 0, anchorT: 0, anchorWall: 0, seed: 0, box: [0, 0, 1, 1], person: false, cycle: 0 };
  let phase = 'visible'; // visible | vanishing | vanished | returning

  function animT(now = performance.now()) {
    if (anim.dir === 0) return anim.anchorT;
    const speed = anim.dir > 0 ? 1 : FX.returnSpeed;
    const t = anim.anchorT + (anim.dir * speed * (now - anim.anchorWall)) / 1000;
    return Math.min(T_MAX, Math.max(0, t));
  }

  function settle(now = performance.now()) {
    if (anim.dir > 0 && animT(now) >= T_MAX) {
      anim.dir = 0; anim.anchorT = T_MAX; setPhase('vanished');
    } else if (anim.dir < 0 && animT(now) <= 0) {
      anim.dir = 0; anim.anchorT = 0; setPhase('visible');
    }
  }
  setInterval(settle, 200);

  function setPhase(p) {
    if (phase === p) return;
    phase = p;
    reportState();
  }

  function command(action) {
    const now = performance.now();
    const t = animT(now);
    if (action === 'vanish') {
      if (phase === 'vanished' || phase === 'vanishing') return;
      if (phase === 'visible') beginCycle();
      anim.anchorT = t; anim.anchorWall = now; anim.dir = 1;
      setPhase('vanishing');
    } else if (action === 'return') {
      if (phase === 'visible' || phase === 'returning') return;
      if (phase === 'vanished') {
        beginCycle(); // you may have moved while invisible
        anim.anchorT = T_RETURN_FROM; // skip the stretch where all dust is far off-screen
      } else {
        anim.anchorT = t;
      }
      anim.anchorWall = now; anim.dir = -1;
      setPhase('returning');
    } else if (action === 'reset') {
      anim.dir = 0; anim.anchorT = 0; setPhase('visible');
    }
  }

  function beginCycle() {
    anim.cycle++;
    anim.seed = Math.random() * 100;
    const m = mask.data && performance.now() - mask.at < 1500 ? mask : null;
    const box = settings.mode === 'person' && m ? personBox(m) : null;
    anim.person = !!box;
    anim.box = box || [0, 0, 1, 1];
  }

  // Bounding box of the person in the latest segmentation mask (uv units), or null.
  function personBox(m) {
    const { w, h, data } = m;
    const cols = new Uint16Array(w), rows = new Uint16Array(h);
    let n = 0;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        if (data[o + x] > 140) { cols[x]++; rows[y]++; n++; }
      }
    }
    if (n < w * h * 0.01) return null;
    const minCount = 2;
    let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
    while (x0 < w && cols[x0] < minCount) x0++;
    while (x1 > 0 && cols[x1] < minCount) x1--;
    while (y0 < h && rows[y0] < minCount) y0++;
    while (y1 > 0 && rows[y1] < minCount) y1--;
    if (x1 <= x0 || y1 <= y0) return null;
    const pad = 0.03;
    return [Math.max(0, x0 / w - pad), Math.max(0, y0 / h - pad), Math.min(1, (x1 + 1) / w + pad), Math.min(1, (y1 + 1) / h + pad)];
  }

  // ---------------------------------------------------------------- messaging
  // The learned background outlives any single camera track (Meet restarts the camera
  // when you join from the lobby, switch devices, etc.).
  const plateStore = { data: null, learned: 0, coverage: 0 };

  const post = (msg) => window.postMessage({ __snapdust: 1, from: 'page', ...msg }, '*');
  const engines = new Set();
  function reportState() {
    post({ type: 'state', state: phase, camera: engines.size > 0, room: plateStore.coverage });
  }

  const mask = { data: null, w: 0, h: 0, at: 0, version: 0 };
  const detector = { win: null, inflight: false, sentAt: 0, canvas: null, ctx: null, requested: false };

  function detectorFrame() {
    return document.getElementById('__snapdust_detector');
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.__snapdust !== 1) return;
    if (e.source === window && m.from === 'content') {
      if (m.type === 'settings') Object.assign(settings, m.settings);
      else if (m.type === 'cmd') command(m.action);
      else if (m.type === 'hello') reportState();
      return;
    }
    if (m.from !== 'detector') return;
    const f = detectorFrame();
    if (!f || e.source !== f.contentWindow) return;
    if (m.type === 'hello') {
      detector.win = e.source;
      detector.inflight = false;
    } else if (m.type === 'done') {
      detector.inflight = false;
      if (m.mask) {
        mask.data = new Uint8Array(m.mask.data);
        mask.w = m.mask.w; mask.h = m.mask.h;
        mask.at = performance.now();
        mask.version++;
      }
    }
  });
  post({ type: 'hello' });

  // Send a small copy of the raw camera frame to the detector iframe (it runs in the
  // extension's own process, so hand tracking never blocks Meet's main thread).
  function maybeSendFrame(src, w, h) {
    if (!settings.enabled) return;
    if (!detector.requested) { detector.requested = true; post({ type: 'need-detector' }); }
    if (!detector.win) return;
    const now = performance.now();
    if (detector.inflight) {
      if (now - detector.sentAt > 2000) detector.inflight = false; // lost a reply
      else return;
    }
    const person = settings.mode === 'person';
    const busy = phase !== 'visible';
    const interval = person && busy ? 40 : 66;
    if (now - detector.sentAt < interval) return;
    const dw = 384, dh = Math.max(2, Math.round((dw * h) / w / 2) * 2);
    if (!detector.canvas || detector.canvas.height !== dh) {
      detector.canvas = new OffscreenCanvas(dw, dh);
      detector.ctx = detector.canvas.getContext('2d', { alpha: false });
    }
    detector.ctx.drawImage(src, 0, 0, dw, dh);
    const bitmap = detector.canvas.transferToImageBitmap();
    const wantMask = person && (busy || now - mask.at > 220);
    detector.inflight = true;
    detector.sentAt = now;
    try {
      detector.win.postMessage({ __snapdust: 1, to: 'detector', type: 'frame', bitmap, wantMask }, '*', [bitmap]);
    } catch (err) {
      detector.inflight = false;
      detector.win = null;
      detector.requested = false;
    }
  }

  // ---------------------------------------------------------------- shaders
  const VS_FULL = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform vec4 uBox;
uniform float uSweep, uNoise, uSeed;
uniform sampler2D uMask;
uniform float uHasMask;
uniform vec2 uMaskTexel;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
// Seconds after the snap at which the pixel at uv breaks away.
float departT(vec2 uv){
  vec2 q = (uv - uBox.xy) / max(uBox.zw - uBox.xy, vec2(0.15));
  float s = clamp(1.0 - (0.74 * q.x + 0.26 * (1.0 - q.y)), 0.0, 1.0);
  float aspect = uRes.x / uRes.y;
  float n = fbm(uv * vec2(4.2 * aspect, 4.2) + uSeed);
  float g = vnoise(uv * vec2(34.0 * aspect, 34.0) + uSeed * 1.7);
  return max(0.0, s * uSweep + (n - 0.5) * uNoise + (g - 0.5) * 0.14);
}
float maskRaw(vec2 uv){ return texture(uMask, uv).r; }
// Person coverage, grown a little so edges and hair are fully covered.
float personGrown(vec2 uv, float r, float lo, float hi){
  if (uHasMask < 0.5) return 1.0;
  vec2 o = uMaskTexel * r;
  float m = maskRaw(uv);
  m = max(m, maskRaw(uv + vec2(o.x, 0.0)));  m = max(m, maskRaw(uv - vec2(o.x, 0.0)));
  m = max(m, maskRaw(uv + vec2(0.0, o.y)));  m = max(m, maskRaw(uv - vec2(0.0, o.y)));
  m = max(m, maskRaw(uv + o * 0.7));         m = max(m, maskRaw(uv - o * 0.7));
  m = max(m, maskRaw(uv + vec2(o.x, -o.y) * 0.7)); m = max(m, maskRaw(uv + vec2(-o.x, o.y) * 0.7));
  return smoothstep(lo, hi, m);
}
float personCore(vec2 uv){ return uHasMask < 0.5 ? 1.0 : smoothstep(0.35, 0.65, maskRaw(uv)); }
`;

  // Final picture: live camera, minus pixels that have turned to dust.
  const FS_BASE = COMMON + `
uniform sampler2D uLive;
uniform sampler2D uPlate;
uniform float uT, uPlateOK, uPersonMode;
uniform vec3 uBehind;
out vec4 o;
// Pull-push fill: start from the coarsest average of the known room and refine wherever
// finer levels have actually seen the background.
vec3 plateFill(vec2 uv){
  vec4 s = textureLod(uPlate, uv, 8.0);
  vec3 c = s.a > 0.001 ? s.rgb / s.a : uBehind;
  for (int l = 7; l >= 0; l--){
    s = textureLod(uPlate, uv, float(l));
    if (s.a > 0.001) c = mix(c, s.rgb / s.a, clamp(s.a * 1.6, 0.0, 1.0));
  }
  return c;
}
void main(){
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  vec3 live = texture(uLive, uv).rgb;
  float m = personGrown(uv, 3.0, 0.22, 0.55);
  float T = departT(uv);
  float gone = smoothstep(0.0, 0.035, uT - T);
  float front = (1.0 - smoothstep(0.0, 0.24, T - uT)) * (1.0 - gone);
  float l = dot(live, vec3(0.299, 0.587, 0.114));
  vec3 ash = vec3(0.30, 0.255, 0.215);
  vec3 c = mix(live, mix(vec3(l), ash, 0.55) * 0.8, front * 0.8 * m);
  vec3 behind = (uPersonMode > 0.5 && uPlateOK > 0.5) ? plateFill(uv) : uBehind;
  o = vec4(mix(c, behind, gone * m), 1.0);
}`;

  // Remembers each particle's colour at the instant it breaks away.
  const FS_CAPTURE = COMMON + `
uniform sampler2D uLive;
uniform sampler2D uPrev;
uniform vec2 uGrid;
uniform float uT, uDir;
out vec4 o;
void main(){
  ivec2 cell = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(cell) + 0.5) / uGrid;
  float T = departT(uv);
  vec4 now = vec4(texture(uLive, uv).rgb, personCore(uv));
  o = (uDir < 0.0 || uT <= T) ? now : texelFetch(uPrev, cell, 0);
}`;

  // Slowly learns what the room behind you looks like (premultiplied, alpha = confidence).
  const FS_PLATE = COMMON + `
uniform sampler2D uLive;
uniform sampler2D uPrev;
uniform vec2 uPlateRes;
uniform float uRate;
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uPlateRes;
  vec4 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0);
  float m = uHasMask < 0.5 ? 1.0 : personGrown(uv, 7.0, 0.06, 0.2);
  o = mix(prev, vec4(texture(uLive, uv).rgb, 1.0), uRate * (1.0 - m));
}`;

  const VS_DUST = COMMON + `
uniform sampler2D uCap;
uniform vec2 uGrid;
uniform float uT, uLife, uCell;
uniform vec2 uWind;
out vec4 vCol;
out float vSize;
void main(){
  int gw = int(uGrid.x);
  ivec2 cell = ivec2(gl_VertexID % gw, gl_VertexID / gw);
  vec2 uv = (vec2(cell) + 0.5) / uGrid;
  float T = departT(uv);
  float age = uT - T;
  vec2 fc = vec2(cell);
  float r1 = hash12(fc + 0.37), r2 = hash12(fc * 1.71 + 5.3), r3 = hash12(fc * 0.73 + 11.9);
  float life = uLife * (0.65 + 0.7 * r2);
  vec4 col = texelFetch(uCap, cell, 0);
  if (age <= 0.0 || age >= life || col.a < 0.3){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); vSize = 0.0; return;
  }
  float lt = age / life;
  float W = uRes.x;
  // gusts accelerate the dust away; it lifts and swirls as it goes
  vec2 disp = 0.5 * uWind * W * (0.5 + 1.0 * r1) * age * age;
  disp += vec2(0.012, -0.034) * W * age * (0.25 + r3);
  float ph = r1 * 6.2831853;
  float sw = (0.010 + 0.028 * r2) * W * min(age * 1.4, 1.0);
  disp += vec2(sin(age * 2.6 + ph) - sin(ph), cos(age * 2.0 + ph * 1.7) - cos(ph * 1.7)) * sw;
  disp += (vec2(r1, r3) - 0.5) * uCell * 2.2 * smoothstep(0.0, 0.3, age);
  vec2 px = uv * uRes + disp;
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  float big = pow(r3, 12.0);
  float size = uCell * (1.2 + 2.4 * big) * (1.0 - 0.5 * lt);
  gl_PointSize = size;
  vSize = size;
  vec3 ash = vec3(0.32, 0.27, 0.23) * (0.75 + 0.5 * r2);
  vec3 c = mix(col.rgb, ash, smoothstep(0.0, 0.5, lt) * 0.85) * (1.0 - 0.2 * lt);
  float a = (1.0 - smoothstep(0.4, 1.0, lt)) * smoothstep(0.0, 0.04, age) * col.a;
  vCol = vec4(c, a);
}`;

  const FS_DUST = `#version 300 es
precision mediump float;
in vec4 vCol;
in float vSize;
out vec4 o;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float round = 1.0 - smoothstep(0.32, 0.5, d);
  float a = vCol.a * mix(1.0, round, clamp((vSize - 2.0) / 3.0, 0.0, 1.0));
  if (a < 0.01) discard;
  o = vec4(vCol.rgb, a);
}`;

  // ---------------------------------------------------------------- GPU renderer
  class Engine {
    constructor(canvas) {
      this.canvas = canvas || new OffscreenCanvas(2, 2);
      this.gl = null;
      this.failed = false;
      this.w = 0; this.h = 0;
      this.maskVersion = -1;
      this.lastPlate = 0;
      this.plateLearned = 0;
      this.black = null;
      engines.add(this);
      reportState();
    }

    destroy() {
      if (!engines.has(this)) return;
      engines.delete(this);
      reportState();
      if (this.gl && !this.failed) { try { this.savePlate(); } catch {} }
      const gl = this.gl;
      if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
      this.gl = null;
    }

    init() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl;
      this.canvas.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); this.failed = true; });
      const mk = (vs, fs) => {
        const p = gl.createProgram();
        for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
          const s = gl.createShader(type);
          gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
          gl.attachShader(p, s);
        }
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
        return { p, u };
      };
      this.pBase = mk(VS_FULL, FS_BASE);
      this.pCap = mk(VS_FULL, FS_CAPTURE);
      this.pPlate = mk(VS_FULL, FS_PLATE);
      this.pDust = mk(VS_DUST, FS_DUST);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      this.live = this.tex(gl.LINEAR);
      this.maskTex = this.tex(gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      this.fbo = gl.createFramebuffer();
      this.plateW = 320; this.plateH = 180;
      this.plate = [this.plateTex(), this.plateTex()];
      if (plateStore.data) {
        gl.bindTexture(gl.TEXTURE_2D, this.plate[0]);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.plateW, this.plateH, gl.RGBA, gl.UNSIGNED_BYTE, plateStore.data);
        gl.generateMipmap(gl.TEXTURE_2D);
        this.plateLearned = plateStore.learned;
      }
    }

    tex(filter) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    plateTex() {
      const gl = this.gl;
      const t = this.tex(gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texStorage2D(gl.TEXTURE_2D, 9, gl.RGBA8, this.plateW, this.plateH);
      return t;
    }

    resize(w, h) {
      const gl = this.gl;
      this.w = w; this.h = h;
      this.canvas.width = w; this.canvas.height = h;
      // One dust grain per cell; ~60–110k grains depending on resolution.
      this.cell = w >= 1600 ? 4 : w >= 1000 ? 3 : 2;
      this.gw = Math.ceil(w / this.cell); this.gh = Math.ceil(h / this.cell);
      if (this.cap) this.cap.forEach((t) => gl.deleteTexture(t));
      this.cap = [0, 1].map(() => {
        const t = this.tex(gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.gw, this.gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        return t;
      });
    }

    ensure(w, h) {
      if (this.failed) return false;
      try {
        if (!this.gl) this.init();
        if (w !== this.w || h !== this.h) this.resize(w, h);
        return true;
      } catch (err) {
        console.warn(TAG, 'renderer unavailable, passing video through:', err);
        this.failed = true;
        return false;
      }
    }

    common(prog, t) {
      const gl = this.gl, u = prog.u;
      gl.useProgram(prog.p);
      gl.uniform2f(u.uRes, this.w, this.h);
      gl.uniform4fv(u.uBox, anim.box);
      gl.uniform1f(u.uSweep, FX.sweep);
      gl.uniform1f(u.uNoise, FX.noise);
      gl.uniform1f(u.uSeed, anim.seed);
      const useMask = (anim.person || prog === this.pPlate) && !!mask.data;
      gl.uniform1f(u.uHasMask, useMask ? 1 : 0);
      gl.uniform2f(u.uMaskTexel, 1 / Math.max(mask.w, 1), 1 / Math.max(mask.h, 1));
      if (u.uT) gl.uniform1f(u.uT, t);
      this.bind(prog, 'uMask', 1, this.maskTex);
      this.bind(prog, 'uLive', 0, this.live);
    }

    bind(prog, name, unit, tex) {
      const loc = prog.u[name];
      if (!loc) return;
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    }

    upload(src) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.live);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      if (mask.data && mask.version !== this.maskVersion) {
        this.maskVersion = mask.version;
        gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.w, mask.h, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
      }
    }

    target(tex, w, h) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
    }

    updatePlate(t) {
      if (!mask.data || mask.version === this.plateMaskVersion) return;
      this.plateMaskVersion = mask.version;
      const gl = this.gl, p = this.pPlate;
      const [src, dst] = this.plate;
      gl.disable(gl.BLEND);
      this.target(dst, this.plateW, this.plateH);
      this.common(p, t);
      this.bind(p, 'uPrev', 2, src);
      gl.uniform2f(p.u.uPlateRes, this.plateW, this.plateH);
      gl.uniform1f(p.u.uRate, this.plateLearned < 3 ? 1.0 : 0.18);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const now = performance.now();
      if (now - (this.lastSave || 0) > 2500) { this.lastSave = now; this.readPlate(); }
      gl.bindTexture(gl.TEXTURE_2D, dst);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.plate = [dst, src];
      this.plateLearned++;
    }

    // Reads level 0 of the plate currently bound to the framebuffer into plateStore.
    readPlate() {
      const gl = this.gl;
      const buf = plateStore.data && plateStore.data.length === this.plateW * this.plateH * 4
        ? plateStore.data : new Uint8Array(this.plateW * this.plateH * 4);
      gl.readPixels(0, 0, this.plateW, this.plateH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      plateStore.data = buf;
      plateStore.learned = this.plateLearned + 1;
      // How much of the empty room has been seen (alpha = confidence).
      let seen = 0, n = 0;
      for (let i = 3; i < buf.length; i += 16) { n++; if (buf[i] > 200) seen++; }
      const cov = seen / n;
      if (Math.abs(cov - plateStore.coverage) > 0.02) { plateStore.coverage = cov; reportState(); }
    }

    savePlate() {
      if (this.plateLearned < 2) return;
      this.target(this.plate[0], this.plateW, this.plateH);
      this.readPlate();
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    draw(src, t, dir, withEffect) {
      const gl = this.gl;
      this.upload(src);
      if (settings.mode === 'person') this.updatePlate(t);
      gl.disable(gl.BLEND);
      if (withEffect) {
        // First frame of a new cycle: snapshot every grain's colour from the live frame.
        if (this.cycle !== anim.cycle) { this.cycle = anim.cycle; dir = -1; }
        const [prev, next] = this.cap;
        this.target(next, this.gw, this.gh);
        this.common(this.pCap, t);
        this.bind(this.pCap, 'uPrev', 2, prev);
        gl.uniform2f(this.pCap.u.uGrid, this.gw, this.gh);
        gl.uniform1f(this.pCap.u.uDir, dir);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.cap = [next, prev];
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.w, this.h);
      const b = this.pBase;
      this.common(b, withEffect ? t : -1);
      this.bind(b, 'uPlate', 2, this.plate[0]);
      gl.uniform1f(b.u.uPlateOK, this.plateLearned >= 2 ? 1 : 0);
      gl.uniform1f(b.u.uPersonMode, anim.person ? 1 : 0);
      gl.uniform3f(b.u.uBehind, 0.02, 0.02, 0.025);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (withEffect && t > 0 && t < T_MAX) {
        const d = this.pDust;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.common(d, t);
        this.bind(d, 'uCap', 2, this.cap[0]);
        gl.uniform2f(d.u.uGrid, this.gw, this.gh);
        gl.uniform1f(d.u.uLife, FX.life);
        gl.uniform1f(d.u.uCell, this.cell);
        gl.uniform2f(d.u.uWind, FX.windX, FX.windY);
        gl.drawArrays(gl.POINTS, 0, this.gw * this.gh);
        gl.disable(gl.BLEND);
      }
    }

    // Plain black frame, used only if the GPU path is unavailable while you are dust.
    blackFrame(frame) {
      if (!this.black || this.black.width !== frame.displayWidth) {
        this.black = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
        const c = this.black.getContext('2d');
        c.fillStyle = '#050506'; c.fillRect(0, 0, this.black.width, this.black.height);
      }
      return new VideoFrame(this.black, { timestamp: frame.timestamp, alpha: 'discard' });
    }

    // Breakout-box path: VideoFrame in → VideoFrame out.
    process(frame) {
      const w = frame.displayWidth, h = frame.displayHeight;
      const now = performance.now();
      maybeSendFrame(frame, w, h);
      settle(now);
      const t = animT(now);
      const active = phase !== 'visible';
      if (!active) {
        // Keep learning the background while you're visible, at a gentle pace.
        if (settings.enabled && settings.mode === 'person' && mask.data && now - this.lastPlate > 150 && this.ensure(w, h)) {
          this.lastPlate = now;
          this.upload(frame);
          this.updatePlate(0);
        }
        return frame;
      }
      if (!this.ensure(w, h)) return this.blackFrame(frame);
      this.draw(frame, t, anim.dir === 0 ? (phase === 'vanished' ? 1 : -1) : anim.dir, true);
      return new VideoFrame(this.canvas, { timestamp: frame.timestamp, alpha: 'discard' });
    }

    // Canvas fallback path: draw every frame into a DOM canvas that is being captured.
    render(video) {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      const now = performance.now();
      maybeSendFrame(video, w, h);
      settle(now);
      if (!this.ensure(w, h)) return;
      const active = phase !== 'visible';
      if (!active && settings.mode === 'person' && now - this.lastPlate > 150) { this.lastPlate = now; }
      this.draw(video, animT(now), anim.dir === 0 ? 1 : anim.dir, active);
    }
  }

  // ---------------------------------------------------------------- track plumbing
  // Make the processed track look and behave like the camera track it replaces.
  function dressTrack(out, src, onAllStopped) {
    const shared = dressTrack.counts.get(src) || { n: 0 };
    shared.n++;
    dressTrack.counts.set(src, shared);
    const nativeStop = out.stop.bind(out);
    const nativeClone = out.clone.bind(out);
    let stopped = false;
    out.stop = function () {
      if (!stopped) {
        stopped = true;
        if (--shared.n <= 0) { try { src.stop(); } catch {} onAllStopped(); }
      }
      return nativeStop();
    };
    out.clone = function () { return dressTrack(nativeClone(), src, onAllStopped); };
    out.getSettings = function () { return src.getSettings(); };
    out.getCapabilities = function () { return src.getCapabilities ? src.getCapabilities() : {}; };
    out.getConstraints = function () { return src.getConstraints(); };
    out.applyConstraints = function (c) { return src.applyConstraints(c); };
    try { Object.defineProperty(out, 'label', { get: () => src.label, configurable: true }); } catch {}
    // If Meet disables the track instead of stopping it, release the real camera too.
    const en = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
    try {
      Object.defineProperty(out, 'enabled', {
        configurable: true,
        get() { return en.get.call(out); },
        set(v) { en.set.call(out, v); src.enabled = v; },
      });
    } catch {}
    src.addEventListener('ended', () => {
      if (stopped) return;
      stopped = true;
      try { nativeStop(); } catch {}
      onAllStopped();
      out.dispatchEvent(new Event('ended'));
    });
    return out;
  }
  dressTrack.counts = new WeakMap();

  function wrapWithBreakoutBox(stream, vt) {
    const processor = new MediaStreamTrackProcessor({ track: vt });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const engine = new Engine();
    processor.readable
      .pipeThrough(new TransformStream({
        transform(frame, controller) {
          let out = frame;
          try { out = engine.process(frame); } catch (err) {
            console.warn(TAG, err);
            engine.failed = true;
            out = frame;
          }
          if (out !== frame) frame.close();
          controller.enqueue(out);
        },
      }))
      .pipeTo(generator.writable)
      .catch(() => {})
      .finally(() => engine.destroy());
    dressTrack(generator, vt, () => engine.destroy());
    return new MediaStream([generator, ...stream.getAudioTracks()]);
  }

  function wrapWithCanvas(stream, vt) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true;
    video.srcObject = new MediaStream([vt]);
    video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const s = vt.getSettings();
    canvas.width = s.width || 1280; canvas.height = s.height || 720;
    const engine = new Engine(canvas);
    let alive = true;
    const loop = () => {
      if (!alive) return;
      try { engine.render(video); } catch (err) { console.warn(TAG, err); }
      video.requestVideoFrameCallback(loop);
    };
    video.requestVideoFrameCallback(loop);
    const out = canvas.captureStream(s.frameRate || 30).getVideoTracks()[0];
    dressTrack(out, vt, () => { alive = false; engine.destroy(); video.srcObject = null; });
    return new MediaStream([out, ...stream.getAudioTracks()]);
  }

  function wrapStream(stream) {
    const vt = stream.getVideoTracks()[0];
    if (!vt) return stream;
    try {
      if (typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function') {
        return wrapWithBreakoutBox(stream, vt);
      }
      return wrapWithCanvas(stream, vt);
    } catch (err) {
      console.warn(TAG, 'could not hook camera, leaving it untouched:', err);
      return stream;
    }
  }

  const proto = MediaDevices.prototype;
  const nativeGUM = proto.getUserMedia;
  proto.getUserMedia = function getUserMedia(constraints) {
    return nativeGUM.call(this, constraints).then((stream) => (constraints && constraints.video ? wrapStream(stream) : stream));
  };
})();
