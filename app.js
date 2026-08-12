// ===== Utilities =====
function pad(n) { return n.toString().padStart(2, '0'); }

function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDuration(ms) {
  let s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatClock(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${pad(d.getMinutes())} ${ampm}`;
}

function inRange(dateKeyStr, start, end) {
  const d = parseKey(dateKeyStr);
  return d >= start && d <= end;
}

function getWeekRange(today) {
  const d = new Date(today); d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const start = new Date(d); start.setDate(d.getDate() - day);
  const end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getMonthRange(today) {
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
  return { start, end };
}

function avgDuration(days) {
  const withSessions = days.filter(d => d.sessions && d.sessions.length);
  if (!withSessions.length) return 0;
  const totalMs = withSessions.reduce((sum, d) => sum + d.sessions.reduce((s, ses) => s + ses.duration, 0), 0);
  return Math.round((totalMs / withSessions.length) / 60000);
}

// ===== State =====
let currentMonth = new Date(); currentMonth.setDate(1);
let selectedDate = null;
let currentDay = null;
let timerStart = null;
let timerInterval = null;
let lightboxPhoto = null;
let noteSaveTimeout = null;

// Registers a listener only if the element exists. A stale cached HTML
// paired with newer JS (mid service-worker update) shouldn't be able to
// crash the whole script and leave every later handler unregistered.
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Petty: expected #${id} but it was not found in the page.`);
  }
}

// Same idea for one-off DOM writes elsewhere (resetting the timer/manual
// form, etc.) so those can't throw and abort whatever called them either.
function withEl(id, fn) {
  const el = document.getElementById(id);
  if (el) fn(el);
}

// Render the calendar first and independently of everything below, so a
// failure wiring up some other feature can never leave the calendar blank.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist();
}
renderCalendar().catch(e => console.error('Petty: calendar failed to render', e));

// ===== Tab / view switching =====
function setActiveTabButton(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    flushNoteSave();
    setActiveTabButton(btn.dataset.tab);
    showView(btn.dataset.tab);
    if (btn.dataset.tab === 'metrics') renderMetrics();
  });
});

on('dayBack', 'click', () => {
  flushNoteSave();
  setActiveTabButton('calendar');
  showView('calendar');
  renderCalendar();
});

// ===== Calendar =====
on('prevMonth', 'click', () => {
  currentMonth.setMonth(currentMonth.getMonth() - 1);
  renderCalendar();
});
on('nextMonth', 'click', () => {
  currentMonth.setMonth(currentMonth.getMonth() + 1);
  renderCalendar();
});

async function renderCalendar() {
  document.getElementById('monthLabel').textContent =
    currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

  const year = currentMonth.getFullYear(), month = currentMonth.getMonth();
  const startWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const allDays = await DB.getAllDays();
  const dayMap = {};
  allDays.forEach(d => dayMap[d.date] = d);
  const todayKey = dateKey(new Date());

  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  for (let i = 0; i < startWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'day-cell empty';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(new Date(year, month, day));
    const cell = document.createElement('button');
    cell.className = 'day-cell' + (key === todayKey ? ' today' : '');

    const num = document.createElement('span');
    num.textContent = day;
    cell.appendChild(num);

    const rec = dayMap[key];
    if (rec && rec.cleanedBy === 'Jordan') cell.classList.add('cleaned-jordan');
    if (rec && rec.cleanedBy === 'Bethany') cell.classList.add('cleaned-bethany');

    if (rec && rec.photoCount) {
      const p = document.createElement('span');
      p.className = 'photo-dot'; p.textContent = '📷';
      cell.appendChild(p);
    }

    cell.addEventListener('click', () => openDay(key));
    grid.appendChild(cell);
  }
}

// ===== Day detail =====
async function openDay(key) {
  flushNoteSave();
  selectedDate = key;
  resetTimerUI();
  hideManualForm();
  currentDay = await DB.getDay(key);

  document.getElementById('dayLabel').textContent =
    parseKey(key).toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  renderWho();
  renderSessions();
  renderNote();
  await renderPhotos();
  showView('day');
}

