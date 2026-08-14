# DressUp — Chrome Extension

Right-click any outfit photo anywhere on the web, collect five into a **lookbook**, and see real AI virtual try-ons for all five — automatically ranked by how well each one's colors actually suit your skin tone. Built on YouCam's **AI Clothes Virtual Try-On (v4)** and **AI Fitzpatrick Skin Type Analysis** APIs.

---

## 1. Clone the repo

```bash
git clone https://github.com/<your-username>/DressUp.git
cd DressUp
```

---

## 2. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** — toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `DressUp` folder you cloned (the one containing `manifest.json`)
5. The DressUp icon (a lime "D" on a dark square) should now appear in your toolbar — pin it for easy access via the puzzle-piece icon if it's hidden

If you edit any file after loading, go back to `chrome://extensions` and click the refresh icon on the DressUp card to pick up your changes.

---

## 3. Using DressUp

### Step 1 — Upload your photo
Click the DressUp icon → **your fit** tab → click the polaroid → choose a clear, front-facing, full-body photo. This gets reused for every try-on and every lookbook — you only do this once.

### Step 2 — Build a lookbook
1. Click the **lookbooks** tab → type a name → **+ create**
2. Browse the web (Pinterest, any store site, anywhere with outfit photos)
3. Right-click any outfit image → **Add to DressUp lookbook** → pick your lookbook
4. Repeat until the lookbook has 5 images — you can only add up to 5 per lookbook

*(If no lookbook exists yet, right-clicking will show a disabled menu item reminding you to create one in the popup first.)*

### Step 3 — Run the analysis
Open the lookbook (click it in the **lookbooks** tab) → once it's at 5/5, click **✦ start analysis ✦**. This opens a new tab and:
1. Runs real virtual try-on (YouCam Clothes API) for all 5 images against your photo
2. Reads your skin tone once (YouCam Fitzpatrick API)
3. Automatically detects the garment color in each result and scores it against your skin tone
4. Sorts the results best-match-first

Click any finished result to open it full-size, alongside the original inspiration image and the color verdict. Closed the tab? Reopen it anytime with the **view results** button in the lookbook's detail view.

### Bonus — single quick try-on
Inside a lookbook, click any individual image (not the ✕) to instantly try on just that one look in its own tab, without running the full 5-image analysis.

---

## 4. File structure

```
DressUp/
├── manifest.json          # MV3 config
├── popup.html/css/js      # toolbar popup — photo upload + lookbook management
├── background.js          # service worker — all YouCam API calls (VTO, File Upload, Fitzpatrick)
├── lookbook.html/css/js   # the tab that runs the 5-image analysis + shows sorted results
├── result.html/css/js     # single-image try-on result tab
├── lib/
│   ├── imageUtils.js      # compression + chrome.storage.local helpers
│   ├── colorAnalysis.js   # contrast/hue math, Fitzpatrick swatch lookup
│   ├── face-api.min.js    # bundled face detection (local, no network call)
│   └── models/            # face-api model weights
└── icons/
```

---

## 5. Notes

- Everything runs **locally in the browser** — photos, lookbooks, and results are stored in `chrome.storage.local`. Nothing goes to a server except the direct calls to YouCam's API.
- Face detection runs fully on-device via a bundled TinyFaceDetector model — no external network call for that part.