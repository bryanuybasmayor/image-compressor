/* =============================================================================
 * DriveSqueeze — app.js
 *
 * A 100% client-side SPA that:
 *   1. authenticates with Google (Google Identity Services, token model),
 *   2. compresses images locally with browser-image-compression,
 *   3. uploads the compressed blobs straight to Google Drive v3 (multipart),
 * so the user never has to download a file to their machine first.
 *
 * There is no backend, no build step and no bundler. Everything here runs
 * straight from GitHub Pages.
 * ========================================================================== */

/* ============================================================================
 * ██  1. CONFIGURATION — 👉 THIS IS THE ONLY BLOCK YOU NEED TO EDIT 👈
 * ==========================================================================*/

const CONFIG = {
  /* -------------------------------------------------------------------------
   * (a) YOUR_CLIENT_ID
   *
   * Google Cloud Console → APIs & Services → Credentials →
   * "Create credentials" → "OAuth client ID" → Application type: Web application.
   *
   * Then, in the same dialog:
   *   • Authorized JavaScript origins  →  https://YOUR-USER.github.io
   *     (for local testing also add: http://localhost:8000 and http://127.0.0.1:8000)
   *   • Authorized redirect URIs       →  not required for the popup token flow.
   *
   * Paste the generated value below, keeping the .apps.googleusercontent.com suffix.
   * ---------------------------------------------------------------------- */
  CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',

  /* -------------------------------------------------------------------------
   * (b) YOUR_API_KEY
   *
   * Same Credentials page → "Create credentials" → "API key".
   * The Drive API accepts ?key=... for public/unauthenticated reads; it is not
   * strictly required for an authenticated upload, but it is harmless and is
   * what Google's own samples include, so we send it when it is filled in.
   * Leave it as '' to omit the param entirely.
   * ---------------------------------------------------------------------- */
  API_KEY: 'YOUR_API_KEY',

  /* -------------------------------------------------------------------------
   * (c) OAUTH SCOPE
   *
   * drive.file  → least privilege. The app may only see files IT created.
   *               With this scope, uploading into a pasted folder ID only works
   *               if the app can already access that folder (e.g. it created it).
   *               Expect HTTP 404 on arbitrary folders.
   * drive       → full access to everything in the user's Drive. Required if you
   *               want the "paste any folder ID" feature to work reliably.
   *               This is a *restricted* scope: a public app needs Google
   *               verification to use it. Fine for personal/internal use.
   *
   * If a folder upload fails with 403/404, that is almost always this setting.
   * ---------------------------------------------------------------------- */
  SCOPE: 'https://www.googleapis.com/auth/drive.file',

  /* -------------------------------------------------------------------------
   * (d) COMPRESSION DEFAULTS — forwarded verbatim to browser-image-compression.
   * ---------------------------------------------------------------------- */
  COMPRESSION: {
    maxSizeMB: 1,             // Try to get each file under 1 MB.
    maxWidthOrHeight: 1920,   // Longest edge capped at 1920px (Full HD).
    useWebWorker: true,       // Compress off the main thread so the UI stays live.
    initialQuality: 0.82,     // Starting JPEG/WebP quality before size iteration.
    // fileType: 'image/webp', // ← Uncomment to force WebP output. Smaller files,
    //                         //    but transparent PNGs stay transparent only in
    //                         //    WebP/PNG, and the file EXTENSION will still be
    //                         //    the original one (see note in uploadItem()).
  },

  /* -------------------------------------------------------------------------
   * (e) DRIVE UPLOAD ENDPOINT
   * ---------------------------------------------------------------------- */
  UPLOAD_URL: 'https://www.googleapis.com/upload/drive/v3/files',
  SUPPORTS_ALL_DRIVES: true,  // Enables uploading into Shared Drives too.
  UPLOAD_FIELDS: 'id,name,mimeType,size,webViewLink',

  /* -------------------------------------------------------------------------
   * (f) TOKEN CACHE
   * Google's client-side access tokens live for 3600s. We treat a token as
   * expired a minute early so an upload can never start with a token that dies
   * mid-flight.
   * ---------------------------------------------------------------------- */
  TOKEN_STORAGE_KEY: 'drivesqueeze.token.v1',
  TOKEN_SAFETY_MARGIN_MS: 60 * 1000,

  /* Local file types we accept. */
  ACCEPTED_TYPES: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
};

