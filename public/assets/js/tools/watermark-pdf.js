/*!
 * Nearfile — Watermark PDF
 * Shows the watermark on a page preview as you change settings, then stamps the PDF in a worker.
 */
(() => {
  'use strict';

  // How much of the space across the page the text may fill. Keep in step with watermark in workers/pdf-worker.js.
  const FILL = { small: 0.35, medium: 0.6, large: 0.85 };
  const COLORS = { gray: [0.5, 0.5, 0.5], red: [0.85, 0.1, 0.1], blue: [0.1, 0.3, 0.8], black: [0, 0, 0] };
  const MAX_TEXT = 60;

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
    text: $('[data-text]'),
    textError: $('[data-text-error]'),
    opacity: $('[data-opacity]'),
    opacityValue: $('[data-opacity-value]'),
    rangeField: $('[data-range-field]'),
    pagesInput: $('[data-pages-input]'),
    pagesError: $('[data-pages-error]'),
    summary: $('[data-summary]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();
  const measure = document.createElement('canvas').getContext('2d');

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
      els.pagesInput.value = '';
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

  const cleanText = () => els.text.value.replace(/\s+/g, ' ').trim();

  /**
   * Reads the form. `pages` is null for every page. `error` is the first problem, if any.
   * Problems are only shown under the fields when `report` is true (on blur or submit), not while typing.
   */
  function readOptions({ report = false } = {}) {
    const data = new FormData(els.form);
    const text = cleanText();
    const choose = data.get('range') === 'choose';
    let textError = '';
    let pagesError = '';
    let pages = null;
    if (!text) textError = 'Type the text for the watermark.';
    else if (text.length > MAX_TEXT) textError = `Keep the text to ${MAX_TEXT} characters or fewer.`;
    if (choose && state) {
      if (!els.pagesInput.value.trim()) pagesError = 'Choose at least one page, for example 1-3, 5.';
      else {
        try { pages = Site.parsePages(els.pagesInput.value, state.count); } catch (err) { pagesError = err.message; }
      }
    }
    const show = (el, input, message) => {
      el.textContent = report ? message : '';
      el.hidden = !(report && message);
      input.setAttribute('aria-invalid', String(report && Boolean(message)));
    };
    show(els.textError, els.text, textError);
    show(els.pagesError, els.pagesInput, pagesError);
    return {
      error: textError || pagesError || null,
      textError,
      options: {
        text,
        fill: FILL[data.get('size')] || FILL.medium,
        angle: Number(data.get('angle')) || 0,
        opacity: Number(els.opacity.value) / 100,
        color: COLORS[data.get('color')] || COLORS.gray,
        pages,
      },
    };
  }

  function update(event) {
    if (!state) return;
    els.opacityValue.textContent = `${els.opacity.value}%`;
    els.rangeField.hidden = new FormData(els.form).get('range') !== 'choose';
    const { error, options } = readOptions({ report: event?.type === 'change' });
    clearResult();
    const n = options.pages ? options.pages.length : state.count;
    els.summary.textContent = error ? '' : `The watermark goes on ${options.pages ? `${n} of ${state.count}` : `all ${state.count}`} ${state.count === 1 ? 'page' : 'pages'}.`;
    placeMark(options);
    schedulePreview(options.pages?.[0] ?? 1);
  }

  els.form.addEventListener('input', update);
  els.form.addEventListener('change', update);
  els.form.addEventListener('submit', (event) => { event.preventDefault(); addWatermark(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  /* ---------- Preview ---------- */

  /** Sizes and turns the sample text the way the worker will, in units that scale with the preview. */
  function placeMark(options) {
    const shown = state?.shown;
    if (!shown || !options.text) { els.mark.hidden = true; return; }
    const { width, height } = shown;
    measure.font = 'bold 100px Helvetica, Arial, "Liberation Sans", sans-serif';
    const unit = measure.measureText(options.text).width / 100;
    const radians = (options.angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const room = Math.min(cos > 1e-6 ? width / cos : Infinity, sin > 1e-6 ? height / sin : Infinity);
    const size = Math.max(6, Math.min(240, (options.fill * room) / unit));
    const mark = els.mark.style;
    mark.fontSize = `${(size / width) * 100}cqw`;
    mark.fontWeight = '700';
    mark.left = '50%';
    mark.top = '50%';
    mark.transform = `translate(-50%, -50%) rotate(${-options.angle}deg)`;
    mark.opacity = String(options.opacity);
    mark.color = `rgb(${options.color.map((c) => Math.round(c * 255)).join(' ')})`;
    els.mark.textContent = options.text;
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
      placeMark(readOptions().options);
    } catch {
      /* no preview: the settings still work */
    }
  }

  /* ---------- Adding the watermark ---------- */

  function setBusy(value) {
    busy = value;
    els.workspace.classList.toggle('is-busy', value);
    els.convert.disabled = value;
    els.convert.textContent = value ? 'Adding watermark…' : 'Add watermark';
    els.cancel.hidden = !value;
    els.fields.disabled = value;
    els.clear.disabled = value;
    zone.setDisabled(value);
    if (value) progress.show(); else progress.hide();
  }

  async function addWatermark() {
    if (busy || !state) return;
    const { error, textError, options } = readOptions({ report: true });
    if (error) {
      (textError ? els.text : els.pagesInput).focus();
      return;
    }
    Site.notify(els.notices, null);
    clearResult();
    const fileName = `${Site.baseName(state.file.name)}-watermarked.pdf`;
    progress.set(0, 'Reading the PDF');
    setBusy(true);
    try {
      const bytes = new Uint8Array(await state.file.arrayBuffer());
      job = Site.runJob('watermark', { file: { name: state.file.name, bytes }, options, fileName }, {
        libs: ['pdfLib'],
        transfer: [bytes.buffer],
        onProgress: (v, label) => progress.set(v, label),
      });
      const result = await job.promise;
      showResult(result, state.count);
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Cancelled.', 'info');
      else Site.notify(els.notices, err.message || 'Adding the watermark failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  /* ---------- Result ---------- */

  function showResult({ files, marked }, total) {
    const [file] = files;
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = 'Watermark added';
    const summary = document.createElement('p');
    summary.textContent = `${file.name}: ${marked} of ${total} ${total === 1 ? 'page' : 'pages'} marked, ${Site.formatBytes(file.bytes.byteLength)}.`;
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
