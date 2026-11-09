'use strict';
/* ICS 106 Laboratory 02 - Smart Object Recognition
 * Loads a published Teachable Machine image model, classifies uploaded images
 * and webcam frames, shows all class scores, warns on uncertain predictions,
 * and keeps a test log so V1 and V2 can be compared on the same images.
 */

// ---------- Settings ----------
const LOW_CONFIDENCE_PERCENT = 70;   // warn when the top score is below this
const CLOSE_MARGIN_PERCENT = 15;     // warn when the top two classes are this close
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const WEBCAM_INTERVAL_MS = 250;
const EXPECTED_CLASSES = 3;
const KEY_URLS = 'ics106.lab02.modelUrls';
const KEY_LOG = 'ics106.lab02.testLog';

// ---------- Elements ----------
const $ = (id) => document.getElementById(id);
const el = {
  modelVersion: $('modelVersion'), modelUrl: $('modelUrl'), loadBtn: $('loadBtn'),
  modelInfo: $('modelInfo'), versionNote: $('versionNote'), classList: $('classList'),
  activeModel: $('activeModel'), activeChip: $('activeChip'),
  imageInput: $('imageInput'), fileName: $('fileName'), preview: $('preview'),
  previewHint: $('previewHint'), classifyBtn: $('classifyBtn'), status: $('status'),
  camStartBtn: $('camStartBtn'), camStopBtn: $('camStopBtn'), camStatus: $('camStatus'),
  webcamBox: $('webcamBox'), webcamHint: $('webcamHint'),
  resultSource: $('resultSource'), topClass: $('topClass'), topConfidence: $('topConfidence'),
  warning: $('warning'), predictions: $('predictions'),
  logBody: $('logBody'), logCount: $('logCount'), csvBtn: $('csvBtn'), clearLogBtn: $('clearLogBtn')
};

// ---------- State ----------
let model = null;            // the model that is actually loaded
let loadedVersion = null;    // "V1" or "V2" for the loaded model
let loadedUrl = null;
let loadCounter = 0;         // ignores results of outdated load requests
let selectedImageReady = false;
let selectedFile = null;
let currentObjectUrl = null;
let shownVersion = el.modelVersion.value;
let savedUrls = { V1: '', V2: '' };
let testLog = [];
let webcam = null;
let webcamRunning = false;
let webcamFrame = 0;
let webcamBusy = false;
let webcamLast = 0;