/* ============================================================================
 * 2. DOM SHORTCUTS + RUNTIME STATE
 * ==========================================================================*/

const $ = (id) => document.getElementById(id);

const dom = {
  // Views
  signinView: $('signin-view'),
  appView: $('app-view'),
  // Auth
  signinBtn: $('signin-btn'),
  signoutBtn: $('signout-btn'),
  signinError: $('signin-error'),
  tokenExpiry: $('token-expiry'),
  // Inputs
  folderInput: $('folder-id'),
  folderWarning: $('folder-warning'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  // Queue
  queueCard: $('queue-card'),
  queueCount: $('queue-count'),
  queueEmpty: $('queue-empty'),
  fileList: $('file-list'),
  clearBtn: $('clear-btn'),
  selectionWarning: $('selection-warning'),
  // Action
  runBtn: $('run-btn'),
  statusText: $('status-text'),
  globalBarWrap: $('global-bar-wrap'),
  globalBar: $('global-bar'),
  // Footer
  configWarning: $('config-warning'),
};

/**
 * The single source of truth for the UI.
 * `items` are queue entries created by addFiles().
 */
const state = {
  accessToken: null,       // In-memory copy of the cached token.
  tokenExpiresAt: 0,       // Epoch ms, mirrors the value in localStorage.
  items: [],               // [{ id, file, status, ... }]
  running: false,
  nextId: 1,
};

/* ============================================================================
 * 3. SMALL UTILITIES
 * ==========================================================================*/

/** Human-readable byte size: 1536 -> "1.5 KB". */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Readable countdown until a token dies, e.g. "expires in 43 min". */
function formatCountdown(expiresAt) {
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return 'expired';
  const mins = Math.round(msLeft / 60000);
  if (mins >= 1) return `token valid for ~${mins} min`;
  return `token valid for <1 min`;
}

/** True when the client ID is still the placeholder. */
function isPlaceholder(value) {
  return !value || /^YOUR_/.test(value) || value.includes('YOUR_CLIENT_ID') || value.includes('YOUR_API_KEY');
}

/**
 * Waits for the async-loaded Google Identity Services script to define
 * `window.google.accounts.oauth2`. Resolves immediately if it is already there.
 */
function waitForGoogle(timeoutMs = 10000) {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error(
          'Google Identity Services failed to load. Check your network connection ' +
          'or any content blocker, then reload the page.'
        ));
      }
    }, 100);
  });
}

/** An error that means "the token is no longer usable" — triggers re-sign-in. */
class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

/* ============================================================================
 * 4. AUTHENTICATION + TOKEN CACHING
 * ============================================================================
 *
 * How the caching works, end to end:
 *
 *   page load
 *     └─ readToken()      → localStorage["drivesqueeze.token.v1"]
 *          ├─ missing                     → show sign-in view
 *          ├─ expires_at in the past      → wipe it, show sign-in view
 *          └─ still valid (>60s of life)  → go straight to the app view
 *
 *   user clicks "Sign in with Google"
 *     └─ Google returns { access_token, expires_in, scope }
 *          └─ saveToken() writes { access_token, expires_at } to localStorage
 *
 *   any Drive call returns HTTP 401
 *     └─ clearToken() + return to the sign-in view
 *
 * SECURITY NOTE: localStorage is readable by any script on this origin. That is
 * acceptable here because the token is a short-lived, scope-limited OAuth token
 * that only exists while the user is actively using the page — but it is the
 * reason you should keep this app on its own origin (its own GitHub Pages site).
 * ==========================================================================*/

