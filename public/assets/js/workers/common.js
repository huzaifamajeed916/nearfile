/*!
 * Nearfile worker core, loaded by every worker with importScripts('common.js').
 *
 * In:  { task, payload, libs }   (libs: { name: { url, integrity, code } })
 * Out: { type: 'progress', value: 0..1, label }
 *      { type: 'done', result }
 *      { type: 'error', message }
 */
'use strict';

const LIB_ERROR = 'A part of this tool couldn’t load. Check your connection (or allow cdn.jsdelivr.net if a blocker is on), then try again.';
const loaded = new Set();
const tasks = {};

/**
 * Runs a library in this worker. The page normally passes code it has already
 * fetched and verified (lib.code); otherwise it's fetched here with the same
 * integrity check.
 */
async function use(lib) {
  if (!lib) throw new Error(LIB_ERROR);
  if (loaded.has(lib.url)) return;
  let code = lib.code;
  if (!code) {
    try {
      const res = await fetch(lib.url, { integrity: lib.integrity, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(String(res.status));
      code = await res.text();
    } catch {
      throw new Error(LIB_ERROR);
    }
  }
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    importScripts(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  loaded.add(lib.url);
}

const progress = (value, label) => self.postMessage({ type: 'progress', value, label });

/** Bundles files into a ZIP. Photos and PDFs barely compress, so they're stored as-is: much faster. */
async function makeZip(files, name, libs) {
  await use(libs.jszip);
  const zip = new self.JSZip();
  for (const file of files) zip.file(file.name, file.bytes);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
  return { name, type: 'application/zip', bytes };
}

/** payload: { files: [{ name, bytes }], name } */
tasks.zip = async ({ files, name }, libs) => {
  progress(0.2, 'Packing the ZIP');
  return { zip: await makeZip(files, name, libs) };
};

/** Collects every ArrayBuffer in the result so it moves to the page instead of being copied. */
function transferables(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found;
  if (ArrayBuffer.isView(value)) found.add(value.buffer);
  else if (value instanceof ArrayBuffer) found.add(value);
  else for (const item of Array.isArray(value) ? value : Object.values(value)) transferables(item, found);
  return found;
}

self.onmessage = async ({ data }) => {
  const { task, payload, libs } = data;
  try {
    if (!tasks[task]) throw new Error('Unknown task: ' + task);
    const result = await tasks[task](payload, libs || {});
    self.postMessage({ type: 'done', result }, [...transferables(result)]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || 'Something went wrong while processing the files.' });
  }
};
