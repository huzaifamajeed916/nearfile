/*!
 * Nearfile image worker: re-encodes images with OffscreenCanvas, off the main thread.
 * Used when the browser supports OffscreenCanvas (current Chrome, Edge, Firefox, Safari 16.4+).
 */
'use strict';
importScripts('common.js');

const MAX_PIXELS = 40_000_000;

async function decode(blob, name) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      throw new Error(`“${name}” couldn’t be read. The file may be damaged.`);
    }
  }
}

async function encode(canvas, type, quality) {
  const blob = await canvas.convertToBlob({ type, quality });
  // Browsers that can't write a format quietly return PNG instead; fall back to JPG.
  if (blob.type !== type && type !== 'image/png') {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return blob;
}

/**
 * payload.images:  [{ id, name, type, bytes }]
 * payload.options: { quality: 0..1, format: 'original' | 'jpeg' | 'webp', maxSide: 0 | px }
 */
tasks.compress = async ({ images, options }) => {
  const results = [];
  const total = images.length;
  for (let i = 0; i < total; i += 1) {
    const img = images[i];
    progress(i / total, `Compressing image ${i + 1} of ${total}`);
    const bitmap = await decode(new Blob([img.bytes], { type: img.type }), img.name);
    img.bytes = null;

    const fit = options.maxSide ? options.maxSide / Math.max(bitmap.width, bitmap.height) : 1;
    const scale = Math.min(1, fit, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const type = options.format === 'webp' ? 'image/webp' : options.format === 'jpeg' ? 'image/jpeg' : img.type;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'; // JPG has no transparency: use white, like paper
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const out = await encode(canvas, type, options.quality);
    results.push({ id: img.id, type: out.type, width, height, resized: scale < 1, bytes: new Uint8Array(await out.arrayBuffer()) });
  }
  progress(1, 'Done');
  return { images: results };
};