const tokenStore = {
  /** Persist a token + absolute expiry. */
  save(accessToken, expiresInSeconds) {
    const expiresAt = Date.now() + (Number(expiresInSeconds) || 3600) * 1000;
    try {
      localStorage.setItem(CONFIG.TOKEN_STORAGE_KEY, JSON.stringify({
        access_token: accessToken,
        expires_at: expiresAt,
        scope: CONFIG.SCOPE,
      }));
    } catch (err) {
      // Safari private mode / storage disabled: degrade to session-only auth.
      console.warn('[DriveSqueeze] Could not cache token in localStorage:', err);
    }
    return expiresAt;
  },

  /** Return { accessToken, expiresAt } when a still-usable token exists, else null. */
  load() {
    let raw;
    try {
      raw = localStorage.getItem(CONFIG.TOKEN_STORAGE_KEY);
    } catch {
      return null; // Storage unavailable — user simply has to sign in each visit.
    }
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
      return null;
    }

    const stillValid =
      parsed?.access_token &&
      Number.isFinite(parsed.expires_at) &&
      parsed.expires_at - CONFIG.TOKEN_SAFETY_MARGIN_MS > Date.now();

    if (!stillValid) {
      // Expired or malformed → clear it so the user gets a clean sign-in.
      localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
      return null;
    }
    return { accessToken: parsed.access_token, expiresAt: parsed.expires_at };
  },

  clear() {
    try {
      localStorage.removeItem(CONFIG.TOKEN_STORAGE_KEY);
    } catch { /* nothing we can do */ }
  },
};

/**
 * The GIS token client is created once and reused. Its callback is fixed at
 * construction time, so pending requests are routed through `tokenRequest`
 * rather than by building a new client per click.
 */
let tokenClient = null;
let tokenRequest = null; // { resolve, reject } for the in-flight sign-in

function getTokenClient() {
  if (tokenClient) return tokenClient;

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,

    /** Called with the token response on success (or with `error` on failure). */
    callback: (response) => {
      const pending = tokenRequest;
      tokenRequest = null;
      if (!pending) return;

      if (response?.error) {
        pending.reject(new Error(response.error_description || response.error));
        return;
      }

      // Cache it: this is the one and only place a token is persisted.
      state.tokenExpiresAt = tokenStore.save(response.access_token, response.expires_in);
      state.accessToken = response.access_token;
      pending.resolve(response.access_token);
    },

    /**
     * Fires when the popup is closed or blocked. Most commonly seen when
     * requestAccessToken() is called without a user gesture (popup blocked) or
     * the origin is not registered as an Authorized JavaScript origin.
     */
    error_callback: (err) => {
      const pending = tokenRequest;
      tokenRequest = null;
      if (pending) pending.reject(new Error(err?.message || 'Google sign-in was cancelled.'));
    },
  });

  return tokenClient;
}

/**
 * Opens the Google account popup and resolves with a fresh access token.
 * Must be called from a user gesture (a click) or the browser blocks it.
 *
 * Swap `prompt: ''` for `prompt: 'select_account'` to always show the account
 * chooser, or `prompt: 'consent'` to always show the consent screen.
 */
async function signIn() {
  if (isPlaceholder(CONFIG.CLIENT_ID)) {
    throw new Error(
      'No OAuth client ID configured. Open app.js and set CONFIG.CLIENT_ID to your ' +
      'Google Cloud "OAuth client ID" value (it ends in .apps.googleusercontent.com).'
    );
  }
  await waitForGoogle();

  return new Promise((resolve, reject) => {
    tokenRequest = { resolve, reject };
    try {
      getTokenClient().requestAccessToken({ prompt: '' });
    } catch (err) {
      tokenRequest = null;
      reject(err);
    }
  });
}

/** Signs the user out locally and, best effort, revokes the token at Google. */
function signOut() {
  const token = state.accessToken || tokenStore.load()?.accessToken;
  if (token && window.google?.accounts?.oauth2) {
    // revoke() invalidates the token server-side; failures are non-fatal.
    try {
      google.accounts.oauth2.revoke(token, () => {});
    } catch { /* ignore */ }
  }
  tokenStore.clear();
  state.accessToken = null;
  state.tokenExpiresAt = 0;
  showSignInView();
}

/* ============================================================================
 * 5. VIEW SWITCHING
 * ==========================================================================*/

