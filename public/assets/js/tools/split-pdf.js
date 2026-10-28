/*!
 * Nearfile — Split PDF
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
    tip: $('[data-tip]'),
    clear: $('[data-clear]'),
    pages: $('[data-pages]'),
    panel: $('[data-panel]'),
    form: $('[data-options]'),
    fields: $('[data-option-fields]'),
    rangeField: $('[data-range-field]'),
    pagesInput: $('[data-pages-input]'),
    pagesError: $('[data-pages-error]'),
    selectAll: $('[data-select-all]'),
    selectNone: $('[data-select-none]'),
    summary: $('[data-summary]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let state = null; // { file, doc, grid, selection }
  let job = null;
  let queue = Promise.resolve();

  const zone = Site.dropzone(els.dropzone, {
    onFiles: (files) => { queue = queue.then(() => load(files)); },
  });

  /* ---------- Loading ---------- */

  async function load(files) {
    if (job) return;
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
      const grid = PdfPreview.pageGrid(els.pages, doc, { selectable: true });
      const selection = PdfPreview.bindSelection({
        grid, list: els.pages, input: els.pagesInput, error: els.pagesError, pageCount: doc.numPages, onChange: () => syncMode(),
      });
      state = { file, doc, grid, selection };
      if (onlyFirst) Site.notify(els.notices, onlyFirst.trim(), 'info');
    } catch (err) {
      Site.notify(els.notices, err.message);
    }
    render();
    syncMode();
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

  /* ---------- Mode and selection ---------- */

  const mode = () => new FormData(els.form).get('mode') || 'extract';

  function syncMode(keepResult = false) {
    if (!state) return;
    const total = state.doc.numPages;
    const extract = mode() === 'extract';
    els.rangeField.hidden = !extract;
    state.grid.setSelectable(extract);
    if (extract) state.selection.refresh();
    if (keepResult !== true) clearResult();

    if (extract) {
      const count = state.selection.count();
      els.tip.textContent = 'Tap pages to pick them, or type page numbers in the settings.';
      els.summary.textContent = count
        ? `${count} ${count === 1 ? 'page' : 'pages'} will go into a new PDF.`
        : 'No pages chosen yet.';
      els.convert.textContent = 'Extract pages';
    } else {
      els.tip.textContent = 'Every page will become its own PDF.';
      els.summary.textContent = `You’ll get ${total} ${total === 1 ? 'PDF' : 'PDFs'}, one per page, in a ZIP.`;
      els.convert.textContent = total === 1 ? 'Split PDF' : `Split into ${total} PDFs`;
    }
  }

  els.form.addEventListener('change', (event) => { if (event.target.name === 'mode') syncMode(); });
  els.selectAll.addEventListener('click', () => state?.selection.selectAll());
  els.selectNone.addEventListener('click', () => { state?.selection.clear(); els.pagesInput.focus(); });
  els.clear.addEventListener('click', () => {
    if (job) job.cancel();
    unload();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  });

  /* ---------- Splitting ---------- */

  function setBusy(busy) {
    els.workspace.classList.toggle('is-busy', busy);
    els.convert.disabled = busy;
    els.cancel.hidden = !busy;
    els.fields.disabled = busy;
    els.clear.disabled = busy;
    zone.setDisabled(busy);
    if (busy) {
      els.convert.textContent = 'Splitting…';
      progress.show();
    } else {
      progress.hide();
      syncMode(true);
    }
  }

  els.form.addEventListener('submit', (event) => { event.preventDefault(); split(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  async function split() {
    if (job || !state) return;
    const extract = mode() === 'extract';
    const total = state.doc.numPages;
    let pages;
    if (extract) {
      try { pages = state.selection.pages(); } catch { return; }
    } else {
      pages = Array.from({ length: total }, (_, i) => i + 1);
    }

    Site.notify(els.notices, null);
    clearResult();
    const base = Site.baseName(state.file.name);
    progress.set(0, 'Reading the PDF');
    setBusy(true);
    try {
      const file = { name: state.file.name, bytes: new Uint8Array(await state.file.arrayBuffer()) };
      const options = { transfer: [file.bytes.buffer], onProgress: (v, label) => progress.set(v, label) };
      let result;
      if (extract) {
        const ascending = pages.every((n, i) => i === 0 || n > pages[i - 1]);
        const range = Site.formatPages(pages).replace(/, /g, '_');
        const fileName = ascending && range.length <= 24 ? `${base}-pages-${range}.pdf` : `${base}-extract.pdf`;
        job = Site.runJob('extractPages', { file, pages, fileName }, { ...options, libs: ['pdfLib'] });
        result = await job.promise;
        showResult(result, pages.length);
      } else {
        const names = pages.map((n) => `${base}-page-${Site.padPage(n, total)}.pdf`);
        job = Site.runJob('splitPages', { file, pages, names, zipName: `${base}-pages.zip` }, { ...options, libs: ['pdfLib', 'jszip'] });
        result = await job.promise;
        showResult(result, 1);
      }
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Splitting cancelled.', 'info');
      else Site.notify(els.notices, err.message || 'Splitting failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  /* ---------- Result ---------- */

  function showResult({ files, zip }, pagesPerFile) {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    const summary = document.createElement('p');
    const parts = [heading, summary];

    if (zip) {
      heading.textContent = `${files.length} PDFs ready`;
      summary.textContent = `One page each, ${Site.formatBytes(zip.bytes.byteLength)} in total.`;
      parts.push(Site.downloadLink(resultUrls, zip, { label: 'Download all as ZIP' }));
      parts.push(Site.downloadList(resultUrls, files, 'Download PDFs one at a time'));
    } else {
      const [file] = files;
      heading.textContent = 'Pages extracted';
      summary.textContent = `${file.name}: ${pagesPerFile} ${pagesPerFile === 1 ? 'page' : 'pages'}, ${Site.formatBytes(file.bytes.byteLength)}.`;
      parts.push(Site.downloadLink(resultUrls, file, { label: 'Download PDF' }));
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
  Site.warm(['pdfLib', 'jszip']);
})();
