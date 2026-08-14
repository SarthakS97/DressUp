# DressUp — Chrome Extension (Part 1: Virtual Try-On)

## Load it in Chrome
1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, select this `tryon-extension` folder
4. Pin the DressUp icon to your toolbar

## Try it right now (mock mode — no API key needed yet)
The extension currently runs in **mock mode**: instead of calling the real
YouCam Apparel VTO endpoint, it fakes a ~2 second "processing" delay and
hands back the reference garment image itself as the "result." This lets you
test the entire flow — popup, photo upload, context menu, new tab, loading
animation, storage, history — before the real API is wired in.

1. Click the extension icon → upload a full-body photo under **your fit**
2. Go to any site with images (Pinterest, a shopping site, anywhere)
3. Right-click an image → **Try it on** → a new tab opens and "processes"
4. Or: open the extension → **try it on** tab → paste an image URL → **try now**

## Now wired to the real AI Clothes v4 API
`background.js` follows the actual documented flow:
1. `POST /s2s/v2.0/file` — registers the user's photo, gets back a `file_id`
   and a signed S3 upload URL
2. `PUT` the photo bytes to that S3 URL
3. `POST /s2s/v2.0/task/cloth-v4` — `{ src_file_id, ref_file_url, garment_category }` → `task_id`
4. `GET /s2s/v2.0/task/cloth-v4/{task_id}` — polled every 2s until `task_status` is `success`/`error`
5. `data.results.url` is the finished image

**To go live:** open `background.js`, set `CONFIG.API_KEY` to your real key.
Mock mode turns off automatically once it's not the placeholder string.

**One spec contradiction worth knowing about:** the docs' step-by-step guide
says to upload "a high-resolution full-body photo," but the File Specs table
for the same target-user-image field says the photo should show only
"the upper body... from the chest upwards" with shoulders visible. These two
instructions conflict. I haven't tested which one the engine actually wants —
worth doing one real test upload of a true full-body shot and one chest-up
shot before you commit to guiding users toward either in your onboarding copy.

**`garment_category`** defaults to `'auto'` in `CONFIG` — the docs say v4
lets the engine auto-detect the garment type, which is the safest default
for "try on literally anything I right-click." Change it if you want to force
a specific category (`full_body`, `upper_body`, `lower_body`, `shoes`,
`outerwear`).

**Re-upload happens on every try-on**, not just once — since the S3 upload
URLs elsewhere in these docs carry a `ttl30` (30-minute) path segment, a
cached `file_id` from an earlier session may not still be valid. Re-uploading
the stored user photo each time trades a bit of extra latency for not having
to guess at an expiry window.

## Pasting an image directly (not just a link)
The "try it on" tab now accepts three ways to supply the outfit:
1. Paste a link (text) into the field
2. **Paste an actual image** — copy any image (screenshot, "copy image" from
   a site, etc.) and hit ⌘V/Ctrl+V anywhere in the try-on tab, or click the
   ⎘ button to read an image straight off the clipboard
3. Right-click any image on the web → "Try it on"

A pasted image has no public URL, so it can't use the cheap `ref_file_url`
path the way a right-clicked image can — it goes through the same 3-step
File Upload API as the user's own photo instead, then gets sent as
`ref_file_id`. `background.js` branches on this automatically depending on
whether `ref.kind` is `'url'` or `'dataUrl'` — nothing to configure.

## Storage note
You asked for localStorage — worth knowing why this uses `chrome.storage.local`
instead: MV3 background service workers have no DOM at all (no `window`, no
`localStorage`), so plain localStorage can't be shared between the popup,
the background worker, and the result tab. `chrome.storage.local` is the
extension-native equivalent that actually works across all three contexts,
with a bigger quota. Everything is still 100% local to the browser — nothing
leaves the machine except the direct calls to YouCam's API.

## Image compression
`lib/imageUtils.js` resizes every stored image (user photo, reference
garment, result) down to a max 900px edge and re-encodes as JPEG at ~72%
quality before saving — keeps history entries small so you can rack up a lot
of try-ons before hitting storage limits. Check the live footer in the popup
("__ kb stored") to watch usage as you test.

## File map
- `manifest.json` — MV3 config
- `popup.html/css/js` — the toolbar popup (your fit + try it on tabs)
- `background.js` — context menu, message handling, the actual API pipeline
- `result.html/css/js` — the tab that opens per try-on, doubles as the history grid
- `lib/imageUtils.js` — shared compression + chrome.storage.local helpers
- `icons/` — placeholder icons (swap for real branding whenever)

## Part 2: Color Analysis (skin tone vs. garment)
Once a try-on result is ready, a **"run color analysis"** button appears
next to it (only after the VTO output comes back — never before). Clicking it:

1. Runs on-device face detection (bundled TinyFaceDetector model,
   `lib/face-api.min.js` + `lib/models/` — no network call, no server) on
   the try-on **result** image itself, not the original upload
2. Pads the detected face box out to a proper headshot-style crop
3. Samples the region just below that crop for the garment's dominant color
   (pure canvas pixel math in `lib/colorAnalysis.js` — no AI involved)
4. Sends the face crop to YouCam's Fitzpatrick Skin Type endpoint
5. Maps the returned type (I-VI) to a reference swatch and runs a WCAG
   contrast + hue check against the garment color, shown as a plain verdict

**Two things worth flagging honestly, called out in the UI itself too:**
- The skin "swatch" is a standard reference color for that Fitzpatrick type,
  not a measured color — Fitzpatrick is a melanin/burn-tan category, not an
  RGB value. It's there to visualize the result, not to claim precision.
- The hue comparison is a softer, approximate signal for the same reason —
  Fitzpatrick measures depth, not undertone (warm/cool), so "similar hue"
  is a rough proxy, not a confident undertone-clash claim. Contrast is the
  solid part — it's the standard WCAG formula.

**Response shape unconfirmed:** the Fitzpatrick docs describe the task flow
but don't show a sample success response body, unlike the other endpoints.
`parseFitzpatrickResult()` in `background.js` tries several plausible field
paths and logs the full raw response to the console on first success —
check that log on your first real (non-mock) run and trim the fallback
logic down to whichever path actually matched.

Mock mode covers this too: with the placeholder API key still in place, the
button returns a random Fitzpatrick type after a short fake delay, so the
whole face-crop → garment-sample → verdict UI is testable right now.