function showSignInView(message) {
  dom.signinView.classList.remove('hidden');
  dom.appView.classList.add('hidden');
  setSigninError(message || '');
}

function showAppView() {
  dom.signinView.classList.add('hidden');
  dom.appView.classList.remove('hidden');
  dom.tokenExpiry.textContent = `· ${formatCountdown(state.tokenExpiresAt)}`;
  refreshRunButton();
}

function setSigninError(message) {
  dom.signinError.textContent = message || '';
  dom.signinError.classList.toggle('hidden', !message);
}

/* ============================================================================
 * 6. FILE QUEUE
 * ==========================================================================*/

const STATUS_LABELS = {
  queued: 'Ready',
  compressing: 'Compressing…',
  uploading: 'Uploading…',
  done: 'Uploaded',
  error: 'Failed',
};

/** Adds File objects to the queue, rejecting anything that is not an image. */
function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const rejected = [];

  for (const file of files) {
    // Some browsers report an empty type for e.g. a .png dragged from a broken
    // source; fall back to the extension check.
    const looksLikeImage =
      CONFIG.ACCEPTED_TYPES.includes(file.type) ||
      file.type.startsWith('image/') ||
      /\.(png|jpe?g|webp)$/i.test(file.name);

    if (!looksLikeImage) {
      rejected.push(file.name);
      continue;
    }

    const item = {
      id: state.nextId++,
      file,
      originalSize: file.size,
      compressedSize: null,
      status: 'queued',
      message: '',
      keptOriginal: false,
      progress: 0,
      uploadedUrl: null,
      el: null,
    };
    state.items.push(item);
    createRow(item);
  }

  if (rejected.length) {
    setSelectionWarning(
      `Skipped ${rejected.length} file${rejected.length > 1 ? 's' : ''} that ` +
      `${rejected.length > 1 ? 'are' : 'is'} not a supported image: ${rejected.join(', ')}`
    );
  } else {
    setSelectionWarning('');
  }

  renderQueueMeta();
}

function setSelectionWarning(message) {
  dom.selectionWarning.textContent = message;
  dom.selectionWarning.classList.toggle('hidden', !message);
}

function setFolderWarning(message) {
  dom.folderWarning.textContent = message;
  dom.folderWarning.classList.toggle('hidden', !message);
}

/** Builds the <li> for one queue item and stores element refs on the item. */
function createRow(item) {
  const li = document.createElement('li');
  li.className = 'file-row';

  // Local object URL as a thumbnail — never uploaded anywhere.
  const thumb = document.createElement('img');
  thumb.className = 'file-row__thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  const objectUrl = URL.createObjectURL(item.file);
  thumb.src = objectUrl;
  thumb.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true });

  const body = document.createElement('div');
  body.className = 'file-row__body';

  const name = document.createElement('span');
  name.className = 'file-row__name';
  name.textContent = item.file.name;
  name.title = item.file.name;

  const meta = document.createElement('span');
  meta.className = 'file-row__meta';
  const sizeEl = document.createElement('span');
  sizeEl.textContent = formatBytes(item.originalSize);
  const statusEl = document.createElement('span');
  meta.append(sizeEl, statusEl);

  const barWrap = document.createElement('div');
  barWrap.className = 'bar';
  barWrap.setAttribute('role', 'progressbar');
  barWrap.setAttribute('aria-valuemin', '0');
  barWrap.setAttribute('aria-valuemax', '100');
  const barFill = document.createElement('div');
  barFill.className = 'bar__fill';
  barWrap.append(barFill);

  body.append(name, meta, barWrap);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'file-row__remove';
  removeBtn.title = 'Remove from queue';
  removeBtn.setAttribute('aria-label', `Remove ${item.file.name} from queue`);
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => removeItem(item.id));

  li.append(thumb, body, removeBtn);
  dom.fileList.append(li);

  item.el = { li, sizeEl, statusEl, barWrap, barFill, removeBtn };
  renderItem(item);
}

