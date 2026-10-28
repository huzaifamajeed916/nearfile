/*!
 * Nearfile — PDF to image
 */
(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const els = {
    workspace: $('[data-workspace]'),
    dropzone: $('[data-dropzone]'),
    dzTitle: $('[data-dz-title]'),
    notices: $('[data-notices]'),
    filesBar: $('[data-files-bar]'),
    info: $('[data-file-info]'),
    clear: $('[data-clear]'),
    pages: $('[data-pages]'),
    panel: $('[data-panel]'),
    form: $('[data-options]'),
    fields: $('[data-option-fields]'),
    pagesInput: $('[data-pages-input]'),
    pagesError: $('[data-pages-error]'),
    selectAll: $('[data-select-all]'),
    selectNone: $('[data-select-none]'),
    selected: $('[data-selected]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let state = null; // { file, doc, grid, selection }
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
    unload();
    els.dzTitle.querySelector('.dz-pointer').textContent = `Opening ${file.name}…`;
    try {
      const doc = await PdfPreview.open(file);
      const grid = PdfPreview.pageGrid(els.pages, doc, { selectable: true });
      const selection = PdfPreview.bindSelection({
        grid, list: els.pages, input: els.pagesInput, error: els.pagesError, pageCount: doc.numPages, onChange: updateSelected,
      });
      state = { file, doc, grid, selection };
      selection.selectAll();
      if (onlyFirst) Site.notify(els.notices, onlyFirst.trim(), 'info');
    } catch (err) {
      Site.notify(els.notices, err.message);
    }
    render();
  }

  function unload() {
    if (!state) return;
    state.selection.destroy();
    state.grid.destroy();
    state.doc.destroy();
    state = null;
    clearResult();
  }

  function render() {
    const has = Boolean(state);
    els.workspace.classList.toggle('has-files', has);
    els.filesBar.hidden = !has;
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop another PDF here' : 'Drop a PDF here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Choose another PDF' : 'Choose a PDF';
    if (has) {
      const n = state.doc.numPages;
      els.info.textContent = `${state.file.name}: ${n} ${n === 1 ? 'page' : 'pages'}, ${Site.formatBytes(state.file.size)}`;
    }
  }

  function updateSelected(count) {
    if (!state) return;
    const total = state.doc.numPages;
    els.selected.textContent = `${count} of ${total} ${total === 1 ? 'page' : 'pages'} selected`;
    clearResult();
  }

  els.selectAll.addEventListener('click', () => state?.selection.selectAll());
  els.selectNone.addEventListener('click', () => { state?.selection.clear(); els.pagesInput.focus(); });
  els.clear.addEventListener('click', () => {
    if (busy) cancel();
    unload();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  });

  /* ---------- Converting ---------- */

  function readOptions() {
    const data = new FormData(els.form);
    const png = data.get('format') === 'png';
    return {
      type: png ? 'image/png' : 'image/jpeg',
      ext: png ? 'png' : 'jpg',
      dpi: Number(data.get('dpi')) || 150,
    };
  }

  function setBusy(value) {
    busy = value;
    els.workspace.classList.toggle('is-busy', value);
    els.convert.disabled = value;
    els.convert.textContent = value ? 'Converting…' : 'Convert to images';
    els.cancel.hidden = !value;
    els.fields.disabled = value;
    els.clear.disabled = value;
    zone.setDisabled(value);
    if (value) progress.show(); else progress.hide();
  }

  function cancel() {
    cancelled = true;
    job?.cancel();
  }

  els.form.addEventListener('submit', (event) => { event.preventDefault(); convert(); });
  els.form.addEventListener('change', (event) => { if (event.target !== els.pagesInput) clearResult(); });
  els.cancel.addEventListener('click', cancel);

  async function convert() {
    if (busy || !state) return;
    let pages;
    try { pages = state.selection.pages(); } catch { return; }

    Site.notify(els.notices, null);
    clearResult();
    const { type, ext, dpi } = readOptions();
    const base = Site.baseName(state.file.name);
    const total = state.doc.numPages;
    const files = [];
    let capped = false;
    cancelled = false;
    progress.set(0, 'Starting');
    setBusy(true);

    try {
      for (let i = 0; i < pages.length; i += 1) {
        if (cancelled) throw new DOMException('Cancelled', 'AbortError');
        progress.set((i / pages.length) * 0.9, `Drawing page ${pages[i]} (${i + 1} of ${pages.length})`);
        const image = await PdfPreview.renderImage(state.doc, pages[i], { dpi, type, quality: 0.92 });
        capped ||= image.capped;
        files.push({ name: `${base}-page-${Site.padPage(pages[i], total)}.${ext}`, type, blob: image.blob });
      }
      if (cancelled) throw new DOMException('Cancelled', 'AbortError');

      let zip = null;
      if (files.length > 1) {
        progress.set(0.92, 'Packing the ZIP');
        const payload = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.blob.arrayBuffer()) })));
        job = Site.runJob('zip', { files: payload, name: `${base}-images.zip` }, {
          libs: ['jszip'],
          transfer: payload.map((f) => f.bytes.buffer),
        });
        ({ zip } = await job.promise);
      }
      progress.set(1, 'Done');
      showResult(files, zip, { ext, dpi, capped });
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Conversion cancelled.', 'info');
      else Site.notify(els.notices, err.message || 'Conversion failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  /* ---------- Result ---------- */

  function showResult(files, zip, { ext, dpi, capped }) {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    const summary = document.createElement('p');
    const totalBytes = files.reduce((sum, f) => sum + f.blob.size, 0);
    const parts = [heading, summary];

    if (zip) {
      heading.textContent = `${files.length} pages converted`;
      summary.textContent = `${ext.toUpperCase()} images at ${dpi} DPI, ${Site.formatBytes(totalBytes)} in total.`;
      parts.push(Site.downloadLink(resultUrls, zip, { label: 'Download all as ZIP' }));
      parts.push(Site.downloadList(resultUrls, files, 'Download images one at a time'));
    } else {
      heading.textContent = 'Page converted';
      summary.textContent = `${files[0].name}: ${ext.toUpperCase()} at ${dpi} DPI, ${Site.formatBytes(totalBytes)}.`;
      parts.push(Site.downloadLink(resultUrls, files[0], { label: 'Download image' }));
    }
    if (capped) {
      const note = document.createElement('p');
      note.textContent = 'Some very large pages were drawn smaller, to stay within this device’s image size limit.';
      parts.push(note);
    }
    els.result.replaceChildren(...parts);
    els.result.hidden = false;
    heading.focus({ preventScroll: true });
    els.result.scrollIntoView({ behavior: Site.prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  }

  function clearResult() {
    els.result.hidden = true;
    els.result.replaceChildren();
    resultUrls.revokeAll();
  }

  /* ---------- Start ---------- */
  render();
  PdfPreview.warm();
  Site.warm(['jszip']);
})();
