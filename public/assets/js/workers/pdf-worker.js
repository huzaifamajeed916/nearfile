/*!
 * Nearfile PDF worker: builds and edits PDFs with pdf-lib, off the main thread.
 */
'use strict';
importScripts('common.js');

async function newDocument() {
  const doc = await self.PDFLib.PDFDocument.create();
  doc.setCreator('Nearfile');
  doc.setProducer('Nearfile');
  return doc;
}

async function loadPdf(file) {
  try {
    return await self.PDFLib.PDFDocument.load(file.bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(String(err?.message))) {
      throw new Error(`“${file.name}” is protected with a password or permissions lock. Remove the protection, then try again.`);
    }
    throw new Error(`“${file.name}” couldn’t be read. It may be damaged, or not really a PDF.`);
  }
}

const pdfFile = (name, bytes) => ({ name, type: 'application/pdf', bytes });

/* ---------- Image → PDF ---------- */

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] }; // points (1/72 inch)
const MARGINS = { none: 0, small: 28.35, large: 56.7 };           // 0, 10 mm, 20 mm
const PX_TO_PT = 0.75;                                              // 96 px per inch
const MAX_PAGE_SIDE = 14400;                                        // PDF viewer limit

function addImagePage(doc, image, { pageSize, orientation }, margin) {
  const iw = image.width;
  const ih = image.height;

  if (pageSize === 'fit') {
    let w = iw * PX_TO_PT;
    let h = ih * PX_TO_PT;
    const scale = Math.min(1, (MAX_PAGE_SIDE - 2 * margin) / w, (MAX_PAGE_SIDE - 2 * margin) / h);
    w *= scale;
    h *= scale;
    const page = doc.addPage([w + 2 * margin, h + 2 * margin]);
    page.drawImage(image, { x: margin, y: margin, width: w, height: h });
    return;
  }

  let [pw, ph] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
  const landscape = orientation === 'landscape' || (orientation !== 'portrait' && iw > ih);
  if (landscape) [pw, ph] = [ph, pw];

  const scale = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin) / ih);
  const w = iw * scale;
  const h = ih * scale;
  const page = doc.addPage([pw, ph]);
  page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

async function embedImage(doc, img) {
  try {
    return img.kind === 'png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
  } catch {
    throw new Error(`“${img.name}” couldn’t be read. The file may be damaged. Try opening and re-saving it.`);
  }
}

/**
 * payload.images:  [{ name, pdfName, kind: 'jpg' | 'png', bytes }]
 * payload.options: { pageSize, orientation, margin, output: 'single' | 'separate', fileName, zipName }
 */
tasks.imagesToPdf = async ({ images, options }, libs) => {
  progress(0.02, 'Loading the PDF engine');
  await use(libs.pdfLib);
  const separate = options.output === 'separate' && images.length > 1;
  const margin = MARGINS[options.margin] ?? 0;
  const total = images.length;

  if (!separate) {
    const doc = await newDocument();
    for (let i = 0; i < total; i += 1) {
      progress(0.05 + (i / total) * 0.8, `Adding image ${i + 1} of ${total}`);
      addImagePage(doc, await embedImage(doc, images[i]), options, margin);
      images[i].bytes = null; // let memory go as we move on
    }
    progress(0.9, 'Saving the PDF');
    return { files: [pdfFile(options.fileName, await doc.save())], zip: null };
  }

  const files = [];
  for (let i = 0; i < total; i += 1) {
    progress(0.05 + (i / total) * 0.8, `Making PDF ${i + 1} of ${total}`);
    const doc = await newDocument();
    addImagePage(doc, await embedImage(doc, images[i]), options, margin);
    images[i].bytes = null;
    files.push(pdfFile(images[i].pdfName, await doc.save()));
  }
  progress(0.9, 'Packing the ZIP');
  return { files, zip: await makeZip(files, options.zipName, libs) };
};

/* ---------- Merge ---------- */

/** payload: { files: [{ name, bytes }], fileName } */
tasks.merge = async ({ files, fileName }, libs) => {
  progress(0.02, 'Loading the PDF engine');
  await use(libs.pdfLib);
  const out = await newDocument();
  const total = files.length;
  for (let i = 0; i < total; i += 1) {
    progress(0.05 + (i / total) * 0.82, `Adding PDF ${i + 1} of ${total}`);
    const src = await loadPdf(files[i]);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((page) => out.addPage(page));
    files[i].bytes = null;
  }
  progress(0.9, 'Saving the merged PDF');
  return { files: [pdfFile(fileName, await out.save())], zip: null };
};

