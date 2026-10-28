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
