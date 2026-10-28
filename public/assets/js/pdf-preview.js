/*!
 * Nearfile PDF preview helpers (PDF.js)
 * Opens PDFs, draws page thumbnails and full-size page images, and builds the
 * page grids used by PDF to image, Split PDF and Rotate PDF. Exposes window.PdfPreview.
 */
(() => {
  'use strict';

  const DIST = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
  const MAX_PIXELS = 16_000_000; // under iOS Safari's canvas limit
  const CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  let ready = null;

  /** Loads PDF.js and starts its worker from code the browser has verified. */
  function lib() {
    if (!ready) {
      ready = Promise.all([Site.loadLib('pdfjs'), Site.libSource('pdfjsWorker')])
        .then(([pdfjsLib, workerCode]) => {
          pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
          return pdfjsLib;
        })
        .catch((err) => { ready = null; throw err; });
    }
    return ready;
  }

  /** Opens a PDF file. Errors name the file and say what to do. */
  async function open(file) {
    const pdfjsLib = await lib();
    const data = new Uint8Array(await file.arrayBuffer());
    const task = pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      cMapUrl: DIST + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: DIST + 'standard_fonts/',
    });
    try {
      return await task.promise;
    } catch (err) {
      task.destroy();
      if (err?.name === 'PasswordException') {
        throw new Error(`“${file.name}” is password-protected. Remove the password, then try again.`);
      }
      throw new Error(`“${file.name}” couldn’t be opened. It may be damaged, or not really a PDF.`);
    }
  }

  /** Draws one page onto a white canvas. Scale 1 = 72 DPI. */
  async function renderCanvas(doc, pageNumber, scale) {
    const pdfjsLib = await lib();
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const capped = Math.min(scale, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const viewport = page.getViewport({ scale: capped });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx,
      viewport,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE, // include filled-in form fields
    }).promise;
    page.cleanup();
    return { canvas, capped: capped < scale, pointWidth: base.width, pointHeight: base.height };
  }

  const toBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('This page was too large to save as an image.'))), type, quality);
  });

  /**
   * Renders a page at a given DPI and encodes it. Returns { blob, width, height, capped,
   * pointWidth, pointHeight }, where the last two are the page's size as displayed, in points (1/72 inch).
   */
  async function renderImage(doc, pageNumber, { dpi = 150, type = 'image/jpeg', quality = 0.92 } = {}) {
    const { canvas, capped, pointWidth, pointHeight } = await renderCanvas(doc, pageNumber, dpi / 72);
    const { width, height } = canvas;
    const blob = await toBlob(canvas, type, quality);
    canvas.width = canvas.height = 0; // frees memory straight away on iOS
    return { blob, width, height, capped, pointWidth, pointHeight };
  }

  /** A page's size as displayed (after any rotation), in points. */
  async function pageSize(doc, pageNumber) {
    const page = await doc.getPage(pageNumber);
    const { width, height } = page.getViewport({ scale: 1 });
    page.cleanup();
    return { width, height };
  }

  /** A small JPEG of a page for previews, sized for the screen's pixel density. */
  async function thumbnail(doc, pageNumber, cssSize = 180) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const target = cssSize * Math.min(window.devicePixelRatio || 1, 2);
    const scale = target / Math.max(base.width, base.height);
    const { canvas } = await renderCanvas(doc, pageNumber, scale);
    const blob = await toBlob(canvas, 'image/jpeg', 0.8);
    canvas.width = canvas.height = 0;
    return URL.createObjectURL(blob);
  }

  /** Renders thumbnails only when their images scroll near the screen, one at a time. */
  function lazyThumbnails(doc, images, cssSize) {
    const urls = [];
    let queue = Promise.resolve();
    let stopped = false;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        observer.unobserve(img);
        queue = queue.then(async () => {
          if (stopped) return;
          try {
            const url = await thumbnail(doc, Number(img.dataset.page), cssSize);
            if (stopped) { URL.revokeObjectURL(url); return; }
            urls.push(url);
            img.src = url;
          } catch { /* leave the blank page placeholder */ }
        });
      }
    }, { rootMargin: '300px 0px' });
    images.forEach((img) => observer.observe(img));
    return {
      stop() {
        stopped = true;
        observer.disconnect();
        urls.forEach((url) => URL.revokeObjectURL(url));
      },
    };
  }

  /**
   * Fills a list with one card per page. Selectable cards are toggle buttons.
   * extra(card, n) can add tool-specific controls. Returns { cards, destroy, setSelectable }.
   */
  function pageGrid(list, doc, { selectable = false, size = 160, extra } = {}) {
    const cards = new Map();
    const items = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const li = document.createElement('li');
      const card = document.createElement(selectable ? 'button' : 'div');
      card.className = 'page';
      card.dataset.page = n;
      if (selectable) {
        card.type = 'button';
        card.setAttribute('aria-pressed', 'false');
      }
      card.innerHTML = `<span class="page__preview"><img alt="" data-page="${n}"></span><span class="page__label"></span>${selectable ? `<span class="page__check">${CHECK}</span>` : ''}`;
      card.querySelector('.page__label').textContent = `Page ${n}`;
      extra?.(card, n);
      li.append(card);
      items.push(li);
      cards.set(n, card);
    }
    list.replaceChildren(...items);
    const lazy = lazyThumbnails(doc, list.querySelectorAll('img[data-page]'), size);

    return {
      cards,
      /** Turns selection on or off (for example, Split's "every page" mode). */
      setSelectable(on) {
        list.classList.toggle('is-static', !on);
        for (const card of cards.values()) {
          card.disabled = !on;
          if (!on) card.removeAttribute('aria-pressed');
        }
      },
      destroy() {
        lazy.stop();
        list.replaceChildren();
      },
    };
  }

  /**
   * Keeps a page grid and a "pages" text field in step: clicking a page updates
   * the text, typing updates the highlighted pages. Returns { pages(), selectAll(), clear(), refresh() }.
   */
  function bindSelection({ grid, list, input, error, pageCount, onChange }) {
    let selected = new Set();

    const showError = (message) => {
      error.textContent = message || '';
      error.hidden = !message;
      input.setAttribute('aria-invalid', String(Boolean(message)));
    };
    const paint = (notify = true) => {
      for (const [n, card] of grid.cards) {
        if (!card.disabled) card.setAttribute('aria-pressed', String(selected.has(n)));
      }
      if (notify) onChange?.(selected.size);
    };
    const setFromNumbers = (numbers) => {
      selected = new Set(numbers);
      input.value = Site.formatPages(numbers);
      showError(null);
      paint();
    };
    const onClick = (event) => {
      const card = event.target.closest('button.page');
      if (!card || card.disabled) return;
      const n = Number(card.dataset.page);
      if (selected.has(n)) selected.delete(n); else selected.add(n);
      setFromNumbers([...selected]);
    };
    const onInput = () => {
      if (!input.value.trim()) { selected = new Set(); showError(null); paint(); return; }
      try { selected = new Set(Site.parsePages(input.value, pageCount)); showError(null); paint(); } catch { /* wait until they finish typing */ }
    };
    const onChangeEvent = () => {
      if (!input.value.trim()) return;
      try { Site.parsePages(input.value, pageCount); showError(null); } catch (err) { showError(err.message); }
    };

    list.addEventListener('click', onClick);
    input.addEventListener('input', onInput);
    input.addEventListener('change', onChangeEvent);

    return {
      /** Pages in the order typed. Shows the problem and throws if the text is invalid. */
      pages() {
        try {
          const pages = Site.parsePages(input.value, pageCount);
          showError(null);
          return pages;
        } catch (err) {
          showError(err.message);
          input.focus();
          throw err;
        }
      },
      count: () => selected.size,
      selectAll() { setFromNumbers(Array.from({ length: pageCount }, (_, i) => i + 1)); },
      clear() { setFromNumbers([]); },
      /** Repaints the highlighted pages without reporting a change. */
      refresh: () => paint(false),
      destroy() {
        list.removeEventListener('click', onClick);
        input.removeEventListener('input', onInput);
        input.removeEventListener('change', onChangeEvent);
        input.value = '';
        showError(null);
      },
    };
  }

  /** Starts loading PDF.js early, so tools work offline once the page has loaded. */
  function warm() {
    const run = () => lib().catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 600);
  }

  window.PdfPreview = Object.freeze({ open, renderImage, pageSize, thumbnail, pageGrid, bindSelection, warm });
})();