/* ---------- Split ---------- */

/** payload: { file: { name, bytes }, pages: [1-based], fileName } */
tasks.extractPages = async ({ file, pages, fileName }, libs) => {
  progress(0.05, 'Loading the PDF engine');
  await use(libs.pdfLib);
  progress(0.2, 'Reading the PDF');
  const src = await loadPdf(file);
  const out = await newDocument();
  progress(0.45, `Copying ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
  const copied = await out.copyPages(src, pages.map((n) => n - 1));
  copied.forEach((page) => out.addPage(page));
  progress(0.85, 'Saving the PDF');
  return { files: [pdfFile(fileName, await out.save())], zip: null };
};

/** payload: { file: { name, bytes }, pages: [1-based], names: [file name per page], zipName } */
tasks.splitPages = async ({ file, pages, names, zipName }, libs) => {
  progress(0.03, 'Loading the PDF engine');
  await use(libs.pdfLib);
  progress(0.08, 'Reading the PDF');
  const src = await loadPdf(file);
  file.bytes = null;
  const files = [];
  for (let i = 0; i < pages.length; i += 1) {
    progress(0.1 + (i / pages.length) * 0.75, `Saving page ${pages[i]} (${i + 1} of ${pages.length})`);
    const doc = await newDocument();
    const [page] = await doc.copyPages(src, [pages[i] - 1]);
    doc.addPage(page);
    files.push(pdfFile(names[i], await doc.save()));
  }
  progress(0.9, 'Packing the ZIP');
  return { files, zip: files.length > 1 ? await makeZip(files, zipName, libs) : null };
};

/* ---------- Rotate & delete ---------- */

/**
 * payload: { file: { name, bytes }, rotations: [degrees to add, per page], remove: [0-based], fileName }
 * Edits the original document in place, so links, form fields and metadata survive.
 */
tasks.editPages = async ({ file, rotations, remove, fileName }, libs) => {
  progress(0.05, 'Loading the PDF engine');
  await use(libs.pdfLib);
  progress(0.25, 'Reading the PDF');
  const doc = await loadPdf(file);
  const { degrees } = self.PDFLib;
  progress(0.5, 'Turning pages');
  doc.getPages().forEach((page, i) => {
    const add = rotations[i] || 0;
    if (add) page.setRotation(degrees((((page.getRotation().angle + add) % 360) + 360) % 360));
  });
  [...remove].sort((a, b) => b - a).forEach((index) => doc.removePage(index));
  progress(0.8, 'Saving the PDF');
  return { files: [pdfFile(fileName, await doc.save())], zip: null };
};

/* ---------- Compress ---------- */

const MAX_IMAGE_PIXELS = 40_000_000; // decoded size above which an image is left alone
const MIN_IMAGE_BYTES = 12 * 1024;   // smaller images aren't worth any loss of quality
const canRecompressImages = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
const canDeflate = typeof CompressionStream === 'function';

const nameOf = (value) => (value instanceof self.PDFLib.PDFName ? value.decodeText() : null);
const numberOf = (value) => (value instanceof self.PDFLib.PDFNumber ? value.asNumber() : null);

/** Deletes objects that nothing points to, such as pages and pictures left behind by earlier edits. */
function dropUnreachable(doc) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = self.PDFLib;
  const { context } = doc;
  const seen = new Set();
  const stack = [context.trailerInfo.Root, context.trailerInfo.Info, context.trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    const value = stack.pop();
    if (value instanceof PDFRef) {
      if (seen.has(value.tag)) continue;
      seen.add(value.tag);
      const target = context.lookup(value);
      if (target) stack.push(target);
    } else if (value instanceof PDFDict) {
      for (const child of value.values()) stack.push(child);
    } else if (value instanceof PDFArray) {
      for (const child of value.asArray()) stack.push(child);
    } else if (value instanceof PDFStream) {
      stack.push(value.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) context.delete(ref);
  }
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Squeezes streams that were stored uncompressed (common in PDFs made by simple tools). */
async function packPlainStreams(doc, onStep) {
  const { PDFName, PDFRawStream } = self.PDFLib;
  const { context } = doc;
  const entries = context.enumerateIndirectObjects();
  for (let i = 0; i < entries.length; i += 1) {
    const [ref, object] = entries[i];
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.has(PDFName.of('Filter')) || dict.has(PDFName.of('DecodeParms'))) continue;
    const type = nameOf(dict.lookup(PDFName.of('Type')));
    if (type === 'Metadata' || type === 'XRef' || type === 'ObjStm') continue;
    if (object.contents.length < 512) continue;
    const packed = await deflate(object.contents);
    if (packed.length >= object.contents.length * 0.95) continue;
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    context.assign(ref, PDFRawStream.of(dict, packed));
    if (i % 50 === 0) onStep(i / entries.length);
  }
}

function filterNames(context, dict) {
  const { PDFName, PDFArray } = self.PDFLib;
  const filter = dict.lookup(PDFName.of('Filter'));
  if (!filter) return [];
  if (filter instanceof PDFArray) return filter.asArray().map((item) => nameOf(context.lookup(item)) || '?');
  return [nameOf(filter) || '?'];
}

/** Number of colour channels for colour spaces that map straight to red-green-blue or grey. 0 = unsupported. */
function channelsOf(context, space) {
  const { PDFArray, PDFStream, PDFName } = self.PDFLib;
  const value = context.lookup(space);
  const name = nameOf(value);
  if (name) return name === 'DeviceRGB' ? 3 : name === 'DeviceGray' ? 1 : 0;
  if (value instanceof PDFArray && value.size() > 0) {
    const kind = nameOf(context.lookup(value.get(0)));
    if (kind === 'CalRGB') return 3;
    if (kind === 'CalGray') return 1;
    if (kind === 'ICCBased') {
      const profile = context.lookup(value.get(1));
      const n = profile instanceof PDFStream ? numberOf(profile.dict.lookup(PDFName.of('N'))) : null;
      return n === 3 || n === 1 ? n : 0;
    }
  }
  return 0;
}

/** Says whether an image is one we can safely re-encode, and how. Returns null to leave it alone. */
function describeImage(context, stream) {
  const { PDFName, PDFBool } = self.PDFLib;
  const dict = stream.dict;
  const get = (key) => dict.lookup(PDFName.of(key));
  if (nameOf(get('Subtype')) !== 'Image') return null;
  if (get('ImageMask') === PDFBool.True) return null;
  for (const key of ['Mask', 'Decode', 'SMaskInData']) if (dict.has(PDFName.of(key))) return null;
  const width = numberOf(get('Width'));
  const height = numberOf(get('Height'));
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) return null;
  if ((numberOf(get('BitsPerComponent')) ?? 8) !== 8) return null;
  const filters = filterNames(context, dict);
  const kind = filters.length === 1 && filters[0] === 'DCTDecode' ? 'jpeg'
    : filters.length === 1 && filters[0] === 'FlateDecode' ? 'flate' : null;
  if (!kind) return null;
  const channels = channelsOf(context, dict.get(PDFName.of('ColorSpace')));
  return channels ? { width, height, kind, channels } : null;
}

async function decodeJpeg(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  try {
    // Keep the numbers exactly as stored, and ignore any rotation tag: PDF viewers do the same.
    return await createImageBitmap(blob, { colorSpaceConversion: 'none', imageOrientation: 'none' });
  } catch {
    return createImageBitmap(blob);
  }
}

/** True for flat-colour artwork (diagrams, screenshots): JPEG would blur it for little gain. */
function looksLikeArtwork(raw, channels, pixels) {
  const seen = new Set();
  const step = Math.max(1, Math.floor(pixels / 20000));
  for (let p = 0; p < pixels; p += step) {
    const i = p * channels;
    seen.add(channels === 3 ? (raw[i] << 16) | (raw[i + 1] << 8) | raw[i + 2] : raw[i]);
    if (seen.size > 256) return false;
  }
  return true;
}

/**
 * pdf-lib inflates Flate data but doesn't undo the row filters ("predictors") that PNG-style
 * pictures use, so that is done here. Returns null for anything unexpected: the picture is then left alone.
 */
function undoPredictor(context, stream, info, data) {
  const { PDFName, PDFArray, PDFDict } = self.PDFLib;
  let params = stream.dict.lookup(PDFName.of('DecodeParms'));
  if (params instanceof PDFArray) params = context.lookup(params.get(0));
  const get = (key, fallback) => (params instanceof PDFDict ? numberOf(params.lookup(PDFName.of(key))) : null) ?? fallback;

  const predictor = get('Predictor', 1);
  const rowBytes = info.width * info.channels;
  if (predictor === 1) return data.length >= rowBytes * info.height ? data : null;
  if (get('Colors', 1) !== info.channels || get('BitsPerComponent', 8) !== 8 || get('Columns', 1) !== info.width) return null;

  if (predictor === 2) { // TIFF: each byte is the difference from the same colour one pixel to the left
    if (data.length < rowBytes * info.height) return null;
    const out = data.slice(0, rowBytes * info.height);
    for (let y = 0; y < info.height; y += 1) {
      const row = y * rowBytes;
      for (let i = info.channels; i < rowBytes; i += 1) out[row + i] = (out[row + i] + out[row + i - info.channels]) & 255;
    }
    return out;
  }
  if (predictor < 10) return null;

  // PNG: every row starts with a byte naming how it was filtered.
  const stride = rowBytes + 1;
  if (data.length < stride * info.height) return null;
  const out = new Uint8Array(rowBytes * info.height);
  const bpp = info.channels;
  for (let y = 0; y < info.height; y += 1) {
    const type = data[y * stride];
    const src = y * stride + 1;
    const dst = y * rowBytes;
    const above = dst - rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const x = data[src + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = y > 0 ? out[above + i] : 0;
      let value;
      if (type === 0) value = x;
      else if (type === 1) value = x + left;
      else if (type === 2) value = x + up;
      else if (type === 3) value = x + ((left + up) >> 1);
      else if (type === 4) {
        const upLeft = y > 0 && i >= bpp ? out[above + i - bpp] : 0;
        const guess = left + up - upLeft;
        const pa = Math.abs(guess - left);
        const pb = Math.abs(guess - up);
        const pc = Math.abs(guess - upLeft);
        value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else return null;
      out[dst + i] = value & 255;
    }
  }
  return out;
}

/** Draws an image into a canvas at its new size. Returns null if it can't be read as expected. */
async function drawImage(context, stream, info, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency: transparent areas are held by the picture's own mask
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';

  if (info.kind === 'jpeg') {
    const bitmap = await decodeJpeg(stream.contents);
    if (bitmap.width !== info.width || bitmap.height !== info.height) { bitmap.close(); return null; }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas;
  }

  const raw = undoPredictor(context, stream, info, self.PDFLib.decodePDFRawStream(stream).decode());
  if (!raw) return null;
  const pixels = info.width * info.height;
  if (width === info.width && looksLikeArtwork(raw, info.channels, pixels)) return null;
  const rgba = new ImageData(info.width, info.height);
  const out = rgba.data;
  if (info.channels === 3) {
    for (let p = 0, i = 0, o = 0; p < pixels; p += 1, i += 3, o += 4) {
      out[o] = raw[i]; out[o + 1] = raw[i + 1]; out[o + 2] = raw[i + 2]; out[o + 3] = 255;
    }
  } else {
    for (let p = 0, o = 0; p < pixels; p += 1, o += 4) {
      out[o] = out[o + 1] = out[o + 2] = raw[p];
      out[o + 3] = 255;
    }
  }
  if (width === info.width) {
    ctx.putImageData(rgba, 0, 0);
  } else {
    const full = new OffscreenCanvas(info.width, info.height);
    full.getContext('2d').putImageData(rgba, 0, 0);
    ctx.drawImage(full, 0, 0, width, height);
  }
  return canvas;
}

/**
 * Re-encodes big JPEG and uncompressed photos at lower quality and, if asked, a smaller size.
 * A picture is only replaced when the new version is at least 10% smaller.
 */
async function recompressImages(doc, { quality, maxSide }, onStep) {
  const { PDFName, PDFNumber, PDFRawStream, PDFRef } = self.PDFLib;
  const { context } = doc;
  const entries = context.enumerateIndirectObjects();
  const stats = { found: 0, changed: 0 };

  // A picture used as the transparency of another picture has to stay exactly as it is.
  const masks = new Set();
  for (const [, object] of entries) {
    if (!(object instanceof PDFRawStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const target = object.dict.get(PDFName.of(key));
      if (target instanceof PDFRef) masks.add(target.tag);
    }
  }

  const todo = [];
  for (const [ref, object] of entries) {
    if (!(object instanceof PDFRawStream) || masks.has(ref.tag)) continue;
    const info = describeImage(context, object);
    if (info && object.contents.length >= MIN_IMAGE_BYTES) todo.push({ ref, object, info });
  }
  stats.found = todo.length;

  for (let i = 0; i < todo.length; i += 1) {
    onStep(i / todo.length, i + 1, todo.length);
    const { ref, object, info } = todo[i];
    try {
      const scale = maxSide ? Math.min(1, maxSide / Math.max(info.width, info.height)) : 1;
      const width = Math.max(1, Math.round(info.width * scale));
      const height = Math.max(1, Math.round(info.height * scale));
      const canvas = await drawImage(context, object, info, width, height);
      if (!canvas) continue;
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (blob.type !== 'image/jpeg' || blob.size >= object.contents.length * 0.9) continue;

      const next = object.dict.clone(context);
      for (const key of ['Filter', 'DecodeParms', 'DP', 'F', 'FFilter', 'FDecodeParms', 'Length']) next.delete(PDFName.of(key));
      next.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      next.set(PDFName.of('Width'), PDFNumber.of(width));
      next.set(PDFName.of('Height'), PDFNumber.of(height));
      next.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      // Canvas always writes colour JPEGs, so a grey picture becomes a (grey-looking) RGB one.
      if (info.channels === 1) next.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      context.assign(ref, PDFRawStream.of(next, new Uint8Array(await blob.arrayBuffer())));
      stats.changed += 1;
    } catch {
      /* leave this picture as it was */
    }
  }
  return stats;
}

/**
 * payload: { file: { name, bytes }, options: { images: bool, quality: 0..1, maxSide: px }, fileName }
 * Returns { files: [pdf] | [], kept, originalSize, stats }. kept = the result wasn't smaller.
 */
tasks.compressPdf = async ({ file, options, fileName }, libs) => {
  progress(0.03, 'Loading the PDF engine');
  await use(libs.pdfLib);
  progress(0.08, 'Reading the PDF');
  const originalSize = file.bytes.byteLength;
  const doc = await loadPdf(file);
  file.bytes = null;
  const { PDFName } = self.PDFLib;
  let stats = { found: 0, changed: 0 };

  doc.getPages().forEach((page) => page.node.delete(PDFName.of('Thumb')));

  if (options.images && canRecompressImages) {
    stats = await recompressImages(doc, options, (value, n, total) => {
      progress(0.12 + value * 0.6, `Compressing picture ${n} of ${total}`);
    });
  }
  progress(0.74, 'Removing leftovers');
  dropUnreachable(doc);
  if (canDeflate) {
    progress(0.78, 'Packing the data');
    await packPlainStreams(doc, (value) => progress(0.78 + value * 0.1, 'Packing the data'));
  }
  progress(0.9, 'Saving the PDF');
  const bytes = await doc.save({ useObjectStreams: true });
  if (bytes.byteLength >= originalSize) return { files: [], kept: true, originalSize, stats };
  return { files: [pdfFile(fileName, bytes)], kept: false, originalSize, stats };
};

/**
 * Builds a PDF from page pictures, each page keeping its original size.
 * payload: { pages: [{ bytes (JPEG), width, height (points) }], originalSize, fileName }
 */
tasks.picturesToPdf = async ({ pages, originalSize, fileName }, libs) => {
  progress(0.02, 'Loading the PDF engine');
  await use(libs.pdfLib);
  const doc = await newDocument();
  for (let i = 0; i < pages.length; i += 1) {
    progress(0.05 + (i / pages.length) * 0.85, `Adding page ${i + 1} of ${pages.length}`);
    const { width, height } = pages[i];
    const image = await doc.embedJpg(pages[i].bytes);
    pages[i].bytes = null;
    doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  progress(0.92, 'Saving the PDF');
  const bytes = await doc.save();
  if (bytes.byteLength >= originalSize) return { files: [], kept: true, originalSize };
  return { files: [pdfFile(fileName, bytes)], kept: false, originalSize };
};

/* ---------- Stamping pages (page numbers, watermark) ---------- */

/**
 * Pages can be turned with /Rotate and may not start at 0,0. These two helpers let a stamp
 * be placed as the page looks on screen: x to the right, y upwards, from the bottom-left corner.
 */
function pageView(page) {
  const box = page.getCropBox();
  const turn = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const sideways = turn === 90 || turn === 270;
  return { box, turn, width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
}

function viewToPage({ box, turn }, x, y) {
  if (turn === 90) return { x: box.x + box.width - y, y: box.y + x };
  if (turn === 180) return { x: box.x + box.width - x, y: box.y + box.height - y };
  if (turn === 270) return { x: box.x + y, y: box.y + box.height - x };
  return { x: box.x + x, y: box.y + y };
}

/** Draws text starting at a point on the page as displayed, turned by `angle` degrees anticlockwise. */
function drawViewText(page, view, text, { x, y, angle = 0, ...style }) {
  const at = viewToPage(view, x, y);
  page.drawText(text, { ...style, x: at.x, y: at.y, rotate: self.PDFLib.degrees(angle + view.turn) });
}

const CAP_HEIGHT = 0.72; // Helvetica's capital letters, as a fraction of the font size

function numberLabel(format, n, last) {
  if (format === 'page') return `Page ${n}`;
  if (format === 'of') return `${n} of ${last}`;
  if (format === 'page-of') return `Page ${n} of ${last}`;
  return String(n);
}

/**
 * payload: { file, fileName, options: { position: 'bottom-center' | 'top-right' | …, format: 'n' | 'page' | 'of' | 'page-of',
 *            startOn: 1-based page to start on, first: number shown on that page, size: points } }
 */
tasks.pageNumbers = async ({ file, options, fileName }, libs) => {
  progress(0.05, 'Loading the PDF engine');
  await use(libs.pdfLib);
  progress(0.2, 'Reading the PDF');
  const doc = await loadPdf(file);
  const { StandardFonts, rgb } = self.PDFLib;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const first = Math.max(0, options.startOn - 1);
  const count = pages.length - first;
  if (count < 1) throw new Error(`This PDF has ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}, so numbering can’t start on page ${options.startOn}.`);
  const last = options.first + count - 1;
  const [vertical, horizontal] = options.position.split('-');
  const sideMargin = 40;
  const edgeMargin = 30;

  for (let i = first; i < pages.length; i += 1) {
    if ((i - first) % 10 === 0) progress(0.3 + ((i - first) / count) * 0.55, `Numbering page ${i + 1} of ${pages.length}`);
    const label = numberLabel(options.format, options.first + (i - first), last);
    const view = pageView(pages[i]);
    const width = font.widthOfTextAtSize(label, options.size);
    const x = horizontal === 'left' ? sideMargin : horizontal === 'right' ? view.width - sideMargin - width : (view.width - width) / 2;
    const y = vertical === 'top' ? view.height - edgeMargin - CAP_HEIGHT * options.size : edgeMargin;
    drawViewText(pages[i], view, label, { x, y, size: options.size, font, color: rgb(0.2, 0.2, 0.2) });
  }
  progress(0.9, 'Saving the PDF');
  return { files: [pdfFile(fileName, await doc.save())], numbered: count };
};

/**
 * payload: { file, fileName, options: { text, fill: 0..1 (share of the space along the text),
 *            angle: degrees anticlockwise, opacity: 0..1, color: [r, g, b] (0..1), pages: [1-based] | null } }
 */
tasks.watermark = async ({ file, options, fileName }, libs) => {
  progress(0.05, 'Loading the PDF engine');
  await use(libs.pdfLib);
  progress(0.2, 'Reading the PDF');
  const doc = await loadPdf(file);
  const { StandardFonts, rgb } = self.PDFLib;
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  let unit;
  try {
    unit = font.widthOfTextAtSize(options.text, 1);
  } catch {
    throw new Error('The watermark can use Latin letters, numbers and common symbols. Other alphabets aren’t supported yet.');
  }
  const pages = doc.getPages();
  const chosen = options.pages ? options.pages.map((n) => n - 1) : pages.map((_, i) => i);
  const radians = (options.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const color = rgb(...options.color);

  for (let k = 0; k < chosen.length; k += 1) {
    if (k % 10 === 0) progress(0.3 + (k / chosen.length) * 0.55, `Marking page ${chosen[k] + 1} of ${pages.length}`);
    const page = pages[chosen[k]];
    const view = pageView(page);
    // Longest straight line through the middle of the page, along the text's direction.
    const room = Math.min(Math.abs(cos) > 1e-6 ? view.width / Math.abs(cos) : Infinity, Math.abs(sin) > 1e-6 ? view.height / Math.abs(sin) : Infinity);
    const size = Math.max(6, Math.min(240, (options.fill * room) / unit));
    const width = unit * size;
    // Start point so that the middle of the text sits on the middle of the page.
    const dx = -width / 2;
    const dy = (-CAP_HEIGHT * size) / 2;
    const x = view.width / 2 + dx * cos - dy * sin;
    const y = view.height / 2 + dx * sin + dy * cos;
    drawViewText(page, view, options.text, { x, y, angle: options.angle, size, font, color, opacity: options.opacity });
  }
  progress(0.9, 'Saving the PDF');
  return { files: [pdfFile(fileName, await doc.save())], marked: chosen.length };
};