/** Pushes one item's state into the DOM. */
function renderItem(item) {
  const { sizeEl, statusEl, barWrap, barFill } = item.el;

  // Left-hand size text: "1.4 MB → 210 KB" once compressed, or a note that the
  // original bytes were sent because re-encoding would have enlarged the file.
  if (item.compressedSize != null && item.keptOriginal) {
    sizeEl.innerHTML = `${formatBytes(item.originalSize)} <span class="muted">· already optimal, original sent</span>`;
  } else if (item.compressedSize != null) {
    const saved = item.originalSize - item.compressedSize;
    const pct = item.originalSize > 0 ? Math.round((saved / item.originalSize) * 100) : 0;
    const savingsText = pct > 0 ? ` (−${pct}%)` : '';
    sizeEl.innerHTML =
      `${formatBytes(item.originalSize)} → ` +
      `<span class="savings">${formatBytes(item.compressedSize)}${savingsText}</span>`;
  } else {
    sizeEl.textContent = formatBytes(item.originalSize);
  }

  statusEl.textContent = item.message || STATUS_LABELS[item.status] || item.status;
  statusEl.className = item.status === 'error' ? 'row-error' : '';

  // progress === null means "no measurable progress" -> indeterminate shimmer
  // (used during fetch uploads, which cannot report byte-level progress).
  if (item.progress === null && item.status === 'uploading') {
    barWrap.dataset.state = 'indeterminate';
    barFill.style.width = '35%';
    barWrap.removeAttribute('aria-valuenow');
  } else {
    barWrap.dataset.state = item.status === 'done' ? 'done'
      : item.status === 'error' ? 'error'
      : 'normal';
    const pct = Math.max(0, Math.min(100, item.progress || (item.status === 'done' ? 100 : 0)));
    barFill.style.width = `${pct}%`;
    barWrap.setAttribute('aria-valuenow', String(pct));
  }

  if (item.uploadedUrl && item.status === 'done') {
    statusEl.className = '';
    statusEl.innerHTML = `Uploaded · <a href="${item.uploadedUrl}" target="_blank" rel="noopener">open in Drive</a>`;
  }
}

/** Removes one entry from the queue (disabled while a batch is running). */
function removeItem(id) {
  if (state.running) return;
  const index = state.items.findIndex((i) => i.id === id);
  if (index === -1) return;
  state.items[index].el.li.remove();
  state.items.splice(index, 1);
  renderQueueMeta();
}

function clearQueue() {
  if (state.running) return;
  for (const item of state.items) item.el.li.remove();
  state.items = [];
  renderQueueMeta();
  setGlobalStatus('Idle.', 0);
}

function renderQueueMeta() {
  dom.queueCount.textContent = String(state.items.length);
  dom.queueEmpty.classList.toggle('hidden', state.items.length > 0);
  dom.clearBtn.disabled = state.items.length === 0 || state.running;
  refreshRunButton();
}

function refreshRunButton() {
  const hasToken = Boolean(state.accessToken);
  const hasFiles = state.items.length > 0;
  dom.runBtn.disabled = !hasToken || !hasFiles || state.running;
  dom.runBtn.textContent = state.running ? 'Working…' : 'Compress & upload';
}

function setGlobalStatus(text, percent) {
  dom.statusText.textContent = text;
  const pct = Math.max(0, Math.min(100, percent || 0));
  dom.globalBar.style.width = `${pct}%`;
  dom.globalBarWrap.setAttribute('aria-valuenow', String(Math.round(pct)));
}

/* ============================================================================
 * 7. LOCAL IMAGE COMPRESSION
 * ==========================================================================
 * browser-image-compression decodes the image, resizes it on a canvas and
 * re-encodes it, iterating on quality until the result fits `maxSizeMB`.
 * With useWebWorker:true that work happens off the main thread, so the queue's
 * progress bars keep animating while several files are compressed.
 * ==========================================================================*/

async function compressImage(file, onProgress) {
  if (typeof window.imageCompression !== 'function') {
    throw new Error(
      'The compression library did not load. If you are offline or behind a ' +
      'blocker, vendor browser-image-compression locally and update index.html.'
    );
  }

  return window.imageCompression(file, {
    ...CONFIG.COMPRESSION,
    // Docs say this always fires once at 100 — ignore it so the bar does not
    // jump to the end before the real work is finished.
    onProgress: (percent) => onProgress?.(percent),
  });
}

