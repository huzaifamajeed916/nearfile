/*!
 * Nearfile — Compress PDF
 *
 * Two methods. "Keep text" re-compresses the pictures inside the PDF and tidies its structure in a
 * worker, so text stays sharp and selectable. "Flatten pages" draws every page with PDF.js and
 * rebuilds the PDF from JPEG pictures: smallest files, but the text is no longer text.
 */
(() => {
  'use strict';

  const PRESETS = {
    keep: {
      light: {
        images: false,
        quality: 0.75,
        maxSide: 0,
        hint: 'Only tidies the file: leftover data and uncompressed parts. Nothing you can see changes, so savings are usually small.',
      },
      balanced: {
        images: true,
        quality: 0.72,
        maxSide: 2000,
        hint: 'Re-compresses large pictures at 72% quality, up to 2000 pixels wide. Text stays sharp and selectable.',
      },
      strong: {
        images: true,
        quality: 0.55,
        maxSide: 1400,
        hint: 'Smaller, lower-resolution pictures at 55% quality. Best for photos and scans you only need to read on screen.',
      },
    },
    flatten: {
      sharp: {
        dpi: 150,
        quality: 0.7,
        hint: 'Turns every page into a 150 DPI picture. Very small files that still print acceptably, but text can’t be selected or searched.',
      },
      small: {
        dpi: 100,
        quality: 0.55,
        hint: 'Turns every page into a 100 DPI picture. The smallest files, fine on screen. Text can’t be selected or searched.',
      },
    },
  };

  const ICON_X = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const canRecompress = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';

  const $ = (selector) => document.querySelector(selector);
  const els = {
    workspace: $('[data-workspace]'),
    dropzone: $('[data-dropzone]'),
    dzTitle: $('[data-dz-title]'),
    notices: $('[data-notices]'),
    list: $('[data-list]'),
    panel: $('[data-panel]'),
    form: $('[data-options]'),
    fields: $('[data-option-fields]'),
    levelKeep: $('[data-level-keep]'),
    levelFlatten: $('[data-level-flatten]'),
    hint: $('[data-method-hint]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let state = null; // { file, doc, thumb, statusText }
  let busy = false;
  let cancelled = false;
  let job = null;
  let queue = Promise.resolve();

  const zone = Site.dropzone(els.dropzone, {
    onFiles: (files) => { queue = queue.then(() => load(files)); },
  });

  /* ---------- Loading ---------- */

  async function load(files) {
    if (busy) return;
    Site.notify(els.notices, null);
    const [file] = files;
    const onlyFirst = files.length > 1 ? ' This tool takes one PDF at a time, so only the first file was used.' : '';
    if ((await Site.sniff(file)) !== 'pdf') {
      Site.notify(els.notices, `“${file.name}” isn’t a PDF.${onlyFirst}`);
      return;
    }
    if (await Site.isEncryptedPdf(file)) {
      Site.notify(els.notices, `“${file.name}” is protected with a password or permissions lock. Remove the protection, then try again.`);
      return;
    }
    unload();
    els.dzTitle.querySelector('.dz-pointer').textContent = `Opening ${file.name}…`;
    try {
      const doc = await PdfPreview.open(file);
      let thumb = null;
      try { thumb = await PdfPreview.thumbnail(doc, 1, 72); } catch { /* the row just shows no preview */ }
      state = { file, doc, thumb, statusText: '' };
      if (onlyFirst) Site.notify(els.notices, onlyFirst.trim(), 'info');
    } catch (err) {
      Site.notify(els.notices, err.message);
    }
    render();
    syncMethod();
  }

  function unload() {
    if (!state) return;
    if (state.thumb) URL.revokeObjectURL(state.thumb);
    state.doc.destroy();
    state = null;
    clearResult();
  }

  function render() {
    const has = Boolean(state);
    els.workspace.classList.toggle('has-files', has);
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop another PDF here' : 'Drop a PDF here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Choose another PDF' : 'Choose a PDF';
    els.list.replaceChildren(...(has ? [row()] : []));
  }

  function row() {
    const n = state.doc.numPages;
    const li = document.createElement('li');
    li.className = 'crow';
    li.innerHTML = `
      <span class="crow__thumb crow__thumb--page"><img alt="" decoding="async"></span>
      <span class="crow__body">
        <span class="crow__name"></span>
        <span class="crow__sizes"></span>
        <span class="crow__saving"></span>
      </span>
      <span class="crow__actions"></span>`;
    const img = li.querySelector('img');
    if (state.thumb) img.src = state.thumb; else img.hidden = true;
    li.querySelector('.crow__name').textContent = state.file.name;
    li.querySelector('.crow__sizes').textContent = `${n} ${n === 1 ? 'page' : 'pages'}, ${Site.formatBytes(state.file.size)}`;
    const status = li.querySelector('.crow__saving');
    status.textContent = state.statusText;
    status.classList.toggle('is-good', Boolean(state.statusText) && state.statusGood === true);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mini-btn mini-btn--large';
    remove.innerHTML = ICON_X;
    remove.disabled = busy;
    remove.setAttribute('aria-label', `Remove ${state.file.name}`);
    remove.addEventListener('click', () => {
      if (busy) return;
      unload();
      Site.notify(els.notices, null);
      render();
      els.dropzone.querySelector('[data-dz-button]').focus();
    });
    li.querySelector('.crow__actions').append(remove);
    return li;
  }

  /* ---------- Settings ---------- */

  function readOptions() {
    const data = new FormData(els.form);
    const method = data.get('method') === 'flatten' ? 'flatten' : 'keep';
    const level = method === 'flatten' ? (data.get('flat') || 'sharp') : (data.get('level') || 'balanced');
    return { method, level, preset: PRESETS[method][level] || PRESETS[method].balanced };
  }

  function syncMethod() {
    const { method, preset } = readOptions();
    els.levelKeep.hidden = method !== 'keep';
    els.levelFlatten.hidden = method !== 'flatten';
    els.hint.textContent = preset.hint;
    els.convert.textContent = 'Compress PDF';
    if (method === 'keep' && preset.images && !canRecompress) {
      Site.notify(els.notices, 'This browser can’t re-compress pictures, so only Light compression will work. Update your browser, or use Flatten pages.', 'info');
    }
    if (state) clearResult();
  }

  els.form.addEventListener('change', syncMethod);
  els.form.addEventListener('submit', (event) => { event.preventDefault(); compress(); });
  els.cancel.addEventListener('click', cancel);

  function setBusy(value) {
    busy = value;
    els.workspace.classList.toggle('is-busy', value);
    els.convert.disabled = value;
    els.convert.textContent = value ? 'Compressing…' : 'Compress PDF';
    els.cancel.hidden = !value;
    els.fields.disabled = value;
    zone.setDisabled(value);
    if (value) progress.show(); else progress.hide();
    if (state) render();
  }

  function cancel() {
    cancelled = true;
    job?.cancel();
  }

  /* ---------- Compressing ---------- */

  async function compress() {
    if (busy || !state) return;
    const { method, preset } = readOptions();
    Site.notify(els.notices, null);
    clearResult();
    state.statusText = '';
    const original = state.file;
    const base = Site.baseName(original.name);
    const fileName = `${base}-compressed.pdf`;
    cancelled = false;
    progress.set(0, 'Reading the PDF');
    setBusy(true);

    try {
      let result;
      if (method === 'keep') {
        const bytes = new Uint8Array(await original.arrayBuffer());
        job = Site.runJob('compressPdf', {
          file: { name: original.name, bytes },
          options: { images: preset.images, quality: preset.quality, maxSide: preset.maxSide },
          fileName,
        }, { libs: ['pdfLib'], transfer: [bytes.buffer], onProgress: (v, label) => progress.set(v, label) });
        result = await job.promise;
      } else {
        result = await flatten(original, preset, fileName);
      }
      showResult(result, method, original.size, fileName);
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Compression cancelled.', 'info');
      else Site.notify(els.notices, err.message || 'Compression failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  /** Draws every page and rebuilds the PDF from the pictures. */
  async function flatten(original, { dpi, quality }, fileName) {
    const total = state.doc.numPages;
    const pages = [];
    for (let n = 1; n <= total; n += 1) {
      if (cancelled) throw new DOMException('Cancelled', 'AbortError');
      progress.set(((n - 1) / total) * 0.85, `Drawing page ${n} of ${total}`);
      const image = await PdfPreview.renderImage(state.doc, n, { dpi, type: 'image/jpeg', quality });
      pages.push({ bytes: new Uint8Array(await image.blob.arrayBuffer()), width: image.pointWidth, height: image.pointHeight });
    }
    if (cancelled) throw new DOMException('Cancelled', 'AbortError');
    job = Site.runJob('picturesToPdf', { pages, originalSize: original.size, fileName }, {
      libs: ['pdfLib'],
      transfer: pages.map((page) => page.bytes.buffer),
      onProgress: (v, label) => progress.set(0.85 + v * 0.15, label),
    });
    return job.promise;
  }

  /* ---------- Result ---------- */

  const percent = (before, after) => Math.round((1 - after / before) * 100);

  function showResult(result, method, beforeSize, fileName) {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    const parts = [heading];
    const note = (text) => {
      const p = document.createElement('p');
      p.className = 'result__note';
      p.textContent = text;
      parts.push(p);
    };

    if (result.kept) {
      heading.textContent = 'Already compact';
      note(method === 'flatten'
        ? 'Rebuilding this PDF from page pictures wouldn’t make it smaller, so there’s nothing new to download. Try Keep text with Strong instead.'
        : 'This setting couldn’t make the PDF any smaller, so there’s nothing new to download. Try a stronger setting, or Flatten pages if it’s a scan.');
      state.statusText = 'Already compact';
      state.statusGood = false;
    } else {
      const file = result.files[0];
      const after = file.bytes.byteLength;
      const saved = percent(beforeSize, after);
      heading.textContent = 'PDF compressed';
      const totals = document.createElement('div');
      totals.className = 'totals is-good';
      totals.innerHTML = '<span class="totals__sizes"></span><span class="totals__saving"></span>';
      totals.querySelector('.totals__sizes').textContent = `${Site.formatBytes(beforeSize)} → ${Site.formatBytes(after)}`;
      totals.querySelector('.totals__saving').textContent = `${saved}% smaller`;
      parts.push(totals);
      parts.push(Site.downloadLink(resultUrls, file, { label: 'Download PDF' }));

      if (method === 'flatten') {
        note('Every page is now a picture, so text can’t be selected or searched.');
      } else if (result.stats?.found) {
        note(`${result.stats.changed} of ${result.stats.found} ${result.stats.found === 1 ? 'picture was' : 'pictures were'} re-compressed.`);
      }
      if (method === 'keep' && saved < 10) note('Not much to save here. If this PDF is a scan, Flatten pages usually makes it far smaller.');
      state.statusText = `Compressed: ${saved}% smaller`;
      state.statusGood = true;
    }
    render();
    els.result.replaceChildren(...parts);
    els.result.hidden = false;
    heading.focus({ preventScroll: true });
    els.result.scrollIntoView({ behavior: Site.prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  }

  function clearResult() {
    els.result.hidden = true;
    els.result.replaceChildren();
    resultUrls.revokeAll();
    if (state && state.statusText) {
      state.statusText = '';
      render();
    }
  }

  /* ---------- Start ---------- */
  render();
  syncMethod();
  PdfPreview.warm();
  Site.warm(['pdfLib']);
})();
