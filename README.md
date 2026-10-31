# Ryan's Reel Kit

A personal photo and video editor that works offline on the phone. It does layered photo edits and a 9:16 video timeline with captions in one app.

## Run it locally
```
cd /workspace/usefulbotmaker/templates/subscription-replacer/test-apps/ryans-reel-kit
python3 -m http.server 8080
```
Then open http://localhost:8080 in Chrome. Use DevTools device mode at about 412×915 to see the phone layout. The page reloads itself once on the first visit, to turn on multi-threaded captions.
For offline captions and cut-outs, open Settings (⚙︎) and tap **Download caption + cutout packs for offline**.

## When hosting
Publish everything in this folder **except** NOTES.md (private notes). LICENSES.md and the license files must ship.
The folder is about 189 MB, mostly the two Whisper models (44 MB and 78 MB), which are only downloaded on demand.
Bump `CACHE` in sw.js on every release.
