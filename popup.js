// ---------- tab switching ----------
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => { t.classList.remove('is-active'); t.setAttribute('aria-selected', 'false'); });
    panels.forEach((p) => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    tab.setAttribute('aria-selected', 'true');
    document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add('is-active');
    if (tab.dataset.tab === 'boards') showBoardList();
  });
});

// ---------- your fit ----------
const fileInput = document.getElementById('fileInput');
const polaroidDrop = document.getElementById('polaroidDrop');
const userPhotoImg = document.getElementById('userPhotoImg');
const polaroidEmpty = document.getElementById('polaroidEmpty');
const polaroidCaption = document.getElementById('polaroidCaption');
const removePhotoBtn = document.getElementById('removePhotoBtn');
const historyBtn = document.getElementById('historyBtn');

(async function init() {
  const existing = await tryonGetUserPhoto();
  if (existing) showUserPhoto(existing);
})();

polaroidDrop.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const rawDataUrl = await tryonBlobToDataUrl(file);
  const compressed = await tryonCompressDataUrl(rawDataUrl, 900, 0.75);
  await tryonSaveUserPhoto(compressed);
  showUserPhoto(compressed);
});

removePhotoBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  await tryonRemoveUserPhoto();
  userPhotoImg.classList.add('hidden');
  polaroidEmpty.classList.remove('hidden');
  polaroidCaption.textContent = 'no photo yet';
  removePhotoBtn.style.display = 'none';
});

function showUserPhoto(dataUrl) {
  userPhotoImg.src = dataUrl;
  userPhotoImg.classList.remove('hidden');
  polaroidEmpty.classList.add('hidden');
  polaroidCaption.textContent = 'your fit ✓';
  removePhotoBtn.style.display = 'inline-block';
}

historyBtn.addEventListener('click', () => {
  document.querySelector('.tab[data-tab="boards"]').click();
});

// ---------- boards ----------
const boardListView = document.getElementById('boardListView');
const boardDetailView = document.getElementById('boardDetailView');
const boardList = document.getElementById('boardList');
const boardsEmptyHint = document.getElementById('boardsEmptyHint');
const newBoardNameInput = document.getElementById('newBoardNameInput');
const createBoardBtn = document.getElementById('createBoardBtn');
const backToBoardsBtn = document.getElementById('backToBoardsBtn');
const boardNameInput = document.getElementById('boardNameInput');
const boardGrid = document.getElementById('boardGrid');
const startAnalysisBtn = document.getElementById('startAnalysisBtn');
const viewResultsBtn = document.getElementById('viewResultsBtn');
const boardStatusText = document.getElementById('boardStatusText');
const deleteBoardBtn = document.getElementById('deleteBoardBtn');

let currentBoardId = null;

backToBoardsBtn.addEventListener('click', showBoardList);

createBoardBtn.addEventListener('click', createBoardFromInput);
newBoardNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createBoardFromInput();
});

/** Avoids two lookbooks ending up with the identical name — appends "(2)", "(3)"... until it's unique. */
function uniqueLookbookName(candidate, existingNames, excludeName) {
  const taken = new Set(
    existingNames
      .filter((n) => n.toLowerCase() !== (excludeName || '').toLowerCase())
      .map((n) => n.toLowerCase())
  );
  if (!taken.has(candidate.toLowerCase())) return candidate;
  let i = 2;
  while (taken.has(`${candidate} (${i})`.toLowerCase())) i++;
  return `${candidate} (${i})`;
}

async function createBoardFromInput() {
  const boards = await tryonGetBoards();
  const raw = newBoardNameInput.value.trim() || `Lookbook ${boards.length + 1}`;
  const name = uniqueLookbookName(raw, boards.map((b) => b.name));
  await tryonCreateBoard(name);
  newBoardNameInput.value = '';
  chrome.runtime.sendMessage({ type: 'REBUILD_BOARD_MENU' });
  showBoardList();
}

