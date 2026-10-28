/*!
 * Nearfile — Resize image
 * Changes the pixel size of JPG, PNG and WebP images, and can convert between those formats.
 * Runs in a worker (OffscreenCanvas), or on the page in browsers without it.
 */
(() => {
  'use strict';

  const MAX_FILES = 30;
  const MAX_PIXELS = 40_000_000;        // the most any one result may have; matches the worker
  const MAX_PIXELS_PAGE = 16_000_000;   // iOS Safari canvas limit, for the on-page fallback
  const MAX_SIDE = 20000;
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
    fields: $('[data-option-fields]'),
    percentField: $('[data-percent-field]'),
    pixelFields: $('[data-pixel-fields]'),
    percent: $('[data-percent]'),
    width: $('[data-width]'),
    height: $('[data-height]'),
    keepRatio: $('[data-keep-ratio]'),
    noEnlarge: $('[data-no-enlarge]'),
    sizeError: $('[data-size-error]'),
    qualityField: $('[data-quality-field]'),
    quality: $('[data-quality]'),
    qualityValue: $('[data-quality-value]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    downloads: $('[data-downloads]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const zipUrls = Site.urlBag();

  let items = []; // { id, file, name, size, type, url, width, height, out: { blob, url, size, type, width, height } | null }
  let nextId = 1;
  let job = null;
  let busy = false;
  let queue = Promise.resolve();

  const zone = Site.dropzone(els.dropzone, {
    onFiles: (files) => { queue = queue.then(() => addFiles(files)); },
  });

  /* ---------- Adding files ---------- */

  async function readSize(url) {
    const el = new Image();
    el.src = url;
    await el.decode();
    return { width: el.naturalWidth, height: el.naturalHeight };
  }

  async function addFiles(files) {
    if (busy) return;
    Site.notify(els.notices, null);
    const room = MAX_FILES - items.length;
    if (room <= 0) {
      Site.notify(els.notices, `You’ve reached the limit of ${MAX_FILES} images. Remove some to add others.`);
      return;
    }
    const unsupported = [];
    const unreadable = [];
    let skipped = 0;
    let added = 0;
    for (const file of files) {
      const kind = await Site.sniff(file);
      if (!TYPES[kind]) { unsupported.push(file.name); continue; }
      if (added >= room) { skipped += 1; continue; }
      const url = URL.createObjectURL(file);
      try {
        const { width, height } = await readSize(url);
        items.push({ id: nextId++, file, name: file.name, size: file.size, type: TYPES[kind], url, width, height, out: null });
        added += 1;
      } catch {
        URL.revokeObjectURL(url);
        unreadable.push(file.name);
      }
    }
    const messages = [];
    if (unsupported.length) messages.push(`${Site.listNames(unsupported)} ${unsupported.length === 1 ? 'isn’t' : 'aren’t'} a JPG, PNG or WebP image, so ${unsupported.length === 1 ? 'it was' : 'they were'} left out.`);
    if (unreadable.length) messages.push(`${Site.listNames(unreadable)} couldn’t be read. ${unreadable.length === 1 ? 'The file' : 'The files'} may be damaged.`);
    if (skipped) messages.push(`${skipped} ${skipped === 1 ? 'image was' : 'images were'} left out: the limit is ${MAX_FILES} at a time.`);
    if (messages.length) Site.notify(els.notices, messages.join(' '), added ? 'info' : 'error');
    if (added) {
      invalidate();
      render();
    }
  }

  /* ---------- Settings ---------- */

  /** Reads the form. `error` is set when a size is missing or out of range. */
  function readOptions() {
    const data = new FormData(els.form);
    const mode = data.get('mode') === 'pixels' ? 'pixels' : 'percent';
    const whole = (input) => (input.value.trim() === '' ? 0 : Number(input.value));
    const percent = Number(els.percent.value);
    const width = whole(els.width);
    const height = whole(els.height);
    const format = data.get('format') || 'original';
    let error = '';
    if (mode === 'percent') {
      if (els.percent.value.trim() === '' || !Number.isFinite(percent) || percent < 1 || percent > 400) error = 'Enter a percentage from 1 to 400.';
    } else if (!width && !height) {
      error = 'Enter a width, a height, or both.';
    } else if ([width, height].some((n) => !Number.isInteger(n) || n < 0 || n > MAX_SIDE)) {
      error = `Sizes are whole pixels, up to ${MAX_SIDE}.`;
    }
    return {
      mode, percent, width, height, format, error,
      keepRatio: els.keepRatio.checked,
      noEnlarge: els.noEnlarge.checked,
      quality: Number(els.quality.value) / 100,
    };
  }

  /** The size an image will be made, in whole pixels. */
  function targetSize(item, o) {
    let w;
    let h;
    if (o.mode === 'percent') {
      w = (item.width * o.percent) / 100;
      h = (item.height * o.percent) / 100;
    } else if (o.keepRatio) {
      let scale = Math.min(o.width ? o.width / item.width : Infinity, o.height ? o.height / item.height : Infinity);
      if (o.noEnlarge) scale = Math.min(scale, 1);
      w = item.width * scale;
      h = item.height * scale;
    } else {
      w = o.width || item.width;
      h = o.height || item.height;
    }
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }

  function syncForm() {
    const o = readOptions();
    const pixels = o.mode === 'pixels';
    els.percentField.hidden = pixels;
    els.pixelFields.hidden = !pixels;
    els.qualityField.hidden = o.format === 'png';
    els.qualityValue.textContent = `${els.quality.value}%`;
    els.noEnlarge.disabled = !o.keepRatio;
    els.sizeError.textContent = o.error;
    els.sizeError.hidden = !o.error;
    return o;
  }

  function onSettingsChange() {
    syncForm();
    if (items.some((item) => item.out)) {
      invalidate();
      render();
    } else {
      refreshRows();
    }
  }

  els.form.addEventListener('input', onSettingsChange);
  els.form.addEventListener('change', onSettingsChange);
  els.form.addEventListener('submit', (event) => { event.preventDefault(); resizeAll(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  /* ---------- Resizing ---------- */

  function setBusy(value) {
    busy = value;
    els.workspace.classList.toggle('is-busy', value);
    els.convert.disabled = value;
    els.convert.textContent = value ? 'Resizing…' : 'Resize images';
    els.cancel.hidden = !value;
    els.fields.disabled = value;
    els.clear.disabled = value;
    zone.setDisabled(value);
    if (value) progress.show(); else progress.hide();
    render();
  }

  async function resizeAll() {
    if (busy || !items.length) return;
    const o = syncForm();
    if (o.error) { (o.mode === 'percent' ? els.percent : els.width).focus(); return; }
    const targets = new Map(items.map((item) => [item.id, targetSize(item, o)]));
    const tooBig = items.find((item) => {
      const t = targets.get(item.id);
      return t.width * t.height > MAX_PIXELS;
    });
    if (tooBig) {
      Site.notify(els.notices, `“${tooBig.name}” would come out larger than this tool can make (${Math.round(MAX_PIXELS / 1e6)} megapixels). Choose a smaller size.`);
      return;
    }

    Site.notify(els.notices, null);
    invalidate();
    progress.set(0, 'Reading the images');
    setBusy(true);
    try {
      const images = await Promise.all(items.map(async (item) => ({
        id: item.id, name: item.name, type: item.type, bytes: new Uint8Array(await item.file.arrayBuffer()), ...targets.get(item.id),
      })));
      const options = { format: o.format, quality: o.quality };
      let result;
      if (workerSupported) {
        job = Site.runJob('resize', { images, options }, {
          worker: 'image-worker.js',
          transfer: images.map((img) => img.bytes.buffer),
          onProgress: (v, label) => progress.set(v * 0.95, label),
        });
        result = await job.promise;
      } else {
        result = await resizeOnPage(images, options);
      }
      applyResults(result.images);
      const noWebp = o.format === 'webp' && result.images.some((r) => r.type !== 'image/webp');
      Site.notify(els.notices, noWebp ? 'This browser can’t save WebP images, so they were saved as JPG instead.' : null, 'info');
      await buildZip();
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Resizing cancelled.', 'info');
      else Site.notify(els.notices, err.message || 'Resizing failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  function applyResults(results) {
    for (const r of results) {
      const item = items.find((it) => it.id === r.id);
      if (!item) continue;
      const blob = r.blob || new Blob([r.bytes], { type: r.type });
      item.out = { blob, url: URL.createObjectURL(blob), size: blob.size, type: blob.type || item.type, width: r.width, height: r.height };
    }
  }

  /** The same work on the page, for browsers without OffscreenCanvas. */
  async function resizeOnPage(images, { format, quality }) {
    const results = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      progress.set((i / images.length) * 0.95, `Resizing image ${i + 1} of ${images.length}`);
      if (img.width * img.height > MAX_PIXELS_PAGE) {
        throw new Error(`“${img.name}” would be too large for this device to make (${Math.round(MAX_PIXELS_PAGE / 1e6)} megapixels). Choose a smaller size.`);
      }
      const url = URL.createObjectURL(new Blob([img.bytes], { type: img.type }));
      try {
        const el = new Image();
        el.src = url;
        try { await el.decode(); } catch { throw new Error(`“${img.name}” couldn’t be read. The file may be damaged.`); }
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[format] || img.type;
        const ctx = canvas.getContext('2d');
        if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, img.width, img.height); }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(el, 0, 0, img.width, img.height);
        const encode = (t) => new Promise((resolve) => canvas.toBlob(resolve, t, quality));
        let blob = await encode(type);
        if (blob && blob.type !== type && type !== 'image/png') blob = await encode('image/jpeg');
        if (!blob) throw new Error(`“${img.name}” is too large to resize on this device.`);
        results.push({ id: img.id, type: blob.type, blob, width: img.width, height: img.height });
        canvas.width = canvas.height = 0;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return { images: results };
  }

  /** Forgets earlier results, so changing a setting means resizing again. */
  function invalidate() {
    for (const item of items) {
      if (item.out) URL.revokeObjectURL(item.out.url);
      item.out = null;
    }
    clearZip();
  }

  /* ---------- Downloads ---------- */

  function outName(item) {
    return `${Site.baseName(item.name)}-${item.out.width}x${item.out.height}.${EXT[item.out.type] || 'jpg'}`;
  }

  async function buildZip() {
    const ready = items.filter((item) => item.out);
    if (ready.length < 2) return;
    progress.set(0.96, 'Packing the ZIP');
    const used = new Set();
    const files = await Promise.all(ready.map(async (item) => ({
      name: Site.uniqueName(outName(item), used),
      bytes: new Uint8Array(await item.out.blob.arrayBuffer()),
    })));
    job = Site.runJob('zip', { files, name: 'resized-images.zip' }, {
      worker: 'image-worker.js',
      libs: ['jszip'],
      transfer: files.map((f) => f.bytes.buffer),
    });
    const { zip } = await job.promise;
    els.downloads.dataset.zip = zipUrls.add(new Blob([zip.bytes], { type: zip.type }));
    els.downloads.dataset.zipSize = String(zip.bytes.byteLength);
  }

  function clearZip() {
    zipUrls.revokeAll();
    delete els.downloads.dataset.zip;
    delete els.downloads.dataset.zipSize;
  }

  /* ---------- Rendering ---------- */

  const dims = (w, h) => `${w.toLocaleString('en-US')} × ${h.toLocaleString('en-US')} px`;

  function rowText(item, options) {
    if (item.out) {
      return {
        sizes: `${dims(item.width, item.height)} → ${dims(item.out.width, item.out.height)}`,
        status: `${Site.formatBytes(item.size)} → ${Site.formatBytes(item.out.size)}`,
        tone: item.out.size < item.size ? 'good' : 'muted',
      };
    }
    const base = `${dims(item.width, item.height)}, ${Site.formatBytes(item.size)}`;
    if (options.error) return { sizes: base, status: '', tone: 'muted' };
    const t = targetSize(item, options);
    if (t.width * t.height > MAX_PIXELS) return { sizes: base, status: `Too large at this size (over ${Math.round(MAX_PIXELS / 1e6)} megapixels)`, tone: 'warn' };
    return { sizes: base, status: `Will be ${dims(t.width, t.height)}`, tone: 'muted' };
  }

  /** Updates the text under each picture without rebuilding the list. */
  function refreshRows() {
    const options = readOptions();
    for (const item of items) {
      const li = els.list.querySelector(`[data-id="${item.id}"]`);
      if (!li) continue;
      const text = rowText(item, options);
      li.querySelector('.crow__sizes').textContent = text.sizes;
      const status = li.querySelector('.crow__saving');
      status.textContent = text.status;
      status.classList.toggle('is-good', text.tone === 'good');
      status.classList.toggle('is-warn', text.tone === 'warn');
    }
  }

  function render() {
    const count = items.length;
    const has = count > 0;
    els.workspace.classList.toggle('has-files', has);
    els.filesBar.hidden = !has;
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop more images here' : 'Drop images here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Add more images' : 'Choose images to resize';
    els.count.textContent = `${count} ${count === 1 ? 'image' : 'images'}`;
    els.convert.textContent = busy ? 'Resizing…' : count === 1 ? 'Resize image' : 'Resize images';
    els.list.replaceChildren(...items.map(row));
    refreshRows();

    const parts = [];
    if (has && !busy && items.every((item) => item.out)) {
      const link = (href, name, label) => {
        const a = document.createElement('a');
        a.className = 'btn btn--primary btn--large btn--block';
        a.href = href;
        a.download = name;
        a.innerHTML = ICON.download;
        a.append(label);
        return a;
      };
      if (count === 1) parts.push(link(items[0].out.url, outName(items[0]), 'Download image'));
      else if (els.downloads.dataset.zip) parts.push(link(els.downloads.dataset.zip, 'resized-images.zip', `Download all as ZIP (${Site.formatBytes(Number(els.downloads.dataset.zipSize))})`));
    }
    els.downloads.replaceChildren(...parts);
  }

  function row(item) {
    const li = document.createElement('li');
    li.className = 'crow';
    li.dataset.id = item.id;
    li.innerHTML = `
      <span class="crow__thumb crow__thumb--static"><img alt="" decoding="async"></span>
      <span class="crow__body">
        <span class="crow__name"></span>
        <span class="crow__sizes"></span>
        <span class="crow__saving"></span>
      </span>
      <span class="crow__actions"></span>`;
    li.querySelector('img').src = item.out?.url || item.url;
    li.querySelector('.crow__name').textContent = item.name;
    const actions = li.querySelector('.crow__actions');
    if (item.out) {
      const a = document.createElement('a');
      a.className = 'mini-btn mini-btn--large';
      a.href = item.out.url;
      a.download = outName(item);
      a.innerHTML = ICON.download;
      a.setAttribute('aria-label', `Download resized ${item.name}`);
      actions.append(a);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mini-btn mini-btn--large';
    remove.dataset.action = 'remove';
    remove.disabled = busy;
    remove.innerHTML = ICON.x;
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    actions.append(remove);
    return li;
  }

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="remove"]');
    if (!button || busy) return;
    const id = Number(button.closest('.crow').dataset.id);
    const i = items.findIndex((item) => item.id === id);
    if (i < 0) return;
    const [removed] = items.splice(i, 1);
    URL.revokeObjectURL(removed.url);
    if (removed.out) URL.revokeObjectURL(removed.out.url);
    invalidate(); // the results no longer match the list: resize again
    render();
    const next = items[i] || items[i - 1];
    if (next) els.list.querySelector(`[data-id="${next.id}"] [data-action="remove"]`)?.focus();
    else els.dropzone.querySelector('[data-dz-button]').focus();
  });

  els.clear.addEventListener('click', () => {
    if (busy) return;
    invalidate();
    items.forEach((item) => URL.revokeObjectURL(item.url));
    items = [];
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  });

  /* ---------- Start ---------- */
  syncForm();
  render();
  Site.warm(['jszip']);
})();
