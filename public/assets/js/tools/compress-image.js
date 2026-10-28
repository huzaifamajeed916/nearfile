/*!
 * Nearfile — Compress image
 * Re-encodes images with the Canvas API in a worker (OffscreenCanvas), or on the
 * page in browsers without it. Settings apply to every image and update live.
 */
(() => {
  'use strict';

  const MAX_FILES = 30;
  const MAX_PIXELS_PAGE = 16_000_000; // iOS Safari canvas limit, for the on-page fallback
  const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const ICON = {
    x: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
  };
  const workerSupported = typeof OffscreenCanvas === 'function'
    && typeof OffscreenCanvas.prototype.convertToBlob === 'function'
    && typeof createImageBitmap === 'function';

  const $ = (selector) => document.querySelector(selector);
  const els = {
    workspace: $('[data-workspace]'),
    dropzone: $('[data-dropzone]'),
    dzTitle: $('[data-dz-title]'),
    notices: $('[data-notices]'),
    filesBar: $('[data-files-bar]'),
    count: $('[data-count]'),
    clear: $('[data-clear]'),
    list: $('[data-list]'),
    panel: $('[data-panel]'),
    form: $('[data-options]'),
    quality: $('[data-quality]'),
    qualityValue: $('[data-quality-value]'),
    totals: $('[data-totals]'),
    totalSizes: $('[data-total-sizes]'),
    totalSaving: $('[data-total-saving]'),
    downloads: $('[data-downloads]'),
    dialog: $('[data-compare]'),
    compareTitle: $('[data-compare-title]'),
    compareImg: $('[data-compare-img]'),
    compareSizes: $('[data-compare-sizes]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const zipUrls = Site.urlBag();

  let items = []; // { id, file, name, size, type, url, out: { blob, url, size, type, kept, key } | null }
  let nextId = 1;
  let job = null;
  let generation = 0;
  let timer = 0;
  let queue = Promise.resolve();
  let comparing = null;

  const zone = Site.dropzone(els.dropzone, {
    onFiles: (files) => { queue = queue.then(() => addFiles(files)); },
  });

  /* ---------- Adding files ---------- */

  async function addFiles(files) {
    Site.notify(els.notices, null);
    const room = MAX_FILES - items.length;
    if (room <= 0) {
      Site.notify(els.notices, `You’ve reached the limit of ${MAX_FILES} images. Remove some to add others.`);
      return;
    }
    const unsupported = [];
    let skipped = 0;
    let added = 0;
    for (const file of files) {
      const kind = await Site.sniff(file);
      if (!TYPES[kind]) { unsupported.push(file.name); continue; }
      if (added >= room) { skipped += 1; continue; }
      items.push({ id: nextId++, file, name: file.name, size: file.size, type: TYPES[kind], url: URL.createObjectURL(file), out: null });
      added += 1;
    }
    const messages = [];
    if (unsupported.length) messages.push(`${Site.listNames(unsupported)} ${unsupported.length === 1 ? 'isn’t' : 'aren’t'} a JPG, PNG or WebP image, so ${unsupported.length === 1 ? 'it was' : 'they were'} left out.`);
    if (skipped) messages.push(`${skipped} ${skipped === 1 ? 'image was' : 'images were'} left out: the limit is ${MAX_FILES} at a time.`);
    if (messages.length) Site.notify(els.notices, messages.join(' '), added ? 'info' : 'error');
    if (added) {
      render();
      schedule(0);
    }
  }

  /* ---------- Settings ---------- */

  function readOptions() {
    const data = new FormData(els.form);
    const quality = Number(data.get('quality')) || 75;
    const format = data.get('format') || 'original';
    const maxSide = Number(data.get('maxSide')) || 0;
    return { quality: quality / 100, format, maxSide, key: `${quality}|${format}|${maxSide}` };
  }

  els.form.addEventListener('submit', (event) => event.preventDefault());
  els.quality.addEventListener('input', () => {
    els.qualityValue.textContent = `${els.quality.value}%`;
    schedule(350);
  });
  els.form.addEventListener('change', () => schedule(0));

  /** Compresses after a short pause, so dragging the slider doesn't start dozens of jobs. */
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(compressAll, delay);
  }

  /* ---------- Compressing ---------- */

  async function compressAll() {
    await queue;
    const options = readOptions();
    const todo = items.filter((item) => item.out?.key !== options.key);
    if (!todo.length) { render(); return; }

    job?.cancel();
    const run = ++generation;
    clearZip();
    els.workspace.classList.add('is-working');
    progress.set(0, `Compressing ${todo.length} ${todo.length === 1 ? 'image' : 'images'}`);
    progress.show();
    render();

    try {
      const images = await Promise.all(todo.map(async (item) => ({
        id: item.id, name: item.name, type: item.type, bytes: new Uint8Array(await item.file.arrayBuffer()),
      })));
      if (run !== generation) return;
      const onProgress = (value, label) => { if (run === generation) progress.set(value * 0.95, label); };
      let result;
      if (workerSupported) {
        job = Site.runJob('compress', { images, options }, {
          worker: 'image-worker.js',
          transfer: images.map((img) => img.bytes.buffer),
          onProgress,
        });
        result = await job.promise;
      } else {
        result = await compressOnPage(images, options, onProgress, () => run !== generation);
      }
      if (run !== generation) return;
      applyResults(result.images, options.key);
      const noWebp = options.format === 'webp' && result.images.some((r) => r.type !== 'image/webp');
      Site.notify(els.notices, noWebp ? 'This browser can’t save WebP images, so they were saved as JPG instead.' : null, 'info');
      await buildZip(run);
    } catch (err) {
      if (err.name !== 'AbortError' && run === generation) Site.notify(els.notices, err.message || 'Compression failed. Please try again.');
    } finally {
      if (run === generation) {
        job = null;
        els.workspace.classList.remove('is-working');
        progress.hide();
        render();
      }
    }
  }

  function applyResults(results, key) {
    for (const r of results) {
      const item = items.find((it) => it.id === r.id);
      if (!item) continue;
      let blob = r.blob || new Blob([r.bytes], { type: r.type });
      // If re-encoding didn't help and nothing else changed, keep the original file.
      const kept = blob.size >= item.size && blob.type === item.type && !r.resized;
      if (kept) blob = item.file;
      if (item.out) URL.revokeObjectURL(item.out.url);
      item.out = { blob, url: URL.createObjectURL(blob), size: blob.size, type: blob.type || item.type, kept, key };
    }
  }

  /** The same work on the page, for browsers without OffscreenCanvas. */
  async function compressOnPage(images, { quality, format, maxSide }, onProgress, isStale) {
    const results = [];
    for (let i = 0; i < images.length; i += 1) {
      if (isStale()) throw new DOMException('Cancelled', 'AbortError');
      const img = images[i];
      onProgress(i / images.length, `Compressing image ${i + 1} of ${images.length}`);
      const url = URL.createObjectURL(new Blob([img.bytes], { type: img.type }));
      try {
        const el = new Image();
        el.src = url;
        try { await el.decode(); } catch { throw new Error(`“${img.name}” couldn’t be read. The file may be damaged.`); }
        const w0 = el.naturalWidth;
        const h0 = el.naturalHeight;
        const fit = maxSide ? maxSide / Math.max(w0, h0) : 1;
        const scale = Math.min(1, fit, Math.sqrt(MAX_PIXELS_PAGE / (w0 * h0)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w0 * scale));
        canvas.height = Math.max(1, Math.round(h0 * scale));
        const type = format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : img.type;
        const ctx = canvas.getContext('2d');
        if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const encode = (t) => new Promise((resolve) => canvas.toBlob(resolve, t, quality));
        let blob = await encode(type);
        if (blob && blob.type !== type && type !== 'image/png') blob = await encode('image/jpeg');
        if (!blob) throw new Error(`“${img.name}” is too large to compress on this device.`);
        results.push({ id: img.id, type: blob.type, blob, resized: scale < 1 });
        canvas.width = canvas.height = 0;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return { images: results };
  }

  /* ---------- Downloads ---------- */

  function outName(item) {
    return `${Site.baseName(item.name)}-compressed.${EXT[item.out.type] || 'jpg'}`;
  }

  async function buildZip(run) {
    const ready = items.filter((item) => item.out);
    if (ready.length < 2) return;
    progress.set(0.96, 'Packing the ZIP');
    const used = new Set();
    const files = await Promise.all(ready.map(async (item) => ({
      name: Site.uniqueName(outName(item), used),
      bytes: new Uint8Array(await item.out.blob.arrayBuffer()),
    })));
    if (run !== generation) return;
    job = Site.runJob('zip', { files, name: 'compressed-images.zip' }, {
      worker: 'image-worker.js',
      libs: ['jszip'],
      transfer: files.map((f) => f.bytes.buffer),
    });
    const { zip } = await job.promise;
    if (run !== generation) return;
    els.downloads.dataset.zip = zipUrls.add(new Blob([zip.bytes], { type: zip.type }));
    els.downloads.dataset.zipSize = String(zip.bytes.byteLength);
  }

  function clearZip() {
    zipUrls.revokeAll();
    delete els.downloads.dataset.zip;
    delete els.downloads.dataset.zipSize;
  }

  /* ---------- Rendering ---------- */

  function percent(before, after) {
    return Math.round((1 - after / before) * 100);
  }

  function savingText(item) {
    if (!item.out) return { text: 'Compressing…', tone: 'muted' };
    if (item.out.kept) return { text: 'Already compact: original kept', tone: 'muted' };
    const p = percent(item.size, item.out.size);
    if (p > 0) return { text: `${p}% smaller`, tone: 'good' };
    if (p === 0) return { text: 'About the same size', tone: 'muted' };
    return { text: `${-p}% larger in this format`, tone: 'muted' };
  }

  function render() {
    const count = items.length;
    const has = count > 0;
    const working = els.workspace.classList.contains('is-working');
    els.workspace.classList.toggle('has-files', has);
    els.filesBar.hidden = !has;
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop more images here' : 'Drop images here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Add more images' : 'Choose images to compress';
    els.count.textContent = `${count} ${count === 1 ? 'image' : 'images'}`;
    els.list.replaceChildren(...items.map(row));

    // Totals: the before/after for everything.
    const done = items.filter((item) => item.out);
    const before = items.reduce((sum, item) => sum + item.size, 0);
    const after = done.reduce((sum, item) => sum + item.out.size, 0);
    if (has && done.length === count && !working) {
      const p = percent(before, after);
      els.totalSizes.textContent = `${Site.formatBytes(before)} → ${Site.formatBytes(after)}`;
      els.totalSaving.textContent = p > 0 ? `${p}% smaller` : 'No smaller than the originals';
      els.totals.classList.toggle('is-good', p > 0);
    } else {
      els.totalSizes.textContent = `${Site.formatBytes(before)} → …`;
      els.totalSaving.textContent = 'Compressing…';
      els.totals.classList.remove('is-good');
    }

    // Download buttons
    const parts = [];
    if (has && !working && done.length === count) {
      const link = (href, name, label) => {
        const a = document.createElement('a');
        a.className = 'btn btn--primary btn--large btn--block';
        a.href = href;
        a.download = name;
        a.innerHTML = ICON.download;
        a.append(label);
        return a;
      };
      if (count === 1) {
        parts.push(link(items[0].out.url, outName(items[0]), 'Download image'));
      } else if (els.downloads.dataset.zip) {
        parts.push(link(els.downloads.dataset.zip, 'compressed-images.zip', `Download all as ZIP (${Site.formatBytes(Number(els.downloads.dataset.zipSize))})`));
      }
    }
    els.downloads.replaceChildren(...parts);
  }

  function row(item) {
    const li = document.createElement('li');
    li.className = 'crow';
    li.dataset.id = item.id;
    li.innerHTML = `
      <button type="button" class="crow__thumb" data-action="compare"><img alt="" decoding="async"></button>
      <span class="crow__body">
        <span class="crow__name"></span>
        <span class="crow__sizes"></span>
        <span class="crow__saving"></span>
      </span>
      <span class="crow__actions"></span>`;
    li.querySelector('img').src = item.out?.url || item.url;
    const compare = li.querySelector('[data-action="compare"]');
    compare.setAttribute('aria-label', `Compare ${item.name} before and after`);
    compare.disabled = !item.out;
    li.querySelector('.crow__name').textContent = item.name;
    li.querySelector('.crow__sizes').textContent = item.out
      ? `${Site.formatBytes(item.size)} → ${Site.formatBytes(item.out.size)}`
      : Site.formatBytes(item.size);
    const saving = savingText(item);
    const savingEl = li.querySelector('.crow__saving');
    savingEl.textContent = saving.text;
    savingEl.classList.toggle('is-good', saving.tone === 'good');

    const actions = li.querySelector('.crow__actions');
    if (item.out) {
      const a = document.createElement('a');
      a.className = 'mini-btn mini-btn--large';
      a.href = item.out.url;
      a.download = outName(item);
      a.innerHTML = ICON.download;
      a.setAttribute('aria-label', `Download compressed ${item.name}`);
      actions.append(a);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mini-btn mini-btn--large';
    remove.dataset.action = 'remove';
    remove.innerHTML = ICON.x;
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    actions.append(remove);
    return li;
  }

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const id = Number(button.closest('.crow').dataset.id);
    const i = items.findIndex((item) => item.id === id);
    if (i < 0) return;
    if (button.dataset.action === 'compare') { openCompare(items[i]); return; }

    const [removed] = items.splice(i, 1);
    URL.revokeObjectURL(removed.url);
    if (removed.out) URL.revokeObjectURL(removed.out.url);
    clearZip();
    render();
    const next = items[i] || items[i - 1];
    if (next) els.list.querySelector(`[data-id="${next.id}"] [data-action="remove"]`)?.focus();
    else els.dropzone.querySelector('[data-dz-button]').focus();
    if (items.length > 1 && !els.workspace.classList.contains('is-working')) {
      const run = generation;
      buildZip(run).catch(() => {}).finally(() => { if (run === generation) { job = null; render(); } });
    }
  });

  els.clear.addEventListener('click', () => {
    generation += 1;
    job?.cancel();
    job = null;
    items.forEach((item) => { URL.revokeObjectURL(item.url); if (item.out) URL.revokeObjectURL(item.out.url); });
    items = [];
    clearZip();
    els.workspace.classList.remove('is-working');
    progress.hide();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  });

  /* ---------- Before / after dialog ---------- */

  function openCompare(item) {
    if (!item.out || !els.dialog.showModal) return;
    comparing = item;
    els.compareTitle.textContent = item.name;
    els.dialog.querySelector('input[value="after"]').checked = true;
    showSide('after');
    els.dialog.showModal();
  }

  function showSide(side) {
    if (!comparing) return;
    const { size, out } = comparing;
    els.compareImg.src = side === 'before' ? comparing.url : out.url;
    els.compareImg.alt = side === 'before' ? `${comparing.name}, original` : `${comparing.name}, compressed`;
    els.compareSizes.textContent = side === 'before'
      ? `Original: ${Site.formatBytes(size)}`
      : `Compressed: ${Site.formatBytes(out.size)} (${savingText(comparing).text})`;
  }

  els.dialog.addEventListener('change', (event) => { if (event.target.name === 'side') showSide(event.target.value); });
  els.dialog.addEventListener('click', (event) => {
    if (event.target === els.dialog || event.target.closest('[data-compare-close]')) els.dialog.close();
  });
  els.dialog.addEventListener('close', () => { comparing = null; els.compareImg.removeAttribute('src'); });

  /* ---------- Start ---------- */
  els.qualityValue.textContent = `${els.quality.value}%`;
  render();
  Site.warm(['jszip']);
})();