async function showBoardList() {
  currentBoardId = null;
  boardDetailView.classList.add('hidden');
  boardListView.classList.remove('hidden');

  const boards = await tryonGetBoards();
  boardList.innerHTML = '';
  boardsEmptyHint.classList.toggle('hidden', boards.length > 0);

  for (const board of boards) {
    const row = document.createElement('button');
    row.className = 'board-row';
    const thumbs = board.images.slice(0, 3).map((img) => `<img src="${img.dataUrl}" alt="" />`).join('');
    const statusPill = board.status === 'collecting' ? '' : `<span class="board-row-status ${board.status}">${board.status}</span>`;
    row.innerHTML = `
      <div class="board-row-thumbs">${thumbs}</div>
      <div class="board-row-info">
        <div class="board-row-name">${escapeHtml(board.name)}</div>
        <div class="board-row-count">${board.images.length}/5</div>
      </div>
      ${statusPill}
    `;
    row.addEventListener('click', () => showBoardDetail(board.id));
    boardList.appendChild(row);
  }
}

async function showBoardDetail(boardId) {
  currentBoardId = boardId;
  const board = await tryonGetBoard(boardId);
  if (!board) { showBoardList(); return; }

  boardListView.classList.add('hidden');
  boardDetailView.classList.remove('hidden');

  boardNameInput.value = board.name;

  boardGrid.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const img = board.images[i];
    const slot = document.createElement('div');
    slot.className = 'board-slot' + (img ? ' filled' : '');
    if (img) {
      slot.innerHTML = `<img src="${img.dataUrl}" alt="" title="Try this on" /><button class="board-slot-remove" title="Remove">✕</button>`;
      slot.querySelector('img').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'START_TRYON', ref: { kind: 'dataUrl', value: img.dataUrl } });
      });
      slot.querySelector('.board-slot-remove').addEventListener('click', async (e) => {
        e.stopPropagation();
        await tryonRemoveImageFromBoard(boardId, img.id);
        chrome.runtime.sendMessage({ type: 'REBUILD_BOARD_MENU' });
        showBoardDetail(boardId);
      });
    } else {
      slot.innerHTML = `<span class="board-slot-empty">empty</span>`;
    }
    boardGrid.appendChild(slot);
  }

  startAnalysisBtn.classList.toggle('hidden', board.images.length < 5 || board.status !== 'collecting');
  viewResultsBtn.classList.toggle('hidden', board.status !== 'analyzing' && board.status !== 'done');
  renderBoardStatus(board);
}

function renderBoardStatus(board) {
  if (board.status === 'analyzing') {
    boardStatusText.textContent = 'analyzing your board…';
    boardStatusText.className = 'board-status is-busy';
  } else if (board.status === 'done') {
    boardStatusText.textContent = 'success ✦ analysis complete';
    boardStatusText.className = 'board-status is-good';
  } else {
    boardStatusText.textContent = board.images.length < 5 ? `${5 - board.images.length} more to go` : '';
    boardStatusText.className = 'board-status';
  }
}

boardNameInput.addEventListener('change', async () => {
  if (!currentBoardId) return;
  const boards = await tryonGetBoards();
  const current = boards.find((b) => b.id === currentBoardId);
  const raw = boardNameInput.value.trim() || 'Untitled lookbook';
  const name = uniqueLookbookName(raw, boards.map((b) => b.name), current ? current.name : null);
  await tryonRenameBoard(currentBoardId, name);
  boardNameInput.value = name;
  chrome.runtime.sendMessage({ type: 'REBUILD_BOARD_MENU' });
});

startAnalysisBtn.addEventListener('click', async () => {
  if (!currentBoardId) return;
  await tryonUpdateBoard(currentBoardId, { status: 'analyzing' });
  chrome.tabs.create({ url: chrome.runtime.getURL(`lookbook.html?id=${currentBoardId}`) });
  showBoardDetail(currentBoardId); // refreshes button visibility + status in one pass
});

viewResultsBtn.addEventListener('click', () => {
  if (!currentBoardId) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`lookbook.html?id=${currentBoardId}`) });
});

deleteBoardBtn.addEventListener('click', async () => {
  if (!currentBoardId) return;
  await tryonDeleteBoard(currentBoardId);
  chrome.runtime.sendMessage({ type: 'REBUILD_BOARD_MENU' });
  showBoardList();
});

// keep the popup in sync if a board changed via right-click while this popup happens to be open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'BOARDS_UPDATED') {
    if (currentBoardId) showBoardDetail(currentBoardId);
    else if (!boardListView.classList.contains('hidden')) showBoardList();
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
