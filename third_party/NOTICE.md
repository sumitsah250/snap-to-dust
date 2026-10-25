# Third-party components

Snap to Dust bundles the following, unmodified, under the Apache License 2.0
(full text in `APACHE-2.0.txt`):

| Path | Component | Copyright |
|---|---|---|
| `lib/vision_bundle.mjs`, `wasm/vision_wasm_internal.*` | MediaPipe Tasks Vision 1.1.1 (`@mediapipe/tasks-vision`) | Google LLC |
| `models/hand_landmarker.task` | MediaPipe Hand Landmarker model (float16, v1) | Google LLC |
| `models/selfie_segmenter_landscape.tflite` | MediaPipe Selfie Segmenter (landscape) model | Google LLC |

MediaPipe includes an optional usage-statistics logger. This extension's content security
policy (`connect-src 'self'`) blocks all outbound network requests from its pages, so no
usage data or camera data ever leaves your computer.