on('whoJordan', 'click', () => setWho('Jordan'));
on('whoBethany', 'click', () => setWho('Bethany'));

async function setWho(who) {
  currentDay.cleanedBy = currentDay.cleanedBy === who ? null : who;
  await DB.putDay(currentDay);
  renderWho();
}

function renderWho() {
  document.getElementById('whoJordan').classList.toggle('selected', currentDay.cleanedBy === 'Jordan');
  document.getElementById('whoBethany').classList.toggle('selected', currentDay.cleanedBy === 'Bethany');
}

// ===== Notes =====
on('dayNote', 'input', () => {
  clearTimeout(noteSaveTimeout);
  noteSaveTimeout = setTimeout(saveNoteNow, 500);
});

on('noteEditBtn', 'click', () => setNoteMode('edit', { focus: true }));

on('noteDoneBtn', 'click', () => {
  clearTimeout(noteSaveTimeout);
  saveNoteNow();
  renderNote();
});

function saveNoteNow() {
  noteSaveTimeout = null;
  if (!currentDay) return;
  currentDay.note = document.getElementById('dayNote').value;
  DB.putDay(currentDay);
}

function flushNoteSave() {
  if (noteSaveTimeout) {
    clearTimeout(noteSaveTimeout);
    saveNoteNow();
  }
}

function renderNote() {
  const note = currentDay.note || '';
  withEl('noteText', el => { el.textContent = note; });
  withEl('dayNote', el => { el.value = note; });
  setNoteMode(note.trim() ? 'view' : 'edit');
}

function setNoteMode(mode, opts = {}) {
  withEl('noteView', el => el.classList.toggle('hidden', mode !== 'view'));
  withEl('noteEdit', el => el.classList.toggle('hidden', mode !== 'edit'));
  if (mode === 'edit' && opts.focus) {
    withEl('dayNote', el => el.focus());
  }
}

// ===== Stopwatch =====
on('timerToggle', 'click', toggleTimer);

function toggleTimer() {
  const btn = document.getElementById('timerToggle');
  if (timerStart === null) {
    timerStart = Date.now();
    btn.textContent = 'Stop';
    btn.classList.add('running');
    timerInterval = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
  } else {
    const end = Date.now();
    const duration = end - timerStart;
    currentDay.sessions.push({ start: timerStart, end, duration });
    DB.putDay(currentDay);
    resetTimerUI();
    renderSessions();
  }
}

function updateTimerDisplay() {
  document.getElementById('timerDisplay').textContent = formatDuration(Date.now() - timerStart);
}

function resetTimerUI() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  timerStart = null;
  withEl('timerToggle', btn => { btn.textContent = 'Start'; btn.classList.remove('running'); });
  withEl('timerDisplay', el => { el.textContent = '00:00:00'; });
}

// ===== Manual time entry =====
on('manualToggle', 'click', () => {
  document.getElementById('manualForm').classList.toggle('hidden');
});

on('manualCancel', 'click', hideManualForm);

on('manualSave', 'click', async () => {
  const session = buildManualSession();
  if (session) {
    currentDay.sessions.push(session);
    await DB.putDay(currentDay);
    renderSessions();
  }
  hideManualForm();
});

function hideManualForm() {
  withEl('manualForm', el => el.classList.add('hidden'));
  withEl('manualStart', el => el.value = '');
  withEl('manualEnd', el => el.value = '');
  withEl('manualDuration', el => el.value = '');
}

