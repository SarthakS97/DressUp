importScripts('lib/imageUtils.js');

/* =========================================================================
 * CONFIG
 * Set API_KEY to a real YouCam key to go live. Until then, DressUp runs in
 * MOCK MODE: fakes a delay and returns the reference image as the "result,"
 * so the full pipeline is testable without hitting YouCam at all.
 * ======================================================================= */
const CONFIG = {
  API_KEY: 'sk-_6AbIWWkxjWUc6chdOsqI-MZIouurlhIxmTZQBgVfuiPyKl1wPKp6P6lW75FBZxP',
  BASE_URL: 'https://yce-api-01.makeupar.com',
  FILE_UPLOAD_PATH: '/s2s/v2.0/file',
  VTO_TASK_PATH: '/s2s/v2.0/task/cloth-v4',
  FITZPATRICK_TASK_PATH: '/s2s/v2.0/task/fitzpatrick-scale-analyzer',
  FITZPATRICK_VERSION: '1.0', // confirmed via docs sample request
  FITZPATRICK_INDEX: 0, // confirmed via docs sample request — which detected face to target (0 = first/only face)
  GARMENT_CATEGORY: 'auto', // 'full_body' | 'upper_body' | 'lower_body' | 'shoes' | 'outerwear' | 'auto'
  POLL_INTERVAL_MS: 2000,
  POLL_TIMEOUT_MS: 60000,
};

// IMPORTANT: this must stay compared to the literal placeholder string below,
// not to CONFIG.API_KEY's current value — editing this line to match your key
// (instead of leaving it as the placeholder) would make MOCK_MODE always true.
const MOCK_MODE = CONFIG.API_KEY === 'YOUR_YOUCAM_API_KEY_HERE';

/* ---------------------------- context menu ---------------------------- */

chrome.runtime.onInstalled.addListener(() => rebuildAllContextMenus());
chrome.runtime.onStartup.addListener(() => rebuildAllContextMenus());

/** Rebuilds the whole context menu from scratch against current board data. Called on install/startup and after any board is created/renamed/deleted/filled. Board *creation* only happens in the popup now — right-click only adds to boards that already exist. */
async function rebuildAllContextMenus() {
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));

  chrome.contextMenus.create({ id: 'add-to-board-parent', title: 'Add to DressUp lookbook', contexts: ['image'] });

  const boards = await tryonGetBoards();
  const openBoards = boards.filter((b) => b.images.length < TRYON_BOARD_MAX_IMAGES);

  if (openBoards.length === 0) {
    chrome.contextMenus.create({
      id: 'add-to-board:none',
      parentId: 'add-to-board-parent',
      title: 'Create new lookbook first to add',
      enabled: false,
      contexts: ['image'],
    });
    return;
  }

  for (const board of openBoards) {
    chrome.contextMenus.create({
      id: `add-to-board:${board.id}`,
      parentId: 'add-to-board-parent',
      title: `${board.name} (${board.images.length}/${TRYON_BOARD_MAX_IMAGES})`,
      contexts: ['image'],
    });
  }
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (typeof info.menuItemId === 'string' && info.menuItemId.startsWith('add-to-board:') && info.srcUrl) {
    const target = info.menuItemId.slice('add-to-board:'.length);
    if (target !== 'none') {
      addImageToBoardFlow(target, info.srcUrl);
    }
  }
});

async function addImageToBoardFlow(boardId, srcUrl) {
  try {
    const compressed = await tryonFetchAndCompress(srcUrl);
    await tryonAddImageToBoard(boardId, { id: crypto.randomUUID(), dataUrl: compressed, sourceUrl: srcUrl });
  } catch (e) {
    // silently drop — no good way to surface an error from a context menu click with no open tab
  }
  await rebuildAllContextMenus();
  chrome.runtime.sendMessage({ type: 'BOARDS_UPDATED' }).catch(() => {});
}

