/*!
 * Nearfile — Merge PDF
 */
(() => {
  'use strict';

  const MAX_FILES = 50;
  const ICON = {
    x: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    left: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    right: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  };

  const $ = (selector) => document.querySelector(selector);
  const els = {
    workspace: $('[data-workspace]'),
    dropzone: $('[data-dropzone]'),
    dzTitle: $('[data-dz-title]'),
    notices: $('[data-notices]'),
    filesBar: $('[data-files-bar]'),
    count: $('[data-count]'),
    sortName: $('[data-sort-name]'),
    clear: $('[data-clear]'),
    list: $('[data-thumbs]'),
    panel: $('[data-panel]'),
    summary: $('[data-summary]'),
    form: $('[data-options]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let items = []; // { id, file, name, size, pages, thumb }
  let nextId = 1;
  let job = null;
  let sortable = null;
  let sortableLoad = null;
  let queue = Promise.resolve();

  const zone = Site.dropzone(els.dropzone, {
    onFiles: (files) => { queue = queue.then(() => addFiles(files)); },
  });

  /* ---------- Adding files ---------- */

  async function addFiles(files) {
    Site.notify(els.notices, null);
    clearResult();
    const room = MAX_FILES - items.length;
    if (room <= 0) {
      Site.notify(els.notices, `You’ve reached the limit of ${MAX_FILES} PDFs. Merge these first, then add the result to more files.`);
      return;
    }

    const notPdf = [];
    const locked = [];
    const broken = [];
    let skipped = 0;
    let added = 0;

    for (const file of files) {
      if ((await Site.sniff(file)) !== 'pdf') { notPdf.push(file.name); continue; }
      if (added >= room) { skipped += 1; continue; }
      if (await Site.isEncryptedPdf(file)) { locked.push(file.name); continue; }
      try {
        const doc = await PdfPreview.open(file);
        let thumb = '';
        try { thumb = await PdfPreview.thumbnail(doc, 1, 150); } catch { /* blank preview */ }
        items.push({ id: nextId++, file, name: file.name, size: file.size, pages: doc.numPages, thumb });
        doc.destroy();
        added += 1;
        render();
      } catch (err) {
        if (/password/i.test(err.message)) locked.push(file.name); else broken.push(file.name);
      }
    }

    const messages = [];
    if (notPdf.length) messages.push(`${Site.listNames(notPdf)} ${notPdf.length === 1 ? 'isn’t a PDF' : 'aren’t PDFs'}, so ${notPdf.length === 1 ? 'it was' : 'they were'} left out.`);
    if (locked.length) messages.push(`${Site.listNames(locked)} ${locked.length === 1 ? 'is' : 'are'} protected with a password or permissions lock. Remove the protection, then add ${locked.length === 1 ? 'it' : 'them'} again.`);
    if (broken.length) messages.push(`${Site.listNames(broken)} couldn’t be opened and may be damaged.`);
    if (skipped) messages.push(`${skipped} ${skipped === 1 ? 'file was' : 'files were'} left out: the limit is ${MAX_FILES} at a time.`);
    if (messages.length) Site.notify(els.notices, messages.join(' '), added ? 'info' : 'error');
  }

  /* ---------- List ---------- */

  function render(focus) {
    const count = items.length;
    const has = count > 0;
    els.workspace.classList.toggle('has-files', has);
    els.filesBar.hidden = !has;
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop more PDFs here' : 'Drop PDFs here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Add more PDFs' : 'Choose PDFs to merge';

    const bytes = items.reduce((sum, item) => sum + item.size, 0);
    const pages = items.reduce((sum, item) => sum + item.pages, 0);
    els.count.textContent = `${count} ${count === 1 ? 'PDF' : 'PDFs'}, ${Site.formatBytes(bytes)}`;
    els.summary.textContent = count < 2
      ? 'Add at least one more PDF to merge.'
      : `${pages} ${pages === 1 ? 'page' : 'pages'} in total, in the order shown.`;
    els.convert.disabled = Boolean(job) || count < 2;
    els.list.replaceChildren(...items.map(tile));

    if (focus) {
      const target = els.list.querySelector(`[data-id="${focus.id}"] [data-action="${focus.action}"]:not(:disabled)`)
        || els.list.querySelector(`[data-id="${focus.id}"] [data-action="remove"]`)
        || els.dropzone.querySelector('[data-dz-button]');
      target?.focus();
    }
  }

  function tile(item, index) {
    const li = document.createElement('li');
    li.className = 'thumb';
    li.dataset.id = item.id;
    li.innerHTML = `
      <span class="thumb__index" aria-hidden="true"></span>
      <div class="thumb__preview"><img alt="" decoding="async"></div>
      <button type="button" class="thumb__remove" data-action="remove">${ICON.x}</button>
      <span class="thumb__name"></span>
      <span class="thumb__row">
        <span class="thumb__size"></span>
        <span class="thumb__move">
          <button type="button" data-action="earlier">${ICON.left}</button>
          <button type="button" data-action="later">${ICON.right}</button>
        </span>
      </span>`;
    li.querySelector('.thumb__index').textContent = index + 1;
    if (item.thumb) li.querySelector('img').src = item.thumb;
    const name = li.querySelector('.thumb__name');
    name.textContent = item.name;
    name.title = `${item.name}, ${Site.formatBytes(item.size)}`;
    li.querySelector('.thumb__size').textContent = `${item.pages} ${item.pages === 1 ? 'page' : 'pages'}`;

    const [remove, earlier, later] = li.querySelectorAll('button');
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    earlier.setAttribute('aria-label', `Move ${item.name} earlier`);
    later.setAttribute('aria-label', `Move ${item.name} later`);
    earlier.disabled = index === 0;
    later.disabled = index === items.length - 1;
    return li;
  }

  els.list.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || job) return;
    const id = Number(button.closest('.thumb').dataset.id);
    const i = items.findIndex((item) => item.id === id);
    if (i < 0) return;
    clearResult();

    if (button.dataset.action === 'remove') {
      if (items[i].thumb) URL.revokeObjectURL(items[i].thumb);
      items.splice(i, 1);
      const neighbour = items[i] || items[i - 1];
      render(neighbour ? { id: neighbour.id, action: 'remove' } : { id: -1 });
      return;
    }
    const j = button.dataset.action === 'earlier' ? i - 1 : i + 1;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    render({ id, action: button.dataset.action });
  });

  function ensureSortable() {
    sortableLoad ||= Site.loadLib('sortable')
      .then((Sortable) => {
        sortable = Sortable.create(els.list, {
          animation: 160,
          delay: 180,
          delayOnTouchOnly: true,
          filter: 'button',
          preventOnFilter: false,
          ghostClass: 'is-ghost',
          chosenClass: 'is-chosen',
          dragClass: 'is-drag',
          onEnd() {
            const order = Array.from(els.list.children, (li) => Number(li.dataset.id));
            items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
            clearResult();
            render();
          },
        });
      })
      .catch(() => { /* Drag and drop unavailable; the arrow buttons still reorder. */ });
  }

  els.sortName.addEventListener('click', () => {
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    clearResult();
    render();
  });

  els.clear.addEventListener('click', reset);

  function reset() {
    if (job) job.cancel();
    items.forEach((item) => item.thumb && URL.revokeObjectURL(item.thumb));
    items = [];
    clearResult();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  }

  /* ---------- Merge ---------- */

  function setBusy(busy) {
    els.workspace.classList.toggle('is-busy', busy);
    els.convert.disabled = busy || items.length < 2;
    els.convert.textContent = busy ? 'Merging…' : 'Merge PDFs';
    els.cancel.hidden = !busy;
    els.sortName.disabled = busy;
    zone.setDisabled(busy);
    sortable?.option('disabled', busy);
    if (busy) progress.show(); else progress.hide();
  }

  els.form.addEventListener('submit', (event) => { event.preventDefault(); merge(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  async function merge() {
    if (job) return;
    await queue;
    if (items.length < 2) return;

    Site.notify(els.notices, null);
    clearResult();
    const fileName = `${Site.baseName(items[0].name)}-merged.pdf`;
    const pages = items.reduce((sum, item) => sum + item.pages, 0);
    progress.set(0, 'Reading PDFs');
    setBusy(true);
    try {
      const files = await Promise.all(items.map(async (item) => ({
        name: item.name,
        bytes: new Uint8Array(await item.file.arrayBuffer()),
      })));
      job = Site.runJob('merge', { files, fileName }, {
        libs: ['pdfLib'],
        transfer: files.map((f) => f.bytes.buffer),
        onProgress: (value, label) => progress.set(value, label),
      });
      const { files: [merged] } = await job.promise;
      showResult(merged, pages);
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Merging cancelled. Your PDFs are still here.', 'info');
      else Site.notify(els.notices, err.message || 'Merging failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  function showResult(file, pages) {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    heading.textContent = 'PDFs merged';
    const summary = document.createElement('p');
    summary.textContent = `${file.name}: ${pages} ${pages === 1 ? 'page' : 'pages'}, ${Site.formatBytes(file.bytes.byteLength)}.`;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn--quiet btn--block';
    again.textContent = 'Start over with new PDFs';
    again.addEventListener('click', reset);

    els.result.replaceChildren(heading, summary, Site.downloadLink(resultUrls, file, { label: 'Download merged PDF' }), again);
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
  ensureSortable();
  PdfPreview.warm();
  Site.warm(['pdfLib']);
})();