function combineDateTime(dateKeyStr, timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = parseKey(dateKeyStr);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function buildManualSession() {
  const startStr = document.getElementById('manualStart').value;
  const endStr = document.getElementById('manualEnd').value;
  const durationStr = document.getElementById('manualDuration').value;

  if (!startStr && !endStr && !durationStr) return null;

  const session = {};
  const startTs = startStr ? combineDateTime(selectedDate, startStr) : null;
  const endTs = endStr ? combineDateTime(selectedDate, endStr) : null;

  if (startTs !== null) session.start = startTs;
  if (endTs !== null) session.end = endTs;

  if (startTs !== null && endTs !== null) {
    let diff = endTs - startTs;
    if (diff < 0) diff += 24 * 60 * 60 * 1000; // crossed midnight
    session.duration = diff;
  } else if (durationStr) {
    session.duration = Math.round(parseFloat(durationStr) * 60000);
  }

  return session;
}

function sessionLabel(s) {
  if (s.start && s.end) return `${formatClock(s.start)} → ${formatClock(s.end)}`;
  if (s.start) return `${formatClock(s.start)} → —`;
  if (s.end) return `— → ${formatClock(s.end)}`;
  return 'Manual entry';
}

function renderSessions() {
  const list = document.getElementById('sessionList');
  list.innerHTML = '';
  let total = 0;

  currentDay.sessions.forEach((s, idx) => {
    total += s.duration || 0;
    const row = document.createElement('div');
    row.className = 'session-row';

    const info = document.createElement('span');
    info.textContent = sessionLabel(s);

    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = s.duration != null ? formatDuration(s.duration) : '—';

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      currentDay.sessions.splice(idx, 1);
      await DB.putDay(currentDay);
      renderSessions();
    });

    row.appendChild(info);
    row.appendChild(dur);
    row.appendChild(del);
    list.appendChild(row);
  });

  if (currentDay.sessions.length) {
    const totalRow = document.createElement('div');
    totalRow.className = 'session-total';
    totalRow.textContent = `Total: ${formatDuration(total)}`;
    list.appendChild(totalRow);
  }
}

// ===== Photos =====
on('beforeInput', 'change', e => handlePhotoUpload(e, 'before'));
on('afterInput', 'change', e => handlePhotoUpload(e, 'after'));

async function compressImage(file, maxDim = 1600, quality = 0.8) {
  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    return blob || file;
  } catch (e) {
    return file;
  }
}

async function handlePhotoUpload(e, type) {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const compressed = await compressImage(file);
    await DB.addPhoto(selectedDate, type, compressed);
  }
  currentDay.photoCount = (currentDay.photoCount || 0) + files.length;
  await DB.putDay(currentDay);
  e.target.value = '';
  await renderPhotos();
}

let beforePhotosList = [];
let afterPhotosList = [];

async function renderPhotos() {
  const photos = await DB.getPhotosForDate(selectedDate);
  beforePhotosList = photos.filter(p => p.type === 'before');
  afterPhotosList = photos.filter(p => p.type === 'after');

  const beforeGrid = document.getElementById('beforeGrid');
  const afterGrid = document.getElementById('afterGrid');
  beforeGrid.innerHTML = '';
  afterGrid.innerHTML = '';

  beforePhotosList.forEach((p, idx) => {
    beforeGrid.appendChild(createPhotoThumb(() => openLightbox(beforePhotosList, idx), p));
  });
  afterPhotosList.forEach((p, idx) => {
    afterGrid.appendChild(createPhotoThumb(() => openLightbox(afterPhotosList, idx), p));
  });
}

function createPhotoThumb(onClick, p) {
  const thumb = document.createElement('div');
  thumb.className = 'photo-thumb';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(p.blob);
  img.addEventListener('click', onClick);
  thumb.appendChild(img);
  return thumb;
}

// ===== Lightbox =====
let lightboxList = [];
let lightboxIndex = -1;

function openLightbox(list, index) {
  lightboxList = list;
  lightboxIndex = index;
  showLightboxPhoto();
  withEl('lightbox', el => el.classList.remove('hidden'));
}

function showLightboxPhoto() {
  const p = lightboxList[lightboxIndex];
  if (!p) { closeLightbox(); return; }
  lightboxPhoto = p;
  withEl('lightboxImg', el => el.src = URL.createObjectURL(p.blob));
  withEl('lightboxPrev', el => el.disabled = lightboxIndex <= 0);
  withEl('lightboxNext', el => el.disabled = lightboxIndex >= lightboxList.length - 1);
}