/* ------------------------------ messages ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_TRYON') {
    handleTryOnRequest(msg.ref).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true; // async response
  }
  if (msg.type === 'RUN_FITZPATRICK') {
    runFitzpatrickAnalysis(msg.faceCropDataUrl).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
    );
    return true; // async response
  }
  if (msg.type === 'REBUILD_BOARD_MENU') {
    // popup mutated boards directly (rename/delete/remove-image) — keep the context menu in sync
    rebuildAllContextMenus().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'RUN_LOOKBOOK_VTO') {
    runLookbookVto(msg.userPhotoDataUrl, msg.refDataUrl).then(
      (resultUrl) => sendResponse({ ok: true, resultUrl }),
      (err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
    );
    return true;
  }
});

/** One VTO call for the lookbook pipeline — both images are local data URLs (the user's own photo, and one of the 5 lookbook images), so both go through the File Upload API rather than the cheaper ref_file_url path (that path only works for images that already have a public URL). Reuses the same upload/submit/poll helpers as the single-image flow. */
async function runLookbookVto(userPhotoDataUrl, refDataUrl) {
  const srcFileId = await uploadImageToYouCam(userPhotoDataUrl, 'lookbook-user');
  const refFileId = await uploadImageToYouCam(refDataUrl, 'lookbook-ref');
  const taskId = await submitVtoTask(srcFileId, { ref_file_id: refFileId });
  return await pollVtoTask(taskId);
}

/* ------------------------------ pipeline -------------------------------
 * `ref` is always { kind: 'url' | 'dataUrl', value }.
 *  - 'url'     — a right-clicked image, or a pasted link. Already publicly
 *                reachable, so it's sent straight through as ref_file_url —
 *                no upload needed.
 *  - 'dataUrl' — an image pasted directly from the clipboard. Has no public
 *                URL, so it goes through the same File Upload API as the
 *                user's own photo, and gets sent as ref_file_id instead.
 * ------------------------------------------------------------------- */

async function handleTryOnRequest(ref) {
  if (!ref || !ref.value) return;

  const userPhoto = await tryonGetUserPhoto();
  if (!userPhoto) {
    chrome.tabs.create({ url: chrome.runtime.getURL('result.html?error=no-photo') });
    return;
  }

  const id = crypto.randomUUID();
  const pendingEntry = {
    id,
    ts: Date.now(),
    status: 'pending',
    refUrl: ref.kind === 'url' ? ref.value : null,
    refImage: null,
    resultImage: null,
    error: null,
  };
  await tryonAddHistoryEntry(pendingEntry);

  chrome.tabs.create({ url: chrome.runtime.getURL(`result.html?id=${id}`) });

  runTryOnPipeline(id, ref, userPhoto).catch((err) => {
    updateHistoryEntry(id, { status: 'error', error: String(err && err.message ? err.message : err) });
  });
}

async function runTryOnPipeline(id, ref, userPhotoDataUrl) {
  // 1. grab + compress the reference garment image for display/history
  let refCompressed;
  try {
    refCompressed = ref.kind === 'url'
      ? await tryonFetchAndCompress(ref.value)
      : await tryonCompressDataUrl(ref.value);
  } catch (e) {
    throw new Error('couldn\u2019t load that image — try right-clicking it directly, or pasting it fresh');
  }
  await updateHistoryEntry(id, { refImage: refCompressed });

  // 2. run the try-on (or mock)
  const resultUrl = MOCK_MODE
    ? await mockVtoCall(ref)
    : await callYouCamVto(userPhotoDataUrl, ref);

  // 3. compress + store the final result
  const resultCompressed = resultUrl.startsWith('data:')
    ? resultUrl
    : await tryonFetchAndCompress(resultUrl);

  await updateHistoryEntry(id, { status: 'done', resultImage: resultCompressed });
}

async function updateHistoryEntry(id, patch) {
  await tryonPatchHistoryEntry(id, patch);
  chrome.runtime.sendMessage({ type: 'TRYON_UPDATED', id }).catch(() => {});
}

