// Synthetic-hand tests for the snap state machine.
import { SnapDetector, handFeatures, PRESETS } from '../snap.js';
import assert from 'node:assert/strict';

// --- tiny forward-kinematics hand (metres). Palm faces +z, fingers point -y.
function finger(base, len, angles) {
  // angles: flexion at MCP, PIP, DIP (radians), rotating from -y toward +z
  const pts = [];
  let p = { ...base };
  let a = 0;
  for (let i = 0; i < 3; i++) {
    a += angles[i];
    p = { x: p.x, y: p.y - Math.cos(a) * len[i], z: p.z + Math.sin(a) * len[i] };
    pts.push(p);
  }
  return pts; // PIP, DIP, TIP
}
function hand({ index, middle, ring, pinky, thumbTip }) {
  const w = [];
  w[0] = { x: 0, y: 0, z: 0 };
  const mcp = {
    index: { x: 0.025, y: -0.088, z: 0 },
    middle: { x: 0.0, y: -0.092, z: 0 },
    ring: { x: -0.021, y: -0.088, z: 0 },
    pinky: { x: -0.040, y: -0.078, z: 0 },
  };
  const L = { index: [0.042, 0.025, 0.020], middle: [0.046, 0.028, 0.022], ring: [0.043, 0.027, 0.021], pinky: [0.033, 0.019, 0.018] };
  w[1] = { x: 0.030, y: -0.025, z: 0.010 };
  w[2] = { x: 0.050, y: -0.045, z: 0.020 };
  w[3] = { x: (w[2].x + thumbTip.x) / 2 + 0.005, y: (w[2].y + thumbTip.y) / 2, z: (w[2].z + thumbTip.z) / 2 };
  w[4] = thumbTip;
  const put = (name, i0, ang) => { w[i0] = mcp[name]; finger(mcp[name], L[name], ang).forEach((p, k) => (w[i0 + 1 + k] = p)); };
  put('index', 5, index); put('middle', 9, middle); put('ring', 13, ring); put('pinky', 17, pinky);
  return w;
}
const deg = (d) => (d * Math.PI) / 180;
const curled = [deg(80), deg(95), deg(60)];

const OPEN = () => hand({ index: [0, 0, 0], middle: [0, 0, 0], ring: [0, 0, 0], pinky: [0, 0, 0], thumbTip: { x: 0.085, y: -0.07, z: 0.01 } });
function SET() {
  const middle = [deg(40), deg(40), deg(15)];
  const h = hand({ index: [deg(25), deg(20), deg(10)], middle, ring: curled, pinky: curled, thumbTip: { x: 0, y: 0, z: 0 } });
  const tip = h[12];
  h[4] = { x: tip.x + 0.008, y: tip.y + 0.004, z: tip.z + 0.006 }; // thumb pad against middle tip
  return hand({ index: [deg(25), deg(20), deg(10)], middle, ring: curled, pinky: curled, thumbTip: h[4] });
}
function POST() {
  const h = hand({ index: [deg(30), deg(25), deg(10)], middle: [deg(85), deg(100), deg(50)], ring: curled, pinky: curled, thumbTip: { x: 0, y: 0, z: 0 } });
  const ipip = h[6];
  return hand({ index: [deg(30), deg(25), deg(10)], middle: [deg(85), deg(100), deg(50)], ring: curled, pinky: curled, thumbTip: { x: ipip.x + 0.012, y: ipip.y + 0.004, z: ipip.z + 0.012 } });
}
const FIST = () => hand({ index: curled, middle: curled, ring: curled, pinky: curled, thumbTip: { x: 0.01, y: -0.075, z: 0.05 } });

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (w, amt) => w.map((p) => ({ x: p.x + (rnd() - 0.5) * 2 * amt, y: p.y + (rnd() - 0.5) * 2 * amt, z: p.z + (rnd() - 0.5) * 2 * amt }));

function run(seq, sens = 'normal', noise = 0) {
  const d = new SnapDetector(sens);
  let t = 1000;
  const fires = [];
  for (const [pose, ms] of seq) {
    const r = d.update(pose ? [{ key: 'Right', world: jitter(pose(), noise) }] : [], t);
    if (r.fired) fires.push(t);
    t += ms;
  }
  return fires;
}
const rep = (pose, n, ms = 66) => Array.from({ length: n }, () => [pose, ms]);

// Feature sanity
for (const [n, f] of [['open', OPEN], ['set', SET], ['post', POST], ['fist', FIST]]) {
  const x = handFeatures(f());
  console.log(n.padEnd(5), 'pinch', x.pinch.toFixed(2), 'ext', x.ext.toFixed(2));
}

const cases = [];
const check = (name, ok) => { cases.push([name, ok]); };

for (const sens of Object.keys(PRESETS)) {
  for (const noise of [0, 0.004, 0.007]) {
    const tag = `${sens} noise=${noise * 1000}mm`;
    check(`snap fires (${tag})`, run([...rep(OPEN, 5), ...rep(SET, 4), ...rep(POST, 3)], sens, noise).length === 1);
    check(`snap with a lost frame fires (${tag})`, run([...rep(OPEN, 3), ...rep(SET, 4), [null, 66], ...rep(POST, 3)], sens, noise).length === 1);
    check(`slow open does not fire (${tag})`, run([...rep(OPEN, 3), ...rep(SET, 6), ...rep(OPEN, 6)], sens, noise).length === 0);
    check(`fist from open does not fire (${tag})`, run([...rep(OPEN, 5), ...rep(FIST, 6), ...rep(OPEN, 5)], sens, noise).length === 0);
    check(`late POST does not fire (${tag})`, run([...rep(SET, 4), ...rep(null, 10), ...rep(POST, 3)], sens, noise).length === 0);
    check(`two snaps fire twice (${tag})`, run([...rep(SET, 4), ...rep(POST, 3), ...rep(OPEN, 10), ...rep(SET, 4), ...rep(POST, 3)], sens, noise).length === 2);
  }
}
// A one-frame SET (flicker) should not arm on strict
check('strict ignores single-frame SET flicker', run([...rep(OPEN, 3), [SET, 66], ...rep(POST, 3)], 'strict').length === 0);

let failed = 0;
for (const [name, ok] of cases) { if (!ok) { failed++; console.log('FAIL', name); } }
console.log(`${cases.length - failed}/${cases.length} passed`);
assert.equal(failed, 0);