function closeLightbox() {
  withEl('lightbox', el => el.classList.add('hidden'));
  lightboxPhoto = null;
  lightboxList = [];
  lightboxIndex = -1;
}

on('lightboxClose', 'click', closeLightbox);
on('lightboxPrev', 'click', () => {
  if (lightboxIndex > 0) { lightboxIndex--; showLightboxPhoto(); }
});
on('lightboxNext', 'click', () => {
  if (lightboxIndex < lightboxList.length - 1) { lightboxIndex++; showLightboxPhoto(); }
});
on('lightboxDelete', 'click', async () => {
  if (!lightboxPhoto) return;
  const wasType = lightboxPhoto.type;
  await DB.deletePhoto(lightboxPhoto.id);
  currentDay.photoCount = Math.max(0, (currentDay.photoCount || 1) - 1);
  await DB.putDay(currentDay);
  await renderPhotos();

  const newList = wasType === 'before' ? beforePhotosList : afterPhotosList;
  if (!newList.length) {
    closeLightbox();
  } else {
    lightboxIndex = Math.min(lightboxIndex, newList.length - 1);
    lightboxList = newList;
    showLightboxPhoto();
  }
});

// ===== Metrics =====
async function renderMetrics() {
  const allDays = await DB.getAllDays();
  const today = new Date();
  const week = getWeekRange(today);
  const month = getMonthRange(today);

  ['Jordan', 'Bethany'].forEach(person => {
    const inWeek = allDays.filter(d => d.cleanedBy === person && inRange(d.date, week.start, week.end));
    const inMonth = allDays.filter(d => d.cleanedBy === person && inRange(d.date, month.start, month.end));

    const container = document.getElementById('metrics' + person);
    container.innerHTML = `
      <div class="metric-box"><div class="val">${inWeek.length}</div><div class="lbl">Days this week</div></div>
      <div class="metric-box"><div class="val">${inMonth.length}</div><div class="lbl">Days this month</div></div>
      <div class="metric-box"><div class="val">${avgDuration(inWeek)}</div><div class="lbl">Avg min this week</div></div>
      <div class="metric-box"><div class="val">${avgDuration(inMonth)}</div><div class="lbl">Avg min this month</div></div>
    `;
  });
}

// ===== Export / Import =====
function setDataStatus(msg) {
  withEl('dataStatus', el => el.textContent = msg);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

async function exportData() {
  setDataStatus('Preparing export…');
  try {
    const days = await DB.getAllDays();
    const photos = await DB.getAllPhotos();
    const photosOut = await Promise.all(photos.map(async p => ({
      date: p.date,
      type: p.type,
      dataUrl: await blobToDataURL(p.blob),
    })));

    const payload = { app: 'Petty', version: 1, days, photos: photosOut };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `petty-export-${dateKey(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setDataStatus(`Exported ${days.length} day${days.length === 1 ? '' : 's'} and ${photos.length} photo${photos.length === 1 ? '' : 's'}.`);
  } catch (e) {
    setDataStatus('Export failed: ' + e.message);
  }
}

async function importData(file) {
  setDataStatus('Importing…');
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !Array.isArray(payload.days)) throw new Error('That doesn\'t look like a Petty export file.');

    for (const day of payload.days) {
      await DB.putDay(day);
    }
    for (const p of payload.photos || []) {
      await DB.addPhoto(p.date, p.type, await dataURLToBlob(p.dataUrl));
    }

    setDataStatus(`Imported ${payload.days.length} day${payload.days.length === 1 ? '' : 's'} and ${(payload.photos || []).length} photo${(payload.photos || []).length === 1 ? '' : 's'}.`);
    renderCalendar();
  } catch (e) {
    setDataStatus('Import failed: ' + e.message);
  }
}

on('exportDataBtn', 'click', exportData);
on('importDataInput', 'change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importData(file);
  e.target.value = '';
});
