// Snap gesture recognizer over MediaPipe hand *world* landmarks (metres, rotation-invariant).
//
// A finger snap has two poses separated by a very fast transition:
//   SET  — thumb tip pressed against the middle fingertip, middle finger half-extended.
//   POST — middle finger has slipped off the thumb and curled down into the palm.
// We arm when the SET pose is seen, and fire if the POST pose follows within a short
// window. Opening the hand slowly (middle finger extends) or making a fist from a relaxed
// hand (no SET pose first) does not fire.
//
// Landmark indices: 0 wrist, 4 thumb tip, 8 index tip, 9 middle MCP, 12 middle tip.

export const PRESETS = {
  // pinch: max thumb–middle gap in SET (× palm length)
  // apart: min thumb–middle gap in POST
  // extSet: min middle-tip→wrist distance in SET (finger not curled yet)
  // curl:  max middle-tip→wrist distance in POST (finger curled into palm)
  // drop:  min decrease of middle-tip→wrist between SET and POST
  // armMs: how long SET must be held; windowMs: max time from last SET frame to POST
  strict: { pinch: 0.32, apart: 0.50, extSet: 1.12, curl: 0.98, drop: 0.24, armMs: 110, windowMs: 340 },
  normal: { pinch: 0.40, apart: 0.42, extSet: 1.05, curl: 1.05, drop: 0.16, armMs: 50, windowMs: 440 },
  easy:   { pinch: 0.48, apart: 0.36, extSet: 0.98, curl: 1.12, drop: 0.10, armMs: 0, windowMs: 560 },
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

export function handFeatures(w) {
  const palm = Math.max(dist(w[0], w[9]), 1e-4);
  return {
    pinch: dist(w[4], w[12]) / palm, // thumb tip ↔ middle tip
    ext: dist(w[12], w[0]) / palm,   // middle tip ↔ wrist
  };
}

export class SnapDetector {
  constructor(sensitivity = 'normal') {
    this.setSensitivity(sensitivity);
    this.hands = new Map();
  }

  setSensitivity(name) {
    this.p = PRESETS[name] || PRESETS.normal;
  }

  reset() {
    this.hands.clear();
  }

  /**
   * @param {{key: string, world: {x:number,y:number,z:number}[]}[]} hands
   * @param {number} t  timestamp in ms
   * @returns {{fired: boolean, info: object[]}}
   */
  update(hands, t) {
    const p = this.p;
    let fired = false;
    const info = [];

    for (const h of hands) {
      if (!h.world || h.world.length < 21) continue;
      const f = handFeatures(h.world);
      let st = this.hands.get(h.key);
      if (!st) {
        st = { setSince: null, lastSetT: -Infinity, setExt: 0, armed: false, seenT: t };
        this.hands.set(h.key, st);
      }
      st.seenT = t;

      const isSet = f.pinch < p.pinch && f.ext > p.extSet;
      if (isSet) {
        if (st.setSince === null) st.setSince = t;
        st.lastSetT = t;
        st.setExt = f.ext;
        if (t - st.setSince >= p.armMs) st.armed = true;
      } else {
        st.setSince = null; // the SET hold must be continuous to arm
        const inWindow = t - st.lastSetT <= p.windowMs;
        const isPost = f.pinch > p.apart && f.ext < p.curl && st.setExt - f.ext >= p.drop;
        if (st.armed && inWindow && isPost) {
          fired = true;
          st.armed = false;
          st.lastSetT = -Infinity;
        } else if (!inWindow) {
          st.armed = false;
        }
      }
      info.push({ key: h.key, ...f, set: isSet, armed: st.armed });
    }

    for (const [k, st] of this.hands) {
      if (t - st.seenT > 1200) this.hands.delete(k);
    }
    return { fired, info };
  }
}