/* ------------------------------ mock mode ------------------------------ */

function mockVtoCall(ref) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(ref.value), 1800); // works for both a url and a data: url
  });
}

/* ============================ real YouCam calls =========================
 * Matches the AI Clothes v4 docs:
 *   1. POST /s2s/v2.0/file          -> file_id + a signed S3 PUT url
 *   2. PUT the raw image bytes to that S3 url
 *   3. POST /s2s/v2.0/task/cloth-v4 -> { src_file_id, ref_file_url | ref_file_id, garment_category } -> task_id
 *   4. GET  /s2s/v2.0/task/cloth-v4/{task_id} -> poll until task_status is success|error
 *   5. data.results.url is the finished image
 * ======================================================================= */

async function callYouCamVto(userPhotoDataUrl, ref) {
  const srcFileId = await uploadImageToYouCam(userPhotoDataUrl, 'user');

  let refField;
  if (ref.kind === 'url') {
    refField = { ref_file_url: ref.value }; // already public — no upload needed
  } else {
    const refFileId = await uploadImageToYouCam(ref.value, 'ref');
    refField = { ref_file_id: refFileId }; // pasted image — had to upload it first
  }

  const taskId = await submitVtoTask(srcFileId, refField);
  return await pollVtoTask(taskId);
}

/** Steps 1-3 of the File API: register the upload, then PUT the bytes to S3. Used for both the user's photo and a pasted reference image. */
async function uploadImageToYouCam(dataUrl, label) {
  const blob = await (await fetch(dataUrl)).blob();
  const fileName = `dressup_${label}_${Date.now()}.jpg`;

  const registerRes = await fetch(`${CONFIG.BASE_URL}${CONFIG.FILE_UPLOAD_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{
        content_type: blob.type || 'image/jpeg',
        file_name: fileName,
        file_size: blob.size,
      }],
    }),
  });
  if (!registerRes.ok) throw new Error(`File upload registration failed: ${registerRes.status}`);
  const registerJson = await registerRes.json();
  const fileEntry = registerJson?.data?.files?.[0];
  const fileId = fileEntry?.file_id;
  const uploadReq = fileEntry?.requests?.[0];
  if (!fileId || !uploadReq?.url) throw new Error('File upload: unexpected response shape');

  const putRes = await fetch(uploadReq.url, {
    method: 'PUT',
    headers: uploadReq.headers || { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  });
  if (!putRes.ok) throw new Error(`Uploading image to storage failed: ${putRes.status}`);

  return fileId;
}

async function submitVtoTask(srcFileId, refField) {
  const res = await fetch(`${CONFIG.BASE_URL}${CONFIG.VTO_TASK_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      src_file_id: srcFileId,
      ...refField,
      garment_category: CONFIG.GARMENT_CATEGORY,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error || json?.error_code || `VTO submit failed: ${res.status}`);
  }
  const taskId = json?.data?.task_id;
  if (!taskId) throw new Error('VTO submit: no task_id in response');
  return taskId;
}

async function pollVtoTask(taskId) {
  const start = Date.now();
  while (Date.now() - start < CONFIG.POLL_TIMEOUT_MS) {
    const res = await fetch(`${CONFIG.BASE_URL}${CONFIG.VTO_TASK_PATH}/${taskId}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.API_KEY}` },
    });
    const json = await res.json();
    const status = json?.data?.task_status;
    if (status === 'success') {
      const url = json?.data?.results?.url;
      if (!url) throw new Error('VTO success but no result url in response');
      return url;
    }
    if (status === 'error') {
      throw new Error(json?.data?.error || 'VTO task failed');
    }
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }
  throw new Error('VTO task timed out');
}

/* ========================= Fitzpatrick skin type =========================
 * Docs confirm the endpoint + task flow (submit -> poll, same shape as
 * every other task here) but don't show a sample *success* response body,
 * unlike the other APIs we've wired up. parseFitzpatrickResult() below
 * tries several plausible field paths and throws a clear, loggable error
 * if none match, rather than silently returning something wrong — check
 * the console on first real run to confirm which path actually hit, and
 * trim this down once confirmed.
 * ======================================================================= */

