const params = new URLSearchParams(location.search);
const id = params.get('id');
const errorParam = params.get('error');

const noPhotoState = document.getElementById('noPhotoState');
const singleView = document.getElementById('singleView');
const historyView = document.getElementById('historyView');

const loadingWrap = document.getElementById('loadingWrap');
const loadingText = document.getElementById('loadingText');
const resultGrid = document.getElementById('resultGrid');
const errorWrap = document.getElementById('errorWrap');
const errorText = document.getElementById('errorText');
const resultActions = document.getElementById('resultActions');
const refImg = document.getElementById('refImg');
const resultImg = document.getElementById('resultImg');
const downloadBtn = document.getElementById('downloadBtn');
const viewHistoryBtn = document.getElementById('viewHistoryBtn');

const skinSwatchCircle = document.getElementById('skinSwatchCircle');
const skinToneLabel = document.getElementById('skinToneLabel');
const garmentPickerBtn = document.getElementById('garmentPickerBtn');
const verdictInline = document.getElementById('verdictInline');
const verdictText = document.getElementById('verdictText');
const verdictNote = document.getElementById('verdictNote');

viewHistoryBtn?.addEventListener('click', showHistory);
garmentPickerBtn?.addEventListener('click', pickGarmentColor);

const historyGrid = document.getElementById('historyGrid');
const emptyHint = document.getElementById('emptyHint');

let skinToneStarted = false;

init();

async function init() {
  if (errorParam === 'no-photo') {
    show(noPhotoState);
    return;
  }
  if (id) {
    show(singleView);
    await renderSingle(id);
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'TRYON_UPDATED' && msg.id === id) renderSingle(id);
    });
    // fallback poll in case the runtime message is missed (tab was still loading, etc.)
    const pollHandle = setInterval(async () => {
      const entry = await tryonGetHistoryEntry(id);
      if (entry && entry.status !== 'pending') {
        clearInterval(pollHandle);
        renderSingle(id);
      }
    }, 2000);
    return;
  }
  showHistory();
}

async function renderSingle(entryId) {
  const entry = await tryonGetHistoryEntry(entryId);
  if (!entry) return;
  if (entry.refImage) refImg.src = entry.refImage;

  if (entry.status === 'pending') {
    loadingWrap.classList.remove('hidden');
    resultGrid.classList.add('hidden');
    errorWrap.classList.add('hidden');
    resultActions.classList.add('hidden');
    cycleLoadingText();
    return;
  }

  if (entry.status === 'error') {
    loadingWrap.classList.add('hidden');
    resultGrid.classList.add('hidden');
    errorWrap.classList.remove('hidden');
    errorText.textContent = entry.error || 'something went wrong — try again';
    resultActions.classList.add('hidden');
    return;
  }

  if (entry.status === 'done') {
    resultImg.src = entry.resultImage;
    loadingWrap.classList.add('hidden');
    errorWrap.classList.add('hidden');
    resultGrid.classList.remove('hidden');
    resultActions.classList.remove('hidden');
    downloadBtn.href = entry.resultImage;
    if (!skinToneStarted) {
      skinToneStarted = true;
      detectSkinTone(entry); // auto-run — no button, fires once as soon as the VTO result is in
    }
  }
}

let loadingMsgIdx = 0;
const loadingMsgs = ['developing your fit…', 'stitching pixels…', 'almost there…', 'the ai is judging your outfit choices…'];
let loadingTimer = null;
function cycleLoadingText() {
  if (loadingTimer) return;
  loadingTimer = setInterval(() => {
    loadingMsgIdx = (loadingMsgIdx + 1) % loadingMsgs.length;
    loadingText.textContent = loadingMsgs[loadingMsgIdx];
  }, 2200);
}

