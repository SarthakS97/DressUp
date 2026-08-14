const params = new URLSearchParams(location.search);
const boardId = params.get('id');

const lookbookNameEl = document.getElementById('lookbookName');
const errorState = document.getElementById('errorState');
const errorText = document.getElementById('errorText');
const progressState = document.getElementById('progressState');
const progressText = document.getElementById('progressText');
const progressCount = document.getElementById('progressCount');
const resultsWrap = document.getElementById('resultsWrap');
const resultsHint = document.getElementById('resultsHint');
const resultsGrid = document.getElementById('resultsGrid');

init();

async function init() {
  if (!boardId) return showError('no lookbook specified');

  const board = await tryonGetBoard(boardId);
  if (!board) return showError('this lookbook no longer exists');
  lookbookNameEl.textContent = board.name;

  if (board.images.length !== 5) return showError('this lookbook doesn\u2019t have 5 images yet');

  const userPhoto = await tryonGetUserPhoto();
  if (!userPhoto) return showError('upload your fit photo in the DressUp popup first');

  // already analyzed — just show what's cached, no re-processing, no re-spending API units
  if (board.status === 'done' && Array.isArray(board.results) && board.results.length === board.images.length) {
    renderResults(board.results, board.images, true);
    return;
  }

  await runPipeline(board, userPhoto);
}

function showError(msg) {
  progressState.style.display = 'none';
  resultsWrap.style.display = 'none';
  errorState.style.display = 'flex';
  errorText.textContent = msg;
}

/* ------------------------------- pipeline -------------------------------- */

async function runPipeline(board, userPhotoDataUrl) {
  progressState.style.display = 'flex';
  resultsWrap.style.display = 'flex';
  resultsGrid.innerHTML = '';
  resultsHint.textContent = '';

  try {
    // ---- phase 1: VTO for all 5 looks ----
    const results = [];
    for (let i = 0; i < board.images.length; i++) {
      const boardImage = board.images[i];
      const n = i + 1;

      try {
        setProgress(`look ${n} of 5 \u2014 trying it on…`, `${n}/5`);
        const response = await chrome.runtime.sendMessage({
          type: 'RUN_LOOKBOOK_VTO',
          userPhotoDataUrl: userPhotoDataUrl,
          refDataUrl: boardImage.dataUrl,
        });
        if (!response || !response.ok) throw new Error(response?.error || 'try-on failed');

        const resultCompressed = await tryonFetchAndCompress(response.resultUrl);
        results.push({ imageId: boardImage.id, status: 'done', resultImage: resultCompressed, error: null });
      } catch (err) {
        results.push({ imageId: boardImage.id, status: 'error', resultImage: null, error: String(err && err.message ? err.message : err) });
      }

      renderResults(results, board.images, false); // progressive reveal as each finishes
      await tryonUpdateBoard(board.id, { results }); // save after every image — closing the tab mid-run doesn't lose work
    }

    // ---- phase 2: skin tone (once) + per-look garment color ----
    setProgress('reading your skin tone…', '');
    const skinRgb = await readSkinToneFromPhoto(userPhotoDataUrl);

    if (skinRgb) {
      for (let i = 0; i < results.length; i++) {
        if (results[i].status !== 'done') continue;
        setProgress(`checking the fit \u2014 look ${i + 1} of 5`, `${i + 1}/5`);
        try {
          const match = await matchGarmentToSkin(results[i].resultImage, skinRgb);
          results[i].garmentHex = match.garmentHex;
          results[i].verdict = match.verdict;
          results[i].contrast = match.contrast;
        } catch (e) {
          // no face found on this particular render, or sampling failed — keep the reason so it's visible, not silently dropped
          results[i].verdictError = String(e && e.message ? e.message : e);
        }
        renderResults(results, board.images, false);
        await tryonUpdateBoard(board.id, { results });
      }
    }

    progressState.style.display = 'none';
    const doneCount = results.filter((r) => r.status === 'done').length;
    resultsHint.textContent = doneCount === results.length
      ? 'success \u2726 5 looks ready'
      : `${doneCount}/5 looks ready \u2014 ${results.length - doneCount} couldn\u2019t be processed`;
    resultsHint.className = doneCount > 0 ? 'results-hint is-good' : 'results-hint';

    renderResults(results, board.images, true); // final pass — sorted by best match
    await tryonUpdateBoard(board.id, { status: 'done', results });
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
  }
}

function setProgress(text, count) {
  progressText.textContent = text;
  progressCount.textContent = count;
}

/* --------------------------- color analysis ---------------------------- *
 * Face detection first (same bundled face-api.js already proven safe in
 * this extension), then the torso region just below it, excluding any
 * pixel close to the known skin tone — the "face-first, exclude, sample"
 * approach, run automatically per look instead of a manual eyedropper.
 * ------------------------------------------------------------------- */

const FACE_MODEL_URL = 'lib/models';
let modelsLoaded = false;
async function ensureModelsLoaded() {
  if (modelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
  modelsLoaded = true;
}

async function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = dataUrl;
  });
}

/** Detects a face in the given image and returns { faceX, faceY, faceW, faceH, fullCanvas } — the padded box plus a canvas of the whole image, ready for sampling. */
async function detectPaddedFace(dataUrl) {
  await ensureModelsLoaded();
  const img = await loadImage(dataUrl);
  // larger inputSize + lower scoreThreshold than the defaults — more lenient, catches harder cases
  // (odd crop/angle on a VTO render) at a small speed cost that doesn't matter for a single still image
  const detection = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 512, scoreThreshold: 0.3 }));
  if (!detection) return null;

  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = naturalW;
  fullCanvas.height = naturalH;
  fullCanvas.getContext('2d').drawImage(img, 0, 0, naturalW, naturalH);

  const box = detection.box;
  const padX = box.width * 0.45;
  const padTop = box.height * 0.35;
  const padBottom = box.height * 0.55;
  const faceX = Math.max(0, box.x - padX);
  const faceY = Math.max(0, box.y - padTop);
  const faceW = Math.min(naturalW - faceX, box.width + padX * 2);
  const faceH = Math.min(naturalH - faceY, box.height + padTop + padBottom);

  return { faceX, faceY, faceW, faceH, naturalW, naturalH, fullCanvas };
}