async function runFitzpatrickAnalysis(faceCropDataUrl) {
  if (MOCK_MODE) {
    return await mockFitzpatrickCall();
  }
  const fileId = await uploadImageToYouCam(faceCropDataUrl, 'face');
  const taskId = await submitFitzpatrickTask(fileId);
  return await pollFitzpatrickTask(taskId);
}

function mockFitzpatrickCall() {
  const mockTypes = ['I', 'II', 'III', 'IV', 'V', 'VI'];
  const pick = mockTypes[Math.floor(Math.random() * mockTypes.length)];
  return new Promise((resolve) => setTimeout(() => resolve(pick), 1400));
}

async function submitFitzpatrickTask(fileId) {
  const res = await fetch(`${CONFIG.BASE_URL}${CONFIG.FITZPATRICK_TASK_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.API_KEY}`,
      'Content-Type': 'application/json',
    },
    // single face, default indexing — pre-process step skipped per the docs
    body: JSON.stringify({
      src_file_id: fileId,
      version: CONFIG.FITZPATRICK_VERSION,
      index: CONFIG.FITZPATRICK_INDEX,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(friendlyFitzpatrickError(json?.error_code || json?.error) || `Fitzpatrick submit failed: ${res.status}`);
  }
  const taskId = json?.data?.task_id;
  if (!taskId) throw new Error('Fitzpatrick submit: no task_id in response');
  return taskId;
}

async function pollFitzpatrickTask(taskId) {
  const start = Date.now();
  while (Date.now() - start < CONFIG.POLL_TIMEOUT_MS) {
    const res = await fetch(`${CONFIG.BASE_URL}${CONFIG.FITZPATRICK_TASK_PATH}/${taskId}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.API_KEY}` },
    });
    const json = await res.json();
    const status = json?.data?.task_status;
    if (status === 'success') {
      return parseFitzpatrickResult(json);
    }
    if (status === 'error') {
      const code = extractErrorCode(json?.data?.error);
      throw new Error(friendlyFitzpatrickError(code) || code || 'Fitzpatrick task failed');
    }
    await new Promise((r) => setTimeout(r, CONFIG.POLL_INTERVAL_MS));
  }
  throw new Error('Fitzpatrick task timed out');
}

/** YouCam's documented Fitzpatrick error codes (plus error_face_not_forward_facing, seen live in the API Playground but not listed in the docs) mapped to plain language. */
const FITZPATRICK_ERROR_MESSAGES = {
  error_below_min_image_size: 'That photo is too small \u2014 try a larger image.',
  error_face_position_invalid: 'Your face needs to be fully visible, without any part cut off.',
  error_face_position_too_small: 'Your face is too small in this photo to read \u2014 try a closer shot.',
  error_face_position_out_of_boundary: 'Your face is too close to the edge (or too large) in this photo.',
  error_insufficient_lighting: 'The lighting is too dim to read your skin tone \u2014 try a brighter photo.',
  error_face_angle_invalid: 'Face the camera more directly \u2014 keep your head within about 10\u00b0 of straight.',
  error_face_not_forward_facing: 'Face the camera directly for an accurate reading.',
};

function extractErrorCode(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') return err.code || err.error_code || err.message || null;
  return null;
}

function friendlyFitzpatrickError(rawCode) {
  const code = extractErrorCode(rawCode);
  if (!code) return null;
  return FITZPATRICK_ERROR_MESSAGES[String(code).trim()] || null;
}

function parseFitzpatrickResult(json) {
  const d = json?.data?.results;
  const type = d?.fitzpatrick_scale; // confirmed real field, e.g. "III"
  if (!type) throw new Error('Fitzpatrick result: no fitzpatrick_scale in response');
  return type;
}