async function showHistory() {
  show(historyView);
  const history = await tryonGetHistory();
  historyGrid.innerHTML = '';
  if (history.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');
  for (const entry of history) {
    const item = document.createElement('button');
    item.className = 'grid-item';
    const thumb = entry.resultImage || entry.refImage || '';
    const statusClass = `status-${entry.status}`;
    const statusLabel = entry.status === 'done' ? 'ready' : entry.status;
    item.innerHTML = `
      <img src="${thumb}" alt="" />
      <div class="meta">
        <span>${new Date(entry.ts).toLocaleDateString()}</span>
        <span class="${statusClass}">${statusLabel}</span>
      </div>
    `;
    item.addEventListener('click', () => {
      location.href = `result.html?id=${entry.id}`;
    });
    historyGrid.appendChild(item);
  }
}

function show(section) {
  [noPhotoState, singleView, historyView].forEach((s) => s.style.display = 'none');
  section.style.display = 'flex';
}

/* ==================== color analysis (face crop + Fitzpatrick) ==================== */

// NOTE: face-api's loadFromUri has a bug where it mangles any URL scheme
// other than http(s) — passing our own chrome.runtime.getURL() absolute
// path made it double up the extension id. A plain relative path sidesteps
// their broken URL-joining code entirely and resolves correctly against
// this page's own location instead.
const FACE_MODEL_URL = 'lib/models';
let modelsLoaded = false;
let currentSkinRgb = null;    // set once Fitzpatrick resolves; null means "not ready yet"
let currentGarmentRgb = null; // set once the user picks a color with the eyedropper

async function ensureModelsLoaded() {
  if (modelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
  modelsLoaded = true;
}

/** Runs each time a try-on result is viewed — detects the face on this VTO image, crops it, and asks YouCam for the Fitzpatrick type fresh every time. No caching. */
async function detectSkinTone(entry) {
  currentSkinRgb = null;
  currentGarmentRgb = null;
  garmentPickerBtn.classList.remove('has-color');
  garmentPickerBtn.style.background = '';
  skinSwatchCircle.className = 'swatch-circle is-loading';
  skinToneLabel.textContent = 'reading…';
  verdictInline.classList.add('hidden');

  try {
    if (!resultImg.complete) {
      await new Promise((resolve) => { resultImg.onload = resolve; });
    }
    await ensureModelsLoaded();

    const detection = await faceapi.detectSingleFace(resultImg, new faceapi.TinyFaceDetectorOptions());
    if (!detection) throw new Error('couldn\u2019t find a face in this photo');

    const naturalW = resultImg.naturalWidth;
    const naturalH = resultImg.naturalHeight;
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = naturalW;
    fullCanvas.height = naturalH;
    fullCanvas.getContext('2d').drawImage(resultImg, 0, 0, naturalW, naturalH);

    const box = detection.box;
    const padX = box.width * 0.45;
    const padTop = box.height * 0.35;
    const padBottom = box.height * 0.55;
    const faceX = Math.max(0, box.x - padX);
    const faceY = Math.max(0, box.y - padTop);
    const faceW = Math.min(naturalW - faceX, box.width + padX * 2);
    const faceH = Math.min(naturalH - faceY, box.height + padTop + padBottom);

    const faceCanvas = document.createElement('canvas');
    faceCanvas.width = faceW;
    faceCanvas.height = faceH;
    faceCanvas.getContext('2d').drawImage(fullCanvas, faceX, faceY, faceW, faceH, 0, 0, faceW, faceH);
    const faceCropDataUrl = faceCanvas.toDataURL('image/jpeg', 0.85);

    const response = await chrome.runtime.sendMessage({ type: 'RUN_FITZPATRICK', faceCropDataUrl });
    if (!response || !response.ok) throw new Error(response?.error || 'skin tone read failed');

    applySkinSwatch(response.result);
  } catch (err) {
    skinSwatchCircle.className = 'swatch-circle is-error';
    skinSwatchCircle.style.background = '';
    skinSwatchCircle.title = (err && err.message) || '';
    skinToneLabel.textContent = 'couldn\u2019t read';
  }
}

function applySkinSwatch(rawType) {
  const swatch = getFitzpatrickSwatch(rawType);
  if (!swatch) throw new Error(`unrecognized skin type: ${rawType}`);
  currentSkinRgb = hexToRgb(swatch.hex);
  skinSwatchCircle.className = 'swatch-circle';
  skinSwatchCircle.style.background = swatch.hex;
  skinToneLabel.textContent = swatch.label.toLowerCase();
  updateVerdict();
}

/** Opens the native browser eyedropper so the person can click the actual shirt in the photo. */
async function pickGarmentColor() {
  if (!window.EyeDropper) {
    alert('Eyedropper isn\u2019t supported in this browser version.');
    return;
  }
  try {
    const eyeDropper = new EyeDropper();
    const { sRGBHex } = await eyeDropper.open();
    currentGarmentRgb = hexToRgb(sRGBHex);
    garmentPickerBtn.style.background = sRGBHex;
    garmentPickerBtn.classList.add('has-color');
    updateVerdict();
  } catch (err) {
    // user pressed Escape / cancelled — leave whatever was picked before (or nothing) untouched
  }
}

/** Only shows a real result once BOTH colors are in — otherwise nudges the person to go pick the shirt color. */
function updateVerdict() {
  if (!currentSkinRgb) {
    verdictInline.classList.add('hidden');
    return;
  }
  verdictInline.classList.remove('hidden');

  if (!currentGarmentRgb) {
    verdictText.textContent = 'pick a shirt color';
    verdictText.className = 'verdict prompt';
    verdictNote.textContent = 'tap the grey circle above, then click the shirt in your photo to check the fit.';
    return;
  }

  const match = analyzeOutfitMatch(currentSkinRgb, currentGarmentRgb);
  verdictText.textContent = match.verdict;
  verdictText.className = 'verdict ' + (match.verdict === 'good contrast' ? 'good' : 'warn');
  verdictNote.textContent = match.note;
}