async function readSkinToneFromPhoto(userPhotoDataUrl) {
  try {
    const face = await detectPaddedFace(userPhotoDataUrl);
    if (!face) return null;

    const faceCanvas = document.createElement('canvas');
    faceCanvas.width = face.faceW;
    faceCanvas.height = face.faceH;
    faceCanvas.getContext('2d').drawImage(face.fullCanvas, face.faceX, face.faceY, face.faceW, face.faceH, 0, 0, face.faceW, face.faceH);
    const faceCropDataUrl = faceCanvas.toDataURL('image/jpeg', 0.85);

    const response = await chrome.runtime.sendMessage({ type: 'RUN_FITZPATRICK', faceCropDataUrl });
    if (!response || !response.ok) return null;

    const swatch = getFitzpatrickSwatch(response.result);
    return swatch ? hexToRgb(swatch.hex) : null;
  } catch (e) {
    return null;
  }
}

async function matchGarmentToSkin(resultImageDataUrl, skinRgb) {
  const face = await detectPaddedFace(resultImageDataUrl);
  if (!face) throw new Error('no face detected on this render');

  const garmentY = Math.min(face.naturalH - 1, face.faceY + face.faceH + face.faceH * 0.08);
  const garmentH = Math.min(face.naturalH - garmentY, face.faceH * 0.9);
  const garmentRgb = dominantColorExcludingSkin(face.fullCanvas.getContext('2d'), face.faceX, garmentY, face.faceW, garmentH, skinRgb);
  if (!garmentRgb) throw new Error('garment region looked like skin \u2014 nothing to sample');

  const match = analyzeOutfitMatch(skinRgb, garmentRgb);
  const garmentHex = `rgb(${garmentRgb.r}, ${garmentRgb.g}, ${garmentRgb.b})`;
  return { garmentHex, verdict: match.verdict, contrast: match.contrast };
}

/* -------------------------------- rendering ------------------------------- */

function verdictRank(entry) {
  if (entry.status !== 'done') return 99;
  if (!entry.verdict) return 3;
  if (entry.verdict === 'good contrast') return 0;
  if (entry.verdict === 'similar hue') return 1;
  return 2; // low contrast
}

function renderResults(results, boardImages, sorted) {
  resultsWrap.style.display = 'flex';
  const ordered = sorted
    ? [...results].sort((a, b) => verdictRank(a) - verdictRank(b) || (b.contrast || 0) - (a.contrast || 0))
    : results;

  resultsGrid.innerHTML = '';
  for (const entry of ordered) addResultCard(entry, boardImages);
}

function verdictBadgeHtml(entry) {
  if (entry.verdict) {
    return `<span class="card-verdict-dot" style="background:${entry.garmentHex}"></span><span class="card-verdict-text ${entry.verdict === 'good contrast' ? 'good' : 'warn'}">${entry.verdict}</span>`;
  }
  if (entry.verdictError) {
    return `<span class="card-verdict-unknown">(${escapeHtml(entry.verdictError)})</span>`;
  }
  return '';
}

function addResultCard(entry, boardImages) {
  const card = document.createElement('div');
  card.className = 'result-card ' + entry.status;

  const refImage = boardImages.find((img) => img.id === entry.imageId);
  const refThumbHtml = refImage ? `<div class="ref-thumb"><img src="${refImage.dataUrl}" alt="reference" /></div>` : '';

  if (entry.status === 'done') {
    card.innerHTML = `${refThumbHtml}<img src="${entry.resultImage}" alt="" /><div class="result-card-label">ready \u2726 ${verdictBadgeHtml(entry)}</div>`;
    card.querySelector(':scope > img').addEventListener('click', () => openLightbox(entry, boardImages));
  } else {
    card.classList.add('is-error');
    card.innerHTML = `${refThumbHtml}<div class="result-card-error">couldn\u2019t process this look<br/>${escapeHtml(entry.error || '')}</div>`;
  }
  resultsGrid.appendChild(card);
}

/* -------------------------------- lightbox -------------------------------- */
const lightbox = document.getElementById('lightbox');
const lightboxContent = document.getElementById('lightboxContent');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxRefThumb = document.getElementById('lightboxRefThumb');
const lightboxRefImg = document.getElementById('lightboxRefImg');
const lightboxInfo = document.getElementById('lightboxInfo');
const lightboxClose = document.getElementById('lightboxClose');

function openLightbox(entry, boardImages) {
  lightboxImg.src = entry.resultImage;

  const refImage = boardImages.find((img) => img.id === entry.imageId);
  if (refImage) {
    lightboxRefImg.src = refImage.dataUrl;
    lightboxRefThumb.style.display = 'block';
  } else {
    lightboxRefThumb.style.display = 'none';
  }

  const badge = verdictBadgeHtml(entry);
  lightboxInfo.innerHTML = badge ? `<span>ready \u2726</span> ${badge}` : `<span>ready \u2726</span>`;

  lightbox.classList.add('is-open');
}
function closeLightbox() {
  lightbox.classList.remove('is-open');
}
lightbox.addEventListener('click', closeLightbox);
lightboxContent.addEventListener('click', (e) => e.stopPropagation()); // clicking the image/thumb/info shouldn't close it
lightboxClose.addEventListener('click', (e) => { e.stopPropagation(); closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