/* ============================================================================
 * 8. DIRECT GOOGLE DRIVE UPLOAD (REST v3, multipart)
 * ==========================================================================
 * The multipart/related upload sends exactly two parts in one request:
 *
 *   POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
 *   Authorization: Bearer <access_token>
 *   Content-Type: multipart/related; boundary=...   (set automatically)
 *
 *   --boundary
 *   Content-Type: application/json; charset=UTF-8
 *
 *   {"name":"photo.jpg","parents":["<folderId>"]}
 *   --boundary
 *   Content-Type: image/jpeg
 *
 *   <raw binary bytes>
 *   --boundary--
 *
 * We build those two parts with FormData. The browser picks the boundary and
 * sets the Content-Type header itself, so we must NOT set Content-Type by hand —
 * doing so would strip the boundary and Drive would reject the request.
 * ==========================================================================*/

async function uploadToDrive(blob, fileName, folderId, accessToken) {
  // ---- Part 1: file metadata -------------------------------------------
  const metadata = { name: fileName };
  // A blank folder ID means "put it in My Drive root": the Drive API defaults
  // to the root when `parents` is omitted, which is what we want.
  if (folderId) metadata.parents = [folderId];

  const form = new FormData();
  form.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json; charset=UTF-8' })
  );

  // ---- Part 2: the compressed bytes ------------------------------------
  // The third argument forces a correct filename in the multipart part header.
  form.append('file', blob, fileName);

  // ---- Build the URL ---------------------------------------------------
  const url = new URL(CONFIG.UPLOAD_URL);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('fields', CONFIG.UPLOAD_FIELDS);
  if (CONFIG.SUPPORTS_ALL_DRIVES) url.searchParams.set('supportsAllDrives', 'true');
  if (!isPlaceholder(CONFIG.API_KEY) && CONFIG.API_KEY) {
    url.searchParams.set('key', CONFIG.API_KEY);
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      // Only the auth header — FormData supplies its own Content-Type + boundary.
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    // Keep the status code on the error: runBatch() keys its mid-batch
    // re-auth behaviour off `err.status === 401`.
    throw new DriveError(await describeDriveFailure(response, folderId), response.status);
  }

  return response.json(); // { id, name, mimeType, size, webViewLink }
}

/** Wraps a non-OK Drive response in a message a human can act on. */
class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

async function describeDriveFailure(response, folderId) {
  const status = response.status;

  // Try to surface Google's own message — it is usually the most precise.
  let apiMessage = '';
  try {
    const body = await response.json();
    apiMessage = body?.error?.message || '';
  } catch { /* response was not JSON (e.g. an HTML error page) */ }

  const detail = apiMessage ? ` Google said: “${apiMessage}”.` : '';

  if (status === 401) return `Access token rejected (401).${detail}`; // → re-auth path
  if (status === 403) {
    return (
      `Permission denied (403).${detail} If the token has expired, sign in again. ` +
      `Otherwise the OAuth scope in your token is not allowed to write here — the ` +
      `narrow "drive.file" scope cannot see folders the app did not create.`
    );
  }
  if (status === 404) {
    return (
      `Folder not found (404).${detail} Check the folder ID${folderId ? ` “${folderId}”` : ''}; ` +
      `a drive.file-scoped token also 404s on folders it was never granted access to. ` +
      `Grant the broader scope ("https://www.googleapis.com/auth/drive") in app.js if needed.`
    );
  }
  if (status === 429) {
    return `Rate limited by Google (429).${detail} Wait a moment and retry the batch.`;
  }
  if (status >= 500) {
    return `Google Drive had a server error (${status}).${detail} Retrying usually works.`;
  }
  return `Upload failed with HTTP ${status}.${detail}`;
}

/* ============================================================================
 * 9. THE BATCH PIPELINE
 * ==========================================================================
 * Files are processed SEQUENTIALLY rather than with Promise.all: a queue of 40
 * 20-megapixel photos compressed in parallel would exhaust memory on a laptop
 * and hammer the Drive API's per-user rate limit. Sequential also gives the
 * status line ("Compressing 3 of 12…") a meaningful meaning.
 * ==========================================================================*/

