/*!
 * Nearfile — Image to PDF
 */
(() => {
  'use strict';

  const MAX_FILES = 20;
  const MAX_CANVAS_PIXELS = 16_000_000; // under iOS Safari's canvas limit
  const ACCEPTED = ['jpg', 'png', 'webp'];

  const ICON = {
    x: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    left: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    right: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
    download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>',
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
    form: $('[data-options]'),
    fields: $('[data-option-fields]'),
    orientation: $('[data-orientation]'),
    convert: $('[data-convert]'),
    cancel: $('[data-cancel]'),
    result: $('[data-result]'),
  };
  const progress = Site.progressBar($('[data-progress]'));
  const resultUrls = Site.urlBag();

  let items = [];   // { id, name, size, kind, source: Blob, url }
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
      Site.notify(els.notices, `You’ve reached the limit of ${MAX_FILES} images. Remove some to add others.`);
      return;
    }

    const unsupported = [];
    const broken = [];
    let heic = false;
    let skipped = 0;
    let added = 0;

    for (const file of files) {
      const kind = await Site.sniff(file);
      if (!ACCEPTED.includes(kind)) {
        unsupported.push(file.name);
        if (kind === 'heic') heic = true;
        continue;
      }
      if (added >= room) { skipped += 1; continue; }
      try {
        const prepared = await prepare(file, kind);
        items.push({ id: nextId++, name: file.name, size: file.size, url: URL.createObjectURL(file), ...prepared });
        added += 1;
        render();
      } catch {
        broken.push(file.name);
      }
    }

    const messages = [];
    if (unsupported.length) {
      messages.push(`${Site.listNames(unsupported)} ${unsupported.length === 1 ? 'isn’t' : 'aren’t'} a JPG, PNG or WebP image, so ${unsupported.length === 1 ? 'it was' : 'they were'} left out.`);
    }
    if (heic) {
      messages.push('For iPhone HEIC photos, use the Select images button: your phone hands them over as JPG.');
    }
    if (broken.length) messages.push(`${Site.listNames(broken)} couldn’t be opened and may be damaged.`);
    if (skipped) messages.push(`${skipped} ${skipped === 1 ? 'image was' : 'images were'} left out: the limit is ${MAX_FILES} at a time.`);
    if (messages.length) Site.notify(els.notices, messages.join(' '), added ? 'info' : 'error');
  }

  /**
   * PNG and upright JPG are embedded untouched (no quality loss). WebP, and JPGs
   * whose EXIF data says "rotate me", are redrawn once as high-quality JPG so the
   * PDF shows them the right way up.
   */
  async function prepare(file, kind) {
    if (kind === 'png') return { kind: 'png', source: file };
    if (kind === 'jpg' && (await jpegOrientation(file)) <= 1) return { kind: 'jpg', source: file };
    return { kind: 'jpg', source: await redrawAsJpeg(file) };
  }

  /** Reads the EXIF orientation tag (1–8) from a JPEG. Returns 1 if there isn't one. */
  async function jpegOrientation(file) {
    try {
      const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset);
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
        const length = view.getUint16(offset + 2);
        if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
          const tiff = offset + 10;
          const little = view.getUint16(tiff) === 0x4949;
          const ifd = tiff + view.getUint32(tiff + 4, little);
          const entries = view.getUint16(ifd, little);
          for (let i = 0; i < entries; i += 1) {
            const entry = ifd + 2 + i * 12;
            if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
          }
          return 1;
        }
        offset += 2 + length;
      }
    } catch { /* Truncated or unusual file: treat as upright. */ }
    return 1;
  }

  /** Draws an image on a canvas (the browser applies EXIF rotation) and saves it as JPG. */
  async function redrawAsJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (img.naturalWidth * img.naturalHeight)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; // transparent areas become white, like paper
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.92);
      });
      canvas.width = canvas.height = 0; // frees memory straight away on iOS
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- List ---------- */

  function render(focus) {
    const count = items.length;
    const has = count > 0;
    els.workspace.classList.toggle('has-files', has);
    els.filesBar.hidden = !has;
    els.panel.hidden = !has;
    els.dzTitle.querySelector('.dz-pointer').textContent = has ? 'Drop more images here' : 'Drop images here';
    els.dzTitle.querySelector('.dz-touch').textContent = has ? 'Add more images' : 'Choose images to convert';

    const total = items.reduce((sum, item) => sum + item.size, 0);
    els.count.textContent = `${count} ${count === 1 ? 'image' : 'images'}, ${Site.formatBytes(total)}`;
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
    li.querySelector('img').src = item.url;
    const name = li.querySelector('.thumb__name');
    name.textContent = item.name;
    name.title = item.name;
    li.querySelector('.thumb__size').textContent = Site.formatBytes(item.size);

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
      URL.revokeObjectURL(items[i].url);
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
    items.forEach((item) => URL.revokeObjectURL(item.url));
    items = [];
    clearResult();
    Site.notify(els.notices, null);
    render();
    els.dropzone.querySelector('[data-dz-button]').focus();
  }

  /* ---------- Options ---------- */

  function readOptions() {
    const data = new FormData(els.form);
    return {
      pageSize: data.get('pageSize') || 'a4',
      orientation: data.get('orientation') || 'auto',
      margin: data.get('margin') || 'small',
      output: data.get('output') || 'single',
    };
  }

  function syncOptions() {
    els.orientation.disabled = readOptions().pageSize === 'fit';
  }

  els.form.addEventListener('change', () => { syncOptions(); clearResult(); });
  els.form.addEventListener('submit', (event) => { event.preventDefault(); convert(); });
  els.cancel.addEventListener('click', () => job?.cancel());

  /* ---------- Convert ---------- */

  function setBusy(busy) {
    els.workspace.classList.toggle('is-busy', busy);
    els.convert.disabled = busy;
    els.convert.textContent = busy ? 'Converting…' : 'Convert to PDF';
    els.cancel.hidden = !busy;
    els.fields.disabled = busy;
    els.sortName.disabled = busy;
    zone.setDisabled(busy);
    sortable?.option('disabled', busy);
    if (busy) progress.show(); else progress.hide();
    if (!busy) syncOptions();
  }

  async function convert() {
    if (job) return;
    await queue; // let images that are still being prepared finish
    if (!items.length) return;

    Site.notify(els.notices, null);
    clearResult();
    const options = readOptions();
    const used = new Set();
    const first = Site.baseName(items[0].name);
    options.fileName = items.length === 1 ? `${first}.pdf` : `${first}-and-${items.length - 1}-more.pdf`;
    options.zipName = `${first}-pdfs.zip`;

    progress.set(0, 'Reading images');
    setBusy(true);
    try {
      const images = await Promise.all(items.map(async (item) => ({
        name: item.name,
        kind: item.kind,
        pdfName: Site.uniqueName(`${Site.baseName(item.name)}.pdf`, used),
        bytes: new Uint8Array(await item.source.arrayBuffer()),
      })));
      job = Site.runJob('imagesToPdf', { images, options }, {
        libs: ['pdfLib', 'jszip'],
        transfer: images.map((img) => img.bytes.buffer),
        onProgress: (value, label) => progress.set(value, label),
      });
      const result = await job.promise;
      showResult(result);
    } catch (err) {
      if (err.name === 'AbortError') Site.notify(els.notices, 'Conversion cancelled. Your images are still here.', 'info');
      else Site.notify(els.notices, err.message || 'Conversion failed. Please try again.');
    } finally {
      job = null;
      setBusy(false);
    }
  }

  /* ---------- Result ---------- */

  function downloadButton(file, label) {
    const a = document.createElement('a');
    a.className = 'btn btn--primary btn--large btn--block';
    a.href = resultUrls.add(new Blob([file.bytes], { type: file.type }));
    a.download = file.name;
    a.innerHTML = ICON.download;
    a.append(label);
    return a;
  }

  function showResult({ files, zip }) {
    const heading = document.createElement('h2');
    heading.tabIndex = -1;
    const summary = document.createElement('p');
    const parts = [heading, summary];

    if (zip) {
      heading.textContent = `${files.length} PDFs converted`;
      summary.textContent = `One PDF per image, ${Site.formatBytes(zip.bytes.byteLength)} in total.`;
      parts.push(downloadButton(zip, 'Download all as ZIP'));
      const list = document.createElement('ul');
      list.className = 'result__files';
      list.setAttribute('aria-label', 'Download PDFs one at a time');
      for (const file of files) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = resultUrls.add(new Blob([file.bytes], { type: file.type }));
        a.download = file.name;
        a.innerHTML = ICON.download;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = file.name;
        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = Site.formatBytes(file.bytes.byteLength);
        a.append(name, size);
        li.append(a);
        list.append(li);
      }
      parts.push(list);
    } else {
      const [file] = files;
      const pages = items.length;
      heading.textContent = 'PDF converted';
      summary.textContent = `${file.name}: ${pages} ${pages === 1 ? 'page' : 'pages'}, ${Site.formatBytes(file.bytes.byteLength)}.`;
      parts.push(downloadButton(file, 'Download PDF'));
    }

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn--quiet btn--block';
    again.textContent = 'Start over with new images';
    again.addEventListener('click', reset);
    parts.push(again);

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
  // Letter is the usual paper size in North America and a few other countries.
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    if (['US', 'CA', 'MX', 'PH', 'CL', 'CO'].includes(region)) {
      els.form.querySelector('input[name="pageSize"][value="letter"]').checked = true;
    }
  } catch { /* keep A4 */ }
  syncOptions();
  render();
  ensureSortable();
  Site.warm(['pdfLib', 'jszip']);
})();
