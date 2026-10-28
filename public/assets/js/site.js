/*!
 * Nearfile shared script
 * Theme toggle, mobile navigation, pinned library loading, drop zones,
 * worker jobs and small UI helpers. Exposes window.Site for the tool scripts.
 */
(() => {
  'use strict';

  const JS_BASE = new URL('.', document.currentScript.src);
  const THEME_KEY = 'nearfile-theme';

  /*
   * Third-party libraries, pinned to exact versions on jsDelivr. jsDelivr serves
   * npm packages byte-for-byte, so each hash below was computed from the npm
   * tarball. The browser refuses to run a file whose hash doesn't match, which
   * means a tampered CDN file can never see anyone's documents.
   */
  const CDN = 'https://cdn.jsdelivr.net/npm/';
  const LIBS = {
    pdfLib: {
      url: CDN + 'pdf-lib@1.17.1/dist/pdf-lib.min.js',
      integrity: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
      global: 'PDFLib',
    },
    jszip: {
      url: CDN + 'jszip@3.10.1/dist/jszip.min.js',
      integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
      global: 'JSZip',
    },
    sortable: {
      url: CDN + 'sortablejs@1.15.6/Sortable.min.js',
      integrity: 'sha384-HZZ/fukV+9G8gwTNjN7zQDG0Sp7MsZy5DDN6VfY3Be7V9dvQpEpR2jF2HlyFUUjU',
      global: 'Sortable',
    },
    pdfjs: {
      url: CDN + 'pdfjs-dist@3.11.174/build/pdf.min.js',
      integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e',
      global: 'pdfjsLib',
    },
    pdfjsWorker: {
      url: CDN + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
      integrity: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2',
    },
  };

  const LIB_ERROR = 'A part of this tool couldn’t load. Check your connection (or allow cdn.jsdelivr.net if a blocker is on), then try again.';

  /* ---------- Libraries ---------- */
  const loading = {};

  /** Loads a library on the main thread and resolves with its global. */
  function loadLib(name) {
    const lib = LIBS[name];
    if (!lib) return Promise.reject(new Error('Unknown library: ' + name));
    if (lib.global && window[lib.global]) return Promise.resolve(window[lib.global]);
    if (!loading[name]) {
      loading[name] = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = lib.url;
        script.integrity = lib.integrity;
        script.crossOrigin = 'anonymous';
        script.referrerPolicy = 'no-referrer';
        script.async = true;
        script.onload = () => resolve(window[lib.global]);
        script.onerror = () => {
          delete loading[name];
          script.remove();
          reject(new Error(LIB_ERROR));
        };
        document.head.append(script);
      });
    }
    return loading[name];
  }

  /**
   * Fetches a library's code once (the browser checks its hash) and keeps it in
   * memory. Workers receive this verified code directly, so once a tool page has
   * loaded it keeps working even if the connection drops.
   */
  const sources = {};
  function libSource(name) {
    const lib = LIBS[name];
    if (!sources[name]) {
      sources[name] = fetch(lib.url, { integrity: lib.integrity, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
        .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.text(); })
        .catch(() => { delete sources[name]; throw new Error(LIB_ERROR); });
    }
    return sources[name];
  }

  /** Starts fetching worker libraries while the page is idle. */
  function warm(names) {
    const run = () => names.forEach((name) => libSource(name).catch(() => {}));
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 600);
  }

  /* ---------- Worker jobs ---------- */

  /**
   * Runs a task in a fresh worker with the named libraries. Returns { promise, cancel }.
   * The worker posts { type: 'progress' | 'done' | 'error' } messages.
   */
  function runJob(task, payload, { libs = [], transfer = [], onProgress, worker: file = 'pdf-worker.js' } = {}) {
    if (location.protocol === 'file:') {
      return {
        promise: Promise.reject(new Error('Open Nearfile through a web server rather than as a local file. The README has a one-line command for this.')),
        cancel() {},
      };
    }
    let worker = null;
    let settled = false;
    let rejectJob;

    const promise = new Promise((resolve, reject) => {
      rejectJob = reject;
      const finish = () => { settled = true; worker?.terminate(); };
      Promise.all(libs.map(async (name) => [name, { ...LIBS[name], code: await libSource(name) }]))
        .then((entries) => {
          if (settled) return;
          worker = new Worker(new URL('workers/' + file, JS_BASE));
          worker.onmessage = ({ data }) => {
            if (data.type === 'progress') onProgress?.(data.value, data.label);
            else if (data.type === 'done') { finish(); resolve(data.result); }
            else if (data.type === 'error') { finish(); reject(new Error(data.message)); }
          };
          worker.onerror = (event) => {
            event.preventDefault();
            finish();
            reject(new Error('Processing stopped unexpectedly. The files may be too large for this device’s memory. Try fewer at a time.'));
          };
          worker.postMessage({ task, payload, libs: Object.fromEntries(entries) }, transfer);
        })
        .catch((err) => { if (!settled) { finish(); reject(err); } });
    });

    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        worker?.terminate();
        rejectJob(new DOMException('Cancelled', 'AbortError'));
      },
    };
  }

  /* ---------- Drop zone ---------- */
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');

  /**
   * Wires a drop zone. Files can be dropped anywhere on the page, chosen with
   * the button, or pasted. Returns { setDisabled(bool), open() }.
   */
  function dropzone(root, { onFiles }) {
    const input = root.querySelector('[data-dz-input]');
    const button = root.querySelector('[data-dz-button]');
    let disabled = false;
    let depth = 0;

    const deliver = (list) => {
      const files = Array.from(list || []);
      if (!disabled && files.length) onFiles(files);
    };
    const open = () => { if (!disabled) input.click(); };

    button.addEventListener('click', (event) => { event.stopPropagation(); open(); });
    root.addEventListener('click', (event) => { if (!event.target.closest('button, a, input')) open(); });
    input.addEventListener('change', () => { deliver(input.files); input.value = ''; });

    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      depth += 1;
      if (!disabled) root.classList.add('is-over');
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) root.classList.remove('is-over');
    });
    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      root.classList.remove('is-over');
      deliver(event.dataTransfer.files);
    });
    document.addEventListener('paste', (event) => {
      if (event.target.closest?.('input, textarea, [contenteditable]')) return;
      const files = event.clipboardData?.files;
      if (files?.length) { event.preventDefault(); deliver(files); }
    });

    return {
      open,
      setDisabled(value) {
        disabled = value;
        root.classList.toggle('is-disabled', value);
        button.disabled = value;
      },
    };
  }

  /* ---------- File helpers ---------- */

  /** Identifies a file by its first bytes rather than its name. */
  async function sniff(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    if (ascii(0, 4) === 'GIF8') return 'gif';
    if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|heim|heis)$/.test(ascii(8, 12))) return 'heic';
    if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'avif';
    if (String.fromCharCode(...bytes).includes('%PDF-')) return 'pdf';
    return null;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes;
    let i = -1;
    do { value /= 1024; i += 1; } while (value >= 1024 && i < units.length - 1);
    return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[i];
  }

  /** File name without extension, safe to use in a download name. */
  function baseName(name) {
    return String(name).replace(/\.[^./\\]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'file';
  }

  /** Adds -2, -3… before the extension until the name is unused. */
  function uniqueName(name, used) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  /** "a.jpg", "a.jpg and b.png", or "a.jpg, b.png and 3 others". */
  function listNames(names) {
    const quoted = names.map((n) => `“${n}”`);
    if (quoted.length === 1) return quoted[0];
    if (quoted.length <= 3) return quoted.slice(0, -1).join(', ') + ' and ' + quoted.at(-1);
    return `${quoted.slice(0, 2).join(', ')} and ${quoted.length - 2} others`;
  }

  /** Keeps track of object URLs so they can be released together. */
  function urlBag() {
    const urls = new Set();
    return {
      add(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; },
      revokeAll() { urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear(); },
    };
  }

  /* ---------- Page ranges ---------- */

  /**
   * Turns "1-3, 5, 8-" into page numbers in the order typed, without repeats.
   * "8-" means page 8 to the end. Throws an Error with a readable message.
   */
  function parsePages(text, pageCount) {
    const cleaned = String(text).replace(/\s*[-\u2013\u2014]\s*/g, '-').trim();
    if (!cleaned) throw new Error('Choose at least one page, for example 1-3, 5.');
    const pages = [];
    const seen = new Set();
    for (const part of cleaned.split(/[\s,;]+/).filter(Boolean)) {
      const range = /^(\d*)-(\d*)$/.exec(part);
      const single = /^\d+$/.exec(part);
      if ((!range && !single) || part === '-') {
        throw new Error(`“${part}” isn’t a page number or range. Use numbers like 1-3, 5.`);
      }
      const from = range ? (range[1] ? Number(range[1]) : 1) : Number(part);
      const to = range ? (range[2] ? Number(range[2]) : pageCount) : from;
      for (const n of [from, to]) {
        if (n < 1 || n > pageCount) {
          throw new Error(`There’s no page ${n}: this PDF has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`);
        }
      }
      const step = from <= to ? 1 : -1;
      for (let n = from; n !== to + step; n += step) {
        if (!seen.has(n)) { seen.add(n); pages.push(n); }
      }
    }
    return pages;
  }

  /** Turns page numbers into the shortest range text: [1,2,3,5] → "1-3, 5". */
  function formatPages(numbers) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length; i += 1) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
      parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
      i = j;
    }
    return parts.join(', ');
  }

  /** Pads page numbers so file names sort correctly: 7 of 120 → "007". */
  const padPage = (n, total) => String(n).padStart(String(total).length, '0');

  /* ---------- UI helpers ---------- */

  /** Shows one message in a live region. Pass a falsy message to clear it. */
  function notify(region, message, kind = 'error') {
    if (!message) { region.replaceChildren(); return; }
    const p = document.createElement('p');
    p.className = 'notice notice--' + kind;
    p.textContent = message;
    region.replaceChildren(p);
  }

  function progressBar(root) {
    const bar = root.querySelector('.progress__bar');
    const track = root.querySelector('.progress__track');
    const label = root.querySelector('[data-progress-label]');
    const pct = root.querySelector('[data-progress-pct]');
    return {
      show() { root.hidden = false; },
      hide() { root.hidden = true; },
      set(value, text) {
        const p = Math.round(Math.max(0, Math.min(1, value)) * 100);
        bar.style.width = p + '%';
        track.setAttribute('aria-valuenow', String(p));
        pct.textContent = p + '%';
        if (text) label.textContent = text;
      },
    };
  }

  /** A download link for bytes made in a worker. */
  function downloadLink(bag, file, { label, className = 'btn btn--primary btn--large btn--block', icon = true } = {}) {
    const a = document.createElement('a');
    a.className = className;
    a.href = bag.add(file.blob || new Blob([file.bytes], { type: file.type }));
    a.download = file.name;
    if (icon) a.innerHTML = ICON_DOWNLOAD;
    a.append(label ?? file.name);
    return a;
  }

  /** A scrollable list of individual downloads with sizes. */
  function downloadList(bag, files, label) {
    const list = document.createElement('ul');
    list.className = 'result__files';
    list.setAttribute('aria-label', label);
    for (const file of files) {
      const li = document.createElement('li');
      const a = downloadLink(bag, file, { className: '', label: '' });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = file.name;
      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatBytes(file.blob ? file.blob.size : file.bytes.byteLength);
      a.append(name, size);
      li.append(a);
      list.append(li);
    }
    return list;
  }

  const ICON_DOWNLOAD = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';

  /** Detects PDFs locked with a password or permissions (pdf-lib can't edit those). */
  async function isEncryptedPdf(file) {
    const size = file.size;
    const chunks = [file.slice(0, 65536), file.slice(Math.max(0, size - 65536))];
    for (const chunk of chunks) {
      const text = new TextDecoder('latin1').decode(await chunk.arrayBuffer());
      if (/\/Encrypt\b/.test(text)) return true;
    }
    return false;
  }

  const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Page chrome ---------- */
  function initTheme() {
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const current = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
    const sync = () => button.setAttribute('aria-pressed', String(current() === 'dark'));
    button.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      sync();
    });
    media.addEventListener?.('change', sync);
    sync();
  }

  function initNav() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const nav = document.getElementById('site-nav');
    if (!toggle || !nav) return;
    const set = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    };
    toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.classList.contains('is-open')) { set(false); toggle.focus(); }
    });
    document.addEventListener('click', (event) => {
      if (nav.classList.contains('is-open') && !nav.contains(event.target) && !toggle.contains(event.target)) set(false);
    });
  }

  initTheme();
  initNav();

  window.Site = Object.freeze({
    LIBS,
    loadLib,
    libSource,
    warm,
    runJob,
    dropzone,
    sniff,
    formatBytes,
    baseName,
    uniqueName,
    listNames,
    urlBag,
    notify,
    progressBar,
    prefersReducedMotion,
    parsePages,
    formatPages,
    padPage,
    downloadLink,
    downloadList,
    isEncryptedPdf,
  });
})();