async function runBatch() {
  if (state.running) return;

  // --- Guard rails ------------------------------------------------------
  if (!state.accessToken || state.tokenExpiresAt - CONFIG.TOKEN_SAFETY_MARGIN_MS < Date.now()) {
    handleAuthFailure('Your session expired. Please sign in again.');
    return;
  }
  if (!state.items.length) return;

  // A blank folder ID silently becomes the Drive root (see uploadToDrive).
  const folderId = dom.folderInput.value.trim();

  state.running = true;
  refreshRunButton();
  dom.clearBtn.disabled = true;
  dom.folderInput.disabled = true;

  const pending = state.items.filter((item) => item.status !== 'done');
  const total = pending.length;
  let succeeded = 0;
  let failed = 0;

  try {
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const position = index + 1;

      // ---------------- Compression ----------------
      setGlobalStatus(`Compressing ${position} of ${total}: ${item.file.name}`, (index / total) * 100);
      item.status = 'compressing';
      item.progress = 0;
      item.message = '';
      renderItem(item);

      let compressed;
      try {
        compressed = await compressImage(item.file, (percent) => {
          item.progress = percent;
          renderItem(item);
        });
      } catch (err) {
        markFailed(item, `Compression failed: ${err.message}`);
        failed += 1;
        renderItem(item);
        continue;
      }

      // Re-encoding is not guaranteed to shrink a file: PNG is lossless, so a
      // photo-heavy PNG can come back LARGER after the library re-encodes it.
      // A compressor that inflates uploads is useless, so when compression does
      // not help we send the original bytes through untouched.
      const madeItSmaller = compressed.size < item.file.size;
      const payload = madeItSmaller ? compressed : item.file;
      item.keptOriginal = !madeItSmaller;

      // browser-image-compression returns a File whose name matches the input.
      // We deliberately keep the ORIGINAL name on upload (as specified) — so if
      // you enable fileType: 'image/webp' above, the bytes may be WebP while the
      // extension still says .png/.jpg. Rename here if that bothers you.
      const uploadName = item.file.name;
      item.compressedSize = payload.size;
      renderItem(item);

      // ---------------- Upload ----------------
      setGlobalStatus(`Uploading ${position} of ${total}: ${uploadName}`, (index / total) * 100);
      item.status = 'uploading';
      item.progress = null; // fetch() cannot report upload progress
      renderItem(item);

      try {
        const result = await uploadToDrive(payload, uploadName, folderId, state.accessToken);
        item.status = 'done';
        item.progress = 100;
        item.uploadedUrl = result.webViewLink || null;
        succeeded += 1;
      } catch (err) {
        // A 401 means the token died mid-batch: stop and ask for a new one
        // rather than firing off the rest of the queue to fail.
        if (err instanceof DriveError && err.status === 401) {
          markFailed(item, 'Upload rejected: token expired.');
          renderItem(item);
          handleAuthFailure('Your Google session expired during upload. Please sign in again.');
          return;
        }
        markFailed(item, err.message);
        failed += 1;
      }
      renderItem(item);
      setGlobalStatus(
        `Uploaded ${succeeded} of ${total}…`,
        ((index + 1) / total) * 100
      );
    }
  } finally {
    state.running = false;
    dom.folderInput.disabled = false;
    refreshRunButton();
    renderQueueMeta();
  }

  // ---------------- Summary ----------------
  const bytesIn = pending.reduce((sum, i) => sum + i.originalSize, 0);
  const bytesOut = pending.reduce((sum, i) => sum + (i.compressedSize ?? i.originalSize), 0);
  const saved = bytesIn - bytesOut;
  const savedPct = bytesIn > 0 ? Math.round((saved / bytesIn) * 100) : 0;

  const destination = folderId ? 'the selected folder' : 'your Drive root';
  const parts = [`Done — ${succeeded} of ${total} uploaded to ${destination}`];
  if (saved > 0) parts.push(`${formatBytes(saved)} saved (${savedPct}%)`);
  if (failed > 0) parts.push(`${failed} failed`);

  setGlobalStatus(parts.join(' · '), 100);
}