// ---------- Storage (safe if the browser blocks it) ----------
function readStore(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
  catch (e) { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

// ---------- Small helpers ----------
function setStatus(message, kind = '') { el.status.textContent = message; el.status.className = kind; }
function setCamStatus(message, kind = '') { el.camStatus.textContent = message; el.camStatus.className = kind; }
function pct(probability) { return probability * 100; }
function fmt(percent) { return percent.toFixed(1) + '%'; }

function normalizeModelUrl(raw) {
  const text = (raw || '').trim();
  if (!text) throw new Error('Enter a model URL first.');
  let url;
  try { url = new URL(text); } catch (e) { throw new Error('That is not a valid URL.'); }
  if (url.protocol !== 'https:') throw new Error('Use an HTTPS model URL.');
  if (url.hostname !== 'teachablemachine.withgoogle.com') throw new Error('Use a published Teachable Machine model URL.');
  if (!/^\/models\/[^/]+\/?$/.test(url.pathname)) throw new Error('The URL must end in /models/MODEL_ID/.');
  if (url.search || url.hash) throw new Error('Remove anything after the model ID (? or #).');
  return url.origin + url.pathname.replace(/\/?$/, '/');
}

function updateButtons() { el.classifyBtn.disabled = !selectedImageReady; }

function updateActiveDisplay() {
  if (model) {
    el.activeModel.textContent = loadedVersion;
    el.activeChip.dataset.state = 'loaded';
    el.activeChip.title = loadedUrl;
    el.modelInfo.textContent = `${loadedVersion} loaded, ${model.getTotalClasses()} classes.`;
    const labels = model.getClassLabels();
    el.classList.hidden = false;
    el.classList.textContent = 'Classes: ' + labels.join(', ');
  } else {
    el.activeModel.textContent = 'None loaded';
    el.activeChip.dataset.state = 'none';
    el.activeChip.title = '';
    el.modelInfo.textContent = 'No model loaded.';
    el.classList.hidden = true;
  }
  const mismatch = model && el.modelVersion.value !== loadedVersion;
  el.versionNote.hidden = !mismatch;
  if (mismatch) {
    el.versionNote.textContent = `${el.modelVersion.value} is selected but ${loadedVersion} is still the active model. Click Load model to switch.`;
  }
}

// ---------- Results ----------
function clearResults(message = 'Scores for every class appear here.') {
  el.resultSource.textContent = 'No prediction yet.';
  el.topClass.textContent = '—';
  el.topConfidence.textContent = '—';
  el.warning.hidden = true;
  el.warning.textContent = '';
  const p = document.createElement('p');
  p.className = 'muted'; p.textContent = message;
  el.predictions.replaceChildren(p);
}

function renderResults(rawPredictions, sourceLabel) {
  const sorted = [...rawPredictions].sort((a, b) => b.probability - a.probability);
  const top = sorted[0];
  const topPercent = pct(top.probability);

  el.resultSource.textContent = `${sourceLabel} · model ${loadedVersion}`;
  el.topClass.textContent = top.className;
  el.topConfidence.textContent = fmt(topPercent);

  const rows = sorted.map((item, index) => {
    const percent = pct(item.probability);
    const row = document.createElement('div');
    row.className = 'score-row' + (index === 0 ? ' top' : '');
    const head = document.createElement('div'); head.className = 'score-head';
    const name = document.createElement('span'); name.className = 'score-name'; name.textContent = item.className;
    const value = document.createElement('span'); value.textContent = fmt(percent);
    head.append(name, value);
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', item.className);
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', percent.toFixed(1));
    const fill = document.createElement('i'); fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    bar.append(fill);
    row.append(head, bar);
    return row;
  });
  el.predictions.replaceChildren(...rows);

  // Uncertainty warning (FR-10)
  let message = '';
  if (topPercent < LOW_CONFIDENCE_PERCENT) {
    message = `Low confidence: the top score is ${fmt(topPercent)}, below ${LOW_CONFIDENCE_PERCENT}%. Treat this prediction as uncertain.`;
  } else if (sorted.length > 1 && topPercent - pct(sorted[1].probability) < CLOSE_MARGIN_PERCENT) {
    message = `Close call: ${top.className} and ${sorted[1].className} are within ${CLOSE_MARGIN_PERCENT} points of each other. Treat this prediction as uncertain.`;
  }
  el.warning.hidden = !message;
  el.warning.textContent = message;
  return { sorted, top, topPercent };
}

// ---------- Model loading ----------
function friendlyLoadError(err) {
  const msg = String((err && err.message) || err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return 'Could not download the model files. Check your internet connection and that the model is published (public).';
  }
  if (/Unexpected token|JSON|404|not found/i.test(msg)) {
    return 'The URL did not return a valid model. Check the model ID and that the model was uploaded with Export Model.';
  }
  return msg;
}

async function loadSelectedModel() {
  const requestId = ++loadCounter;
  const wanted = el.modelVersion.value;
  el.loadBtn.disabled = true;
  setStatus(`Loading ${wanted}...`);
  try {
    if (typeof tmImage === 'undefined') {
      throw new Error('The Teachable Machine library did not load. Check your internet connection and reload.');
    }
    const url = normalizeModelUrl(el.modelUrl.value);
    const next = await tmImage.load(url + 'model.json', url + 'metadata.json');
    if (requestId !== loadCounter) return; // a newer request replaced this one
    if (!next || next.getTotalClasses() < 2) throw new Error('The model has fewer than 2 classes.');
    model = next; loadedUrl = url; loadedVersion = wanted;
    savedUrls[wanted] = url; writeStore(KEY_URLS, savedUrls);
    clearResults('No prediction for this model yet.');
    updateActiveDisplay();
    let message = `${wanted} loaded successfully.`;
    if (model.getTotalClasses() !== EXPECTED_CLASSES) {
      message += ` Note: this lab expects ${EXPECTED_CLASSES} classes but the model has ${model.getTotalClasses()}.`;
    }
    setStatus(message, 'success');
  } catch (err) {
    if (requestId !== loadCounter) return;
    // Keep the previously loaded model so the app stays usable.
    const keep = model ? ` ${loadedVersion} is still active.` : '';
    setStatus(`Model load failed: ${friendlyLoadError(err)}${keep}`, 'error');
    updateActiveDisplay();
  } finally {
    if (requestId === loadCounter) el.loadBtn.disabled = false;
    updateButtons();
  }
}

function onVersionChange() {
  savedUrls[shownVersion] = el.modelUrl.value.trim();
  shownVersion = el.modelVersion.value;
  el.modelUrl.value = savedUrls[shownVersion] || '';
  writeStore(KEY_URLS, savedUrls);
  updateActiveDisplay();
  setStatus(model
    ? `${shownVersion} selected. Click Load model to activate it. ${loadedVersion} is still active.`
    : `${shownVersion} selected. Enter its URL and click Load model.`);
}

// ---------- Image upload ----------
function handleImageSelection() {
  selectedImageReady = false; selectedFile = null;
  updateButtons();
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  const file = el.imageInput.files && el.imageInput.files[0];
  if (!file) {
    el.preview.hidden = true; el.previewHint.hidden = false;
    el.fileName.textContent = 'PNG, JPEG or WebP, up to 8 MB';
    setStatus('Choose an image.'); return;
  }
  const reject = (message) => {
    el.imageInput.value = ''; el.preview.hidden = true; el.previewHint.hidden = false;
    el.fileName.textContent = 'No file selected';
    setStatus(message, 'error');
  };
  if (!ALLOWED_TYPES.includes(file.type)) {
    return reject(`Unsupported file "${file.name}". Use a JPEG, PNG or WebP image. HEIC photos must be converted to JPEG first.`);
  }
  if (file.size > MAX_FILE_BYTES) return reject('This image is larger than 8 MB. Use a smaller file.');
  selectedFile = file;
  el.fileName.textContent = file.name;
  currentObjectUrl = URL.createObjectURL(file);
  el.preview.onload = () => {
    selectedImageReady = true; el.preview.hidden = false; el.previewHint.hidden = true;
    updateButtons();
    setStatus(model ? 'Image ready. Click Classify image.' : 'Image ready. Load a model, then click Classify image.');
  };
  el.preview.onerror = () => {
    selectedImageReady = false; selectedFile = null; el.preview.hidden = true; el.previewHint.hidden = false;
    updateButtons(); setStatus('This file could not be read as an image. It may be damaged.', 'error');
  };
  el.preview.src = currentObjectUrl;
}

async function classifySelectedImage() {
  if (!selectedImageReady || !selectedFile) { setStatus('Choose an image first.', 'error'); return; }
  if (!model) { setStatus('Load a model before classifying.', 'error'); return; }
  el.classifyBtn.disabled = true;
  setStatus('Classifying...');
  try {
    const predictions = await model.predict(el.preview);
    const { top, topPercent } = renderResults(predictions, `Image: ${selectedFile.name}`);
    addLogEntry(selectedFile.name, loadedVersion, top.className, topPercent, predictions);
    setStatus(`Done. Top class: ${top.className} (${fmt(topPercent)}).`, 'success');
  } catch (err) {
    setStatus(`Classification failed: ${err.message || err}`, 'error');
  } finally {
    updateButtons();
  }
}

// ---------- Test log ----------
function addLogEntry(file, version, predicted, confidence, predictions) {
  const scores = [...predictions].sort((a, b) => b.probability - a.probability)
    .map((p) => `${p.className}=${pct(p.probability).toFixed(1)}`).join('; ');
  const entry = { file, version, predicted, confidence: Number(confidence.toFixed(1)), scores,
                  time: new Date().toISOString() };
  const existing = testLog.findIndex((e) => e.file === file && e.version === version);
  if (existing >= 0) testLog[existing] = entry; else testLog.push(entry);
  writeStore(KEY_LOG, testLog);
  renderLog();
}

function renderLog() {
  el.logCount.textContent = testLog.length ? `(${testLog.length})` : '';
  el.csvBtn.disabled = el.clearLogBtn.disabled = testLog.length === 0;
  if (!testLog.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 5; td.className = 'muted'; td.textContent = 'No images classified yet.';
    tr.append(td); el.logBody.replaceChildren(tr); return;
  }
  const rows = testLog.map((e, i) => {
    const tr = document.createElement('tr');
    [i + 1, e.file, e.version, e.predicted, e.confidence.toFixed(1) + '%'].forEach((v) => {
      const td = document.createElement('td'); td.textContent = String(v); tr.append(td);
    });
    return tr;
  });
  el.logBody.replaceChildren(...rows);
}

function csvCell(value) {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // stop spreadsheet formula injection
  return '"' + text.replace(/"/g, '""') + '"';
}
function downloadCsv() {
  const header = ['Entry', 'File', 'Model_Version', 'Predicted_Class', 'Confidence_Percent', 'All_Scores', 'Time'];
  const lines = [header.map(csvCell).join(',')];
  testLog.forEach((e, i) => lines.push([i + 1, e.file, e.version, e.predicted, e.confidence, e.scores, e.time].map(csvCell).join(',')));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = 'ics106-test-log.csv';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
function clearLog() {
  if (!testLog.length || !window.confirm('Clear all rows from the test log?')) return;
  testLog = []; writeStore(KEY_LOG, testLog); renderLog();
}

// ---------- Webcam ----------
async function startWebcam() {
  if (webcamRunning) return;
  if (!model) { setCamStatus('Load a model before starting the webcam.', 'error'); return; }
  el.camStartBtn.disabled = true;
  setCamStatus('Starting camera...');
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot use a camera here. Open the page over https or localhost.');
    }
    webcam = new tmImage.Webcam(320, 320, true);
    await webcam.setup();
    await webcam.play();
    el.webcamHint.hidden = true;
    el.webcamBox.append(webcam.canvas);
    webcamRunning = true;
    el.camStopBtn.disabled = false;
    setCamStatus('Camera on. Predictions update live.', 'success');
    webcamFrame = requestAnimationFrame(webcamLoop);
  } catch (err) {
    cleanupWebcam();
    el.camStartBtn.disabled = false;
    const name = err && err.name;
    let message = err && err.message ? err.message : 'Could not start the camera.';
    if (name === 'NotAllowedError' || name === 'SecurityError') message = 'Camera permission was blocked. Allow camera access in the browser and try again.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') message = 'No camera was found on this device.';
    if (name === 'NotReadableError') message = 'The camera is being used by another app.';
    setCamStatus(message, 'error');
  }
}

async function webcamLoop(timestamp) {
  if (!webcamRunning) return;
  webcam.update();
  if (model && !webcamBusy && timestamp - webcamLast >= WEBCAM_INTERVAL_MS) {
    webcamBusy = true; webcamLast = timestamp;
    try {
      const predictions = await model.predict(webcam.canvas);
      if (webcamRunning) renderResults(predictions, 'Webcam (live)');
    } catch (err) {
      stopWebcam(`Webcam stopped: ${err.message || err}`, 'error');
      return;
    } finally { webcamBusy = false; }
  }
  if (webcamRunning) webcamFrame = requestAnimationFrame(webcamLoop);
}

function cleanupWebcam() {
  webcamRunning = false;
  cancelAnimationFrame(webcamFrame);
  if (webcam) { try { webcam.stop(); } catch (e) { /* ignore */ } if (webcam.canvas && webcam.canvas.parentNode) webcam.canvas.remove(); }
  webcam = null;
  el.webcamHint.hidden = false;
}
function stopWebcam(message = 'Camera is off.', kind = '') {
  cleanupWebcam();
  el.camStartBtn.disabled = false; el.camStopBtn.disabled = true;
  setCamStatus(message, kind);
}

// ---------- Wire up ----------
el.loadBtn.addEventListener('click', loadSelectedModel);
el.modelUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSelectedModel(); });
el.modelVersion.addEventListener('change', onVersionChange);
el.imageInput.addEventListener('change', handleImageSelection);
el.classifyBtn.addEventListener('click', classifySelectedImage);
el.camStartBtn.addEventListener('click', startWebcam);
el.camStopBtn.addEventListener('click', () => stopWebcam());
el.csvBtn.addEventListener('click', downloadCsv);
el.clearLogBtn.addEventListener('click', clearLog);
window.addEventListener('pagehide', () => { if (webcamRunning) stopWebcam(); });

// ---------- Start ----------
(function init() {
  const stored = readStore(KEY_URLS, null);
  if (stored && typeof stored === 'object') savedUrls = { V1: stored.V1 || '', V2: stored.V2 || '' };
  el.modelUrl.value = savedUrls[shownVersion] || '';
  const log = readStore(KEY_LOG, []);
  testLog = Array.isArray(log) ? log.filter((e) => e && typeof e.file === 'string') : [];
  clearResults();
  updateActiveDisplay();
  updateButtons();
  renderLog();
})();
