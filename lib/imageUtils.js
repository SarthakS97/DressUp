/**
 * Shared image helpers used by popup.js and background.js.
 *
 * Storage note: MV3 background service workers have no `window`/`localStorage`
 * (no DOM at all — no document, no canvas element). chrome.storage.local is the
 * extension-native equivalent of localStorage that actually works in every
 * context (popup, background, content scripts) and gives us a bigger quota,
 * so that's what TryOn uses everywhere instead of window.localStorage.
 */

const TRYON_MAX_DIM = 900;      // longest edge, px — plenty for a result thumbnail/preview
const TRYON_JPEG_QUALITY = 0.72; // decent look, small size
const TRYON_STORAGE_KEY = 'tryon_history_v1';
const TRYON_USER_PHOTO_KEY = 'tryon_user_photo_v1';
const TRYON_BOARDS_KEY = 'tryon_boards_v1';
const TRYON_MAX_HISTORY = 40; // oldest entries get dropped past this
const TRYON_BOARD_MAX_IMAGES = 5;

/**
 * Fetch an image url and return it as a compressed base64 data URL (JPEG).
 * Works in the background service worker (uses OffscreenCanvas + createImageBitmap).
 */
async function tryonFetchAndCompress(imageUrl, maxDim = TRYON_MAX_DIM, quality = TRYON_JPEG_QUALITY) {
  const res = await fetch(imageUrl, { credentials: 'omit', referrer: '' });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${imageUrl}`);
  const blob = await res.blob();
  return tryonCompressBlob(blob, maxDim, quality);
}

/**
 * Compress an image Blob down to a small base64 JPEG data URL.
 * Uses OffscreenCanvas when available (service worker), falls back to a
 * normal <canvas> when running in a DOM context (popup).
 */
async function tryonCompressBlob(blob, maxDim = TRYON_MAX_DIM, quality = TRYON_JPEG_QUALITY) {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  let canvas, ctx;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(outW, outH);
    ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await tryonBlobToDataUrl(outBlob);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    return canvas.toDataURL('image/jpeg', quality);
  }
}

function tryonBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Compress a data URL (e.g. straight from <input type="file">) down to a small JPEG data URL. */
async function tryonCompressDataUrl(dataUrl, maxDim = TRYON_MAX_DIM, quality = TRYON_JPEG_QUALITY) {
  const blob = await (await fetch(dataUrl)).blob();
  return tryonCompressBlob(blob, maxDim, quality);
}

/** Save the user's body photo (already compressed) to chrome.storage.local. */
async function tryonSaveUserPhoto(dataUrl) {
  await chrome.storage.local.set({ [TRYON_USER_PHOTO_KEY]: dataUrl });
}

async function tryonGetUserPhoto() {
  const res = await chrome.storage.local.get(TRYON_USER_PHOTO_KEY);
  return res[TRYON_USER_PHOTO_KEY] || null;
}

async function tryonRemoveUserPhoto() {
  await chrome.storage.local.remove(TRYON_USER_PHOTO_KEY);
}

/**
 * Append a completed try-on result to history, oldest-first eviction so
 * storage never grows unbounded. Entry: { id, ts, resultImage, refImage, refUrl }
 */
async function tryonAddHistoryEntry(entry) {
  const res = await chrome.storage.local.get(TRYON_STORAGE_KEY);
  const history = res[TRYON_STORAGE_KEY] || [];
  history.unshift(entry);
  while (history.length > TRYON_MAX_HISTORY) history.pop();
  await chrome.storage.local.set({ [TRYON_STORAGE_KEY]: history });
  return history;
}

/** Patch one history entry by id (e.g. caching a Fitzpatrick result once it's been read). Shared by background.js and result.js. */
async function tryonPatchHistoryEntry(id, patch) {
  const history = await tryonGetHistory();
  const idx = history.findIndex((h) => h.id === id);
  if (idx === -1) return null;
  history[idx] = { ...history[idx], ...patch };
  await chrome.storage.local.set({ [TRYON_STORAGE_KEY]: history });
  return history[idx];
}

async function tryonGetHistory() {
  const res = await chrome.storage.local.get(TRYON_STORAGE_KEY);
  return res[TRYON_STORAGE_KEY] || [];
}

async function tryonGetHistoryEntry(id) {
  const history = await tryonGetHistory();
  return history.find((h) => h.id === id) || null;
}

/** Rough estimate (in KB) of how much chrome.storage.local space is used. */
async function tryonGetStorageUsageKB() {
  const bytes = await chrome.storage.local.getBytesInUse(null);
  return Math.round(bytes / 1024);
}

/* ============================== boards ==================================
 * A board is a small named collection of up to TRYON_BOARD_MAX_IMAGES
 * inspiration images gathered via right-click "add to board," analyzed
 * together once full. Shape:
 *   { id, name, images: [{ id, dataUrl, sourceUrl }], status: 'collecting'|'analyzing'|'done', createdAt }
 * ======================================================================= */

async function tryonGetBoards() {
  const res = await chrome.storage.local.get(TRYON_BOARDS_KEY);
  return res[TRYON_BOARDS_KEY] || [];
}

async function tryonSaveBoards(boards) {
  await chrome.storage.local.set({ [TRYON_BOARDS_KEY]: boards });
  return boards;
}

async function tryonGetBoard(boardId) {
  const boards = await tryonGetBoards();
  return boards.find((b) => b.id === boardId) || null;
}

async function tryonCreateBoard(name) {
  const boards = await tryonGetBoards();
  const board = {
    id: crypto.randomUUID(),
    name,
    images: [],
    status: 'collecting',
    createdAt: Date.now(),
  };
  boards.unshift(board);
  await tryonSaveBoards(boards);
  return board;
}

async function tryonRenameBoard(boardId, name) {
  const boards = await tryonGetBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) return null;
  board.name = name;
  await tryonSaveBoards(boards);
  return board;
}

async function tryonDeleteBoard(boardId) {
  const boards = await tryonGetBoards();
  await tryonSaveBoards(boards.filter((b) => b.id !== boardId));
}

/** Adds an image to a board (capped at TRYON_BOARD_MAX_IMAGES). Returns the updated board, or null if it was already full or not found. */
async function tryonAddImageToBoard(boardId, imageEntry) {
  const boards = await tryonGetBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) return null;
  if (board.images.length >= TRYON_BOARD_MAX_IMAGES) return null;
  board.images.push(imageEntry);
  await tryonSaveBoards(boards);
  return board;
}

async function tryonRemoveImageFromBoard(boardId, imageId) {
  const boards = await tryonGetBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) return null;
  board.images = board.images.filter((img) => img.id !== imageId);
  if (board.status === 'done') board.status = 'collecting'; // dropping below 5 invalidates a finished analysis
  await tryonSaveBoards(boards);
  return board;
}

async function tryonSetBoardStatus(boardId, status) {
  const boards = await tryonGetBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) return null;
  board.status = status;
  await tryonSaveBoards(boards);
  return board;
}

/** Generic patch for a board (status, results, whatever) — shared by background.js and lookbook.js. */
async function tryonUpdateBoard(boardId, patch) {
  const boards = await tryonGetBoards();
  const board = boards.find((b) => b.id === boardId);
  if (!board) return null;
  Object.assign(board, patch);
  await tryonSaveBoards(boards);
  return board;
}