function markFailed(item, message) {
  item.status = 'error';
  item.progress = 100;
  item.message = message;
}

/** Token is unusable: wipe the cache and send the user back to sign-in. */
function handleAuthFailure(message) {
  tokenStore.clear();
  state.accessToken = null;
  state.tokenExpiresAt = 0;
  state.running = false;
  // Leave no half-finished "Uploading 2 of 2…" behind for the next session.
  setGlobalStatus('Stopped — sign in again to continue.', 0);
  refreshRunButton();
  renderQueueMeta();
  showSignInView(message);
}

/* ============================================================================
 * 10. EVENT WIRING
 * ==========================================================================*/

function bindEvents() {
  // ---- Sign in / out ----
  dom.signinBtn.addEventListener('click', async () => {
    setSigninError('');
    dom.signinBtn.disabled = true;
    const originalLabel = dom.signinBtn.innerHTML;
    dom.signinBtn.textContent = 'Signing in…';
    try {
      await signIn();
      showAppView();
    } catch (err) {
      setSigninError(err.message || 'Sign-in failed.');
    } finally {
      dom.signinBtn.disabled = false;
      dom.signinBtn.innerHTML = originalLabel;
    }
  });

  dom.signoutBtn.addEventListener('click', signOut);

  // ---- Drop zone: click, keyboard, drag & drop ----
  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dom.fileInput.click();
    }
  });

  dom.fileInput.addEventListener('change', () => {
    addFiles(dom.fileInput.files);
    // Reset so re-picking the same file still fires `change`.
    dom.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dom.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dom.dropzone.classList.add('is-dragover');
    });
  });
  ['dragleave', 'dragend'].forEach((type) => {
    dom.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dom.dropzone.classList.remove('is-dragover');
    });
  });
  dom.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dom.dropzone.classList.remove('is-dragover');
    addFiles(event.dataTransfer?.files);
  });

  // Stop the browser from navigating away when a file is dropped outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ---- Queue + run ----
  dom.clearBtn.addEventListener('click', clearQueue);
  dom.runBtn.addEventListener('click', runBatch);

  // ---- Folder ID sanity check while typing ----
  dom.folderInput.addEventListener('input', () => {
    const value = dom.folderInput.value.trim();
    // Accept a full Drive URL by extracting the ID — saves the user a copy/paste
    // dance and is the single most common mistake here.
    if (/^https?:\/\//i.test(value)) {
      const match = value.match(/\/folders\/([-\w]{10,})/) || value.match(/[?&]id=([-\w]{10,})/);
      if (match) {
        dom.folderInput.value = match[1];
        setFolderWarning('');
        return;
      }
    }
    // Drive IDs only ever contain these characters.
    if (value && !/^[-\w]{10,}$/.test(value)) {
      setFolderWarning('That does not look like a Drive folder ID (or a folder URL).');
    } else {
      setFolderWarning('');
    }
  });
}

/* ============================================================================
 * 11. BOOTSTRAP
 * ==========================================================================*/

function boot() {
  bindEvents();
  renderQueueMeta();

  // Warn loudly (but keep working) if the credentials were never filled in.
  if (isPlaceholder(CONFIG.CLIENT_ID)) {
    dom.configWarning.textContent =
      'Setup required: open app.js and replace CONFIG.CLIENT_ID (and optionally ' +
      'CONFIG.API_KEY) with your Google Cloud credentials, then add this site to ' +
      'the client\'s "Authorized JavaScript origins".';
    dom.configWarning.classList.remove('hidden');
  }

  // ---- Token cache check on page load ---------------------------------
  // Valid token in localStorage → skip the login screen entirely.
  // Missing/expired token → the cache is wiped above and sign-in is shown.
  const cached = tokenStore.load();
  if (cached) {
    state.accessToken = cached.accessToken;
    state.tokenExpiresAt = cached.expiresAt;
    showAppView();
  } else {
    showSignInView();
  }
}

document.addEventListener('DOMContentLoaded', boot);
