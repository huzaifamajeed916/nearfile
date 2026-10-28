/*!
 * Nearfile — Rotate & delete PDF pages
 */
(() => {
  'use strict';

  const ICON = {
    left: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
    right: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"/><path d="M10 4h4"/><path d="M7 7l1 13h8l1-13"/></svg>',
  };

  const $ = (selector) => document.querySelector(selector);
  const els = {
    workspace: $('[data-workspace]'),
    dropzone: $('[data-dropzone]'),
    dzTitle: $('[data-dz-title]'),
    notices: $('[data-notices]'),
    filesBar: $('[data-files-bar]'),
    info: $('[data-file-info]'),
    clear: $('[data-clear]'),
    allLeft: $('[data-all-left]'),
    allRight: $('[data-all-right]'),
    undo: $('[data-reset]'),
    pages: $('[data-pages]'),
    panel: $('[data-panel]'),
    summary: $('[data-summary]'),
    form: $('[data-options]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let state = null; // { file, doc, grid, rotations: number[], deleted: Set<number> (1-based) }
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
      const grid = PdfPreview.pageGrid(els.pages, doc, { extra: addControls });
      state = { file, doc, grid, rotations: new Array(doc.numPages).fill(0), deleted: new Set() };
      if (onlyFirst) Site.notify(els.notices, onlyFirst.trim(), 'info');
    } catch (err) {
      Site.notify(els.notices, err.message);
    }
    render();
  }

  function addControls(card, n) {
    const tools = document.createElement('span');
    tools.className = 'page__tools';
    tools.innerHTML = `
      <button type="button" class="mini-btn" data-action="left">${ICON.left}</button>
      <button type="button" class="mini-btn" data-action="right">${ICON.right}</button>
      <button type="button" class="mini-btn mini-btn--delete" data-action="delete" aria-pressed="false">${ICON.trash}</button>`;
    const [left, right, del] = tools.querySelectorAll('button');
    left.setAttribute('aria-label', `Rotate page ${n} left`);
    right.setAttribute('aria-label', `Rotate page ${n} right`);
    del.setAttribute('aria-label', `Delete page ${n}`);
    card.append(tools);
  }

  function unload() {
    if (!state) return;
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
    if (!has) return;
    const n = state.doc.numPages;
    els.info.textContent = `${state.file.name}: ${n} ${n === 1 ? 'page' : 'pages'}, ${Site.formatBytes(state.file.size)}`;
    paint();
  }

  /** Shows each page's rotation and deleted state, and sums up the changes. */
  function paint() {
    const { rotations, deleted } = state;
    for (const [n, card] of state.grid.cards) {
      const turn = rotations[n - 1];
      card.querySelector('img').style.transform = turn ? `rotate(${turn}deg)` : '';
      const isDeleted = deleted.has(n);
      card.classList.toggle('is-deleted', isDeleted);
      const del = card.querySelector('[data-action="delete"]');
      del.setAttribute('aria-pressed', String(isDeleted));
      del.setAttribute('aria-label', isDeleted ? `Keep page ${n}` : `Delete page ${n}`);
      card.querySelector('.page__label').textContent = isDeleted ? `Page ${n} deleted` : `Page ${n}`;
    }

    const rotated = rotations.filter((r) => r % 360 !== 0).length;
    const kept = rotations.length - deleted.size;
    const changes = [];
    if (rotated) changes.push(`${rotated} ${rotated === 1 ? 'page' : 'pages'} turned`);
    if (deleted.size) changes.push(`${deleted.size} deleted`);

    if (!kept) {
      els.summary.textContent = 'Every page is marked for deletion. Keep at least one page to save the PDF.';
    } else if (!changes.length) {
      els.summary.textContent = 'No changes yet. Use the buttons under each page, or turn all pages at once.';
    } else {
      els.summary.textContent = `${changes.join(', ')}. The new PDF will have ${kept} ${kept === 1 ? 'page' : 'pages'}.`;
    }
    els.convert.disabled = Boolean(job) || !kept || !changes.length;
    els.undo.disabled = Boolean(job) || !changes.length;
  }

  /* ---------- Editing ---------- */

  const normalise = (deg) => ((deg % 360) + 360) % 360;

  els.pages.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state || job) return;
    const n = Number(button.closest('.page').dataset.page);
    const action = button.dataset.action;
    if (action === 'delete') {
      if (state.deleted.has(n)) state.deleted.delete(n); else state.deleted.add(n);
    } else {
      // Keep counting past 360 so the thumbnail always turns the short way round.
      state.rotations[n - 1] += action === 'left' ? -90 : 90;
    }
    clearResult();
    paint();
  });

  function rotateAll(delta) {
    if (!state || job) return;
    state.rotations = state.rotations.map((r, i) => (state.deleted.has(i + 1) ? r : r + delta));
    clearResult();
    paint();
  }

  els.allLeft.addEventListener('click', () => rotateAll(-90));
  els.allRight.addEventListener('click', () => rotateAll(90));
  els.undo.addEventListener('click', () => {
    if (!state || job) return;
    state.rotations.fill(0);
    state.deleted.clear();
    clearResult();
    paint();
  });
  els.clear.addEventListener('click', () => {
    if (job) job.cancel();
    unload();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  });

  /* ---------- Saving ---------- */

  function setBusy(busy) {
    els.workspace.classList.toggle('is-busy', busy);
    els.convert.textContent = busy ? 'Saving…' : 'Save PDF';
    els.cancel.hidden = !busy;
    for (const button of [els.allLeft, els.allRight, els.clear]) button.disabled = busy;
    zone.setDisabled(busy);
    if (busy) progress.show(); else progress.hide();
    paint();
  }

  els.form.addEventListener('submit', (event) => { event.preventDefault(); save(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  async function save() {
    if (job || !state) return;
    const kept = state.rotations.length - state.deleted.size;
    if (!kept) return;

    Site.notify(els.notices, null);
    clearResult();
    const fileName = `${Site.baseName(state.file.name)}-edited.pdf`;
    progress.set(0, 'Reading the PDF');
    job = { cancel() {} }; // marks the tool busy while the file is read
    setBusy(true);
    try {
      const file = { name: state.file.name, bytes: new Uint8Array(await state.file.arrayBuffer()) };
      job = Site.runJob('editPages', {
        file,
        rotations: state.rotations.map(normalise),
        remove: [...state.deleted].map((n) => n - 1),
        fileName,
      }, {
        libs: ['pdfLib'],
        transfer: [file.bytes.buffer],
        onProgress: (value, label) => progress.set(value, label),
      });
      const { files: [edited] } = await job.promise;
      showResult(edited, kept);
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Saving cancelled. Your changes are still here.', 'info');
      else Site.notify(els.notices, err.message || 'Saving failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  function showResult(file, pages) {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = 'PDF saved';
    const summary = document.createElement('p');
    summary.textContent = `${file.name}: ${pages} ${pages === 1 ? 'page' : 'pages'}, ${Site.formatBytes(file.bytes.byteLength)}.`;
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
