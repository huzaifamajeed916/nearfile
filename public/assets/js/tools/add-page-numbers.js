/*!
 * Nearfile — Add page numbers
 * Shows the first numbered page with the number where it will go, then stamps the PDF in a worker.
 */
(() => {
  'use strict';

  const SIZES = { small: 9, medium: 12, large: 16 }; // points
  // Keep these in step with pageNumbers in workers/pdf-worker.js.
  const SIDE_MARGIN = 40;
  const EDGE_MARGIN = 30;
  const MAX_NUMBER = 99999;

  const $ = (selector) => document.querySelector(selector);
  const els = {
    workspace: $('[data-workspace]'),
    dropzone: $('[data-dropzone]'),
    dzTitle: $('[data-dz-title]'),
    notices: $('[data-notices]'),
    filesBar: $('[data-files-bar]'),
    info: $('[data-file-info]'),
    clear: $('[data-clear]'),
    stampWrap: $('[data-stamp-wrap]'),
    stamp: $('[data-stamp]'),
    stampImg: $('[data-stamp-img]'),
    mark: $('[data-mark]'),
    caption: $('[data-caption]'),
    panel: $('[data-panel]'),
    form: $('[data-options]'),
    fields: $('[data-option-fields]'),
    startOn: $('[data-start-on]'),
    firstNumber: $('[data-first-number]'),
    numbersError: $('[data-numbers-error]'),
    formatLabels: document.querySelectorAll('[data-format-label]'),
    summary: $('[data-summary]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let state = null; // { file, doc, count, shown: { page, url, width, height } | null }
  let job = null;
  let busy = false;
  let previewTimer = 0;
  let previewRun = 0;
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
      state = { file, doc, count: doc.numPages, shown: null };
      els.startOn.value = '1';
      els.firstNumber.value = '1';
      els.startOn.max = String(doc.numPages);
      if (onlyFirst) Site.notify(els.notices, onlyFirst.trim(), 'info');
    } catch (err) {
      Site.notify(els.notices, err.message);
    }
    render();
    update();
  }

  function unload() {
    if (!state) return;
    clearTimeout(previewTimer);
    previewRun += 1;
    if (state.shown?.url) URL.revokeObjectURL(state.shown.url);
    els.stampImg.removeAttribute('src');
    state.doc.destroy();
    state = null;
    clearResult();
  }

  function render() {
    const has = Boolean(state);
    els.workspace.classList.toggle('has-files', has);
    els.filesBar.hidden = !has;
    els.stampWrap.hidden = !has;
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop another PDF here' : 'Drop a PDF here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Choose another PDF' : 'Choose a PDF';
    if (has) {
      const n = state.count;
      els.info.textContent = `${state.file.name}: ${n} ${n === 1 ? 'page' : 'pages'}, ${Site.formatBytes(state.file.size)}`;
    }
  }

  els.clear.addEventListener('click', () => {
    if (busy) return;
    unload();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  });

  /* ---------- Settings ---------- */

  function numberLabel(format, n, last) {
    if (format === 'page') return `Page ${n}`;
    if (format === 'of') return `${n} of ${last}`;
    if (format === 'page-of') return `Page ${n} of ${last}`;
    return String(n);
  }

  /** Reads and checks the form. Returns { ok, options, error } and shows the error under the fields. */
  function readOptions() {
    const data = new FormData(els.form);
    const startOn = Number(els.startOn.value);
    const first = Number(els.firstNumber.value);
    let error = '';
    if (!state) error = '';
    else if (!els.startOn.value.trim() || !Number.isInteger(startOn) || startOn < 1 || startOn > state.count) {
      error = `Start on a page from 1 to ${state.count}.`;
    } else if (!els.firstNumber.value.trim() || !Number.isInteger(first) || first < 0 || first > MAX_NUMBER) {
      error = `The first number can be from 0 to ${MAX_NUMBER}.`;
    }
    els.numbersError.textContent = error;
    els.numbersError.hidden = !error;
    els.startOn.setAttribute('aria-invalid', String(Boolean(error) && /Start/.test(error)));
    els.firstNumber.setAttribute('aria-invalid', String(Boolean(error) && /first number/.test(error)));
    return {
      ok: Boolean(state) && !error,
      options: {
        position: data.get('position') || 'bottom-center',
        format: data.get('format') || 'n',
        size: SIZES[data.get('size')] || SIZES.medium,
        startOn,
        first,
      },
    };
  }

  function update() {
    if (!state) return;
    const { ok, options } = readOptions();
    const count = ok ? state.count - options.startOn + 1 : state.count;
    const first = ok ? options.first : 1;
    const last = first + count - 1;

    for (const el of els.formatLabels) el.textContent = numberLabel(el.dataset.formatLabel, first, last);
    if (!ok) {
      els.summary.textContent = '';
      return;
    }
    const en = (a, b) => (a === b ? String(a) : `${a}–${b}`);
    els.summary.textContent = options.startOn === 1
      ? `All ${state.count} ${state.count === 1 ? 'page' : 'pages'} will be numbered ${en(first, last)}.`
      : `Pages ${en(options.startOn, state.count)} will be numbered ${en(first, last)}. The pages before are left as they are.`;
    clearResult();
    placeMark(options, numberLabel(options.format, first, last));
    schedulePreview(options.startOn);
  }

  els.form.addEventListener('input', update);
  els.form.addEventListener('change', update);
  els.form.addEventListener('submit', (event) => { event.preventDefault(); addNumbers(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  /* ---------- Preview ---------- */

  /** Puts the sample number where the worker will draw it, in units that scale with the preview. */
  function placeMark(options, label) {
    const shown = state?.shown;
    if (!shown) { els.mark.hidden = true; return; }
    const { width, height } = shown;
    const [vertical, horizontal] = options.position.split('-');
    const mark = els.mark.style;
    mark.fontSize = `${(options.size / width) * 100}cqw`;
    mark.left = mark.right = mark.top = mark.bottom = 'auto';
    mark.transform = 'none';
    // Offsets allow for the space above and below the letters inside a line of text.
    if (vertical === 'top') mark.top = `${((EDGE_MARGIN - 0.13 * options.size) / height) * 100}%`;
    else mark.bottom = `${((EDGE_MARGIN - 0.15 * options.size) / height) * 100}%`;
    if (horizontal === 'left') mark.left = `${(SIDE_MARGIN / width) * 100}%`;
    else if (horizontal === 'right') mark.right = `${(SIDE_MARGIN / width) * 100}%`;
    else { mark.left = '50%'; mark.transform = 'translateX(-50%)'; }
    els.mark.textContent = label;
    els.mark.hidden = false;
    els.caption.textContent = `Preview of page ${shown.page}`;
  }

  function schedulePreview(page) {
    if (state.shown?.page === page) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => showPage(page), 200);
  }

  async function showPage(page) {
    if (!state) return;
    const run = ++previewRun;
    try {
      const [size, url] = await Promise.all([PdfPreview.pageSize(state.doc, page), PdfPreview.thumbnail(state.doc, page, 352)]);
      if (run !== previewRun || !state) { URL.revokeObjectURL(url); return; }
      if (state.shown?.url) URL.revokeObjectURL(state.shown.url);
      state.shown = { page, url, width: size.width, height: size.height };
      els.stamp.style.aspectRatio = `${size.width} / ${size.height}`;
      els.stampImg.src = url;
      const { ok, options } = readOptions();
      if (ok) {
        const count = state.count - options.startOn + 1;
        placeMark(options, numberLabel(options.format, options.first, options.first + count - 1));
      }
    } catch {
      /* no preview: the settings still work */
    }
  }

  /* ---------- Adding numbers ---------- */

  function setBusy(value) {
    busy = value;
    els.workspace.classList.toggle('is-busy', value);
    els.convert.disabled = value;
    els.convert.textContent = value ? 'Adding numbers…' : 'Add page numbers';
    els.cancel.hidden = !value;
    els.fields.disabled = value;
    els.clear.disabled = value;
    zone.setDisabled(value);
    if (value) progress.show(); else progress.hide();
  }

  async function addNumbers() {
    if (busy || !state) return;
    const { ok, options } = readOptions();
    if (!ok) { (els.numbersError.textContent.startsWith('Start') ? els.startOn : els.firstNumber).focus(); return; }

    Site.notify(els.notices, null);
    clearResult();
    const base = Site.baseName(state.file.name);
    const fileName = `${base}-numbered.pdf`;
    progress.set(0, 'Reading the PDF');
    setBusy(true);
    try {
      const bytes = new Uint8Array(await state.file.arrayBuffer());
      job = Site.runJob('pageNumbers', { file: { name: state.file.name, bytes }, options, fileName }, {
        libs: ['pdfLib'],
        transfer: [bytes.buffer],
        onProgress: (v, label) => progress.set(v, label),
      });
      const result = await job.promise;
      showResult(result, state.count);
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Cancelled.', 'info');
      else Site.notify(els.notices, err.message || 'Adding page numbers failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  /* ---------- Result ---------- */

  function showResult({ files, numbered }, total) {
    const [file] = files;
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = 'Page numbers added';
    const summary = document.createElement('p');
    summary.textContent = `${file.name}: ${numbered} of ${total} ${total === 1 ? 'page' : 'pages'} numbered, ${Site.formatBytes(file.bytes.byteLength)}.`;
    els.result.replaceChildren(heading, summary, Site.downloadLink(resultUrls, file, { label: 'Download PDF' }));
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
  Site.warm(['pdfLib']);
})();
