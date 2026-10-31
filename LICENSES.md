# Ryan's Reel Kit — licenses

Personal-use app. Every part below ships inside this folder; nothing is loaded from a CDN or another site.
No GPL or AGPL parts. Licenses checked on 2026-10-30 against each project's own LICENSE file or model/data page.
The in-app list is Settings → Credits (`js/credits.js`); keep the two in sync.

| Part | Version | License | Source | Notice shipped in app |
|---|---|---|---|---|
| Konva (photo editor canvas) | 10.9.0 | MIT | https://github.com/konvajs/konva | `vendor/konva.LICENSE.txt` |
| Mediabunny (MP4 read/write, WebCodecs) | 1.65.0, unmodified | MPL-2.0 | https://github.com/Vanilagy/mediabunny | `vendor/mediabunny.LICENSE.txt` (file-level copyleft: if its file is ever changed, publish that file's changes) |
| Transformers.js | 4.3.2 | Apache-2.0 | https://github.com/huggingface/transformers.js | `vendor/transformers.LICENSE.txt` |
| ONNX Runtime Web (asyncify wasm build) | 1.31.0-dev | MIT | https://github.com/microsoft/onnxruntime | `vendor/ort/onnxruntime-web.LICENSE.txt` |
| MediaPipe Tasks Vision + Selfie Segmenter model | 1.2.0 | Apache-2.0 | https://github.com/google-ai-edge/mediapipe | `vendor/mediapipe/Apache-2.0.LICENSE.txt` |
| fflate (backup .zip) | 0.8.3 | MIT | https://github.com/101arrowz/fflate | `vendor/fflate.LICENSE.txt` |
| Whisper tiny.en / base.en, timestamped ONNX | onnx-community `*_timestamped`, q8 | Apache-2.0 weights (openai/whisper-*.en model card); Whisper code MIT | https://huggingface.co/onnx-community/whisper-tiny.en_timestamped , https://huggingface.co/openai/whisper-tiny.en | `models/whisper-tiny.en_timestamped/README.md`; listed on Credits. The ONNX conversion repo has no license tag of its own; it is a format conversion of the Apache-2.0 base model |
| MODNet portrait matting (ONNX, "Fine edges") | Xenova/modnet q8 | Apache-2.0 | https://huggingface.co/Xenova/modnet | `models/modnet/README.md` |
| Fonts: Inter, Anton, Bebas Neue, Poppins, Montserrat | @fontsource (latin subsets) | OFL-1.1 | https://fontsource.org | `vendor/fonts/*.LICENSE.txt` |
| Font: Permanent Marker | @fontsource | Apache-2.0 | https://fontsource.org/fonts/permanent-marker | `vendor/fonts/permanent-marker.LICENSE.txt` |
| Music (5 tracks in `media/music/`) | — | CC0 1.0 | https://archive.org/details/Ondrosik-Free-music-catalog | Credits screen (attribution not required, given anyway) |
| Sound effects (13 in `media/sfx/`) | Kenney Interface Sounds, Impact Sounds | CC0 1.0 | https://kenney.nl/assets | `media/sfx/kenney-*.License.txt` |
| Shape stickers, app icon, caption style presets | — | Made by your bot | this folder | Labelled "Made by your bot" on Credits; `madeBy: "bot"` in `js/stickers.js` / `js/styles.js` |

Emoji stickers use the phone's own system emoji font (Noto Color Emoji on Android). No emoji font is bundled.

## CC0 note
CC0 means no attribution or permission is needed, but it also comes with no warranty: CC0 can't confirm that the uploader owned the rights.
The tracks come from the composer's own catalog page, and the sound effects come from Kenney's own site, so the risk is low.
If a platform ever flags one of these tracks, swap it for the user's own music.

## Telemetry note
The MediaPipe bundle contains code that tries to POST usage logs to `odml.pa.googleapis.com`. The app blocks this twice:
- The Content-Security-Policy `connect-src 'self' blob: data:` in index.html (verified: the browser refuses the request).
- `sw.js`, which answers any cross-origin request with an empty 204.

Tests saw zero requests leave localhost.

## Test-only material (NOT shipped in this folder)
- `jfk.wav` (public-domain 1961 speech clip, from the public whisper.cpp samples) was used only to build the caption test video, `fixtures/talk-9x16.mp4`, kept outside the app.
- Portrait of Ilan Ramon (NASA, public domain, Wikimedia Commons) was used only as the cut-out test photo.
- The test patterns (testsrc2, SMPTE bars) were generated with ffmpeg.
