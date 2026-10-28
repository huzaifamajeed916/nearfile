# Nearfile

Free file tools that run entirely in the browser. Files are read from the visitor's device, processed in the tab, and handed back as downloads. Nothing is uploaded, so the site is just static files and hosts for free anywhere.

## Folder structure

```
nearfile/
├── index.html                  Homepage with the tool grid
├── privacy/index.html          Privacy page
├── image-to-pdf/index.html     Tool pages: one folder each, for clean URLs
├── pdf-to-image/index.html
├── merge-pdf/index.html
├── split-pdf/index.html
├── compress-pdf/index.html
├── rotate-pdf/index.html
├── add-page-numbers/index.html
├── watermark-pdf/index.html
├── compress-image/index.html
├── resize-image/index.html
├── assets/
│   ├── css/site.css            All styles, light and dark themes
│   ├── img/favicon.svg
│   └── js/
│       ├── theme-init.js       Applies the saved theme before paint
│       ├── site.js             Shared: library loader, drop zone, worker jobs, page ranges, helpers (window.Site)
│       ├── pdf-preview.js      Shared by PDF tools: opens PDFs, page thumbnails and sizes, page grids (window.PdfPreview)
│       ├── tools/              One script per tool page
│       └── workers/
│           ├── common.js       Shared worker core: verified library loading, messages, ZIP
│           ├── pdf-worker.js   Builds, merges, splits, compresses and stamps PDFs (pdf-lib)
│           └── image-worker.js Compresses and resizes images (OffscreenCanvas)
├── robots.txt
└── sitemap.xml
```

## Preview locally

Web workers don't run from `file://`, so serve the folder:

```
cd nearfile
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Deploy

No build step. Upload the folder as it is.

- **GitHub Pages:** push to a repository, then Settings › Pages › Deploy from a branch › `main` / root. Relative links mean it also works at `username.github.io/repo-name/`.
- **Cloudflare Pages:** connect the repository, leave the build command empty, set the output directory to `/`.
- **Netlify:** drag the folder onto the Netlify dashboard, or connect the repository with no build command and publish directory `.`.

## Before you publish

1. **Name:** "Nearfile" is a placeholder brand. To rename, find and replace `Nearfile` across the project (and `nearfile-theme` in `theme-init.js` and `site.js` if you like).
2. **Domain:** replace `https://example.com/` in `sitemap.xml` and `robots.txt`.
3. **Contact:** replace `hello@example.com` in `privacy/index.html`.
4. Read the privacy page and make sure it stays true for your setup (see below).

## How it fits together

- **`site.js`** exposes `window.Site`: `loadLib`, `warm`, `runJob`, `dropzone`, `sniff` (detects file types from their bytes, not names), `parsePages` (page ranges like `1-3, 5, 8-`), `notify`, `progressBar`, download helpers and small formatting helpers.
- **`pdf-preview.js`** wraps PDF.js for the PDF tools: opening files with clear errors, lazily drawn page thumbnails, and a page grid that stays in step with a typed page range.
- **Libraries** are pinned to exact versions on jsDelivr, with Subresource Integrity hashes in `site.js`. The page fetches worker libraries once, the browser verifies them, and the verified code is handed to each worker. That's why tools keep working offline once loaded.
- **Workers** (`assets/js/workers/`) do the heavy work so big files don't freeze the page: pdf-lib for building and editing PDFs, OffscreenCanvas for compressing images, JSZip for ZIPs. PDF.js parses PDFs in its own worker. Each job runs in a fresh worker, which also makes Cancel instant.
- **Compress image** and **Resize image** use the browser's Canvas API instead of a compression library. They run in a worker where the browser supports OffscreenCanvas, and on the page otherwise.
- **Compress PDF** has two methods. *Keep text* edits the PDF in a worker: it removes unreachable objects and page thumbnails, packs uncompressed streams, and re-encodes large JPEG and uncompressed pictures as smaller JPEGs (undoing PNG/TIFF predictors itself, because pdf-lib doesn't). A picture is only replaced if the new one is at least 10% smaller, and pictures used as masks, CMYK/indexed/16-bit images and anything with a `/Decode` or `/Mask` entry are left alone. *Flatten pages* draws each page with PDF.js and rebuilds the PDF from JPEGs. If neither is smaller than the original, the tool says so instead of offering a bigger file.
- **Add page numbers** and **Watermark PDF** stamp text with pdf-lib's built-in Helvetica. Placement is worked out as the page looks on screen, so `/Rotate`d pages and page boxes that don't start at 0,0 come out right (`pageView` and `viewToPage` in `pdf-worker.js`). Their live previews use CSS container units and must be kept in step with the worker if you change margins or sizing (see the comments in the tool scripts).
- **Header navigation** is a "Tools" menu at every screen width, because ten links don't fit in one row. It is plain HTML, repeated in each page.
- **Header and footer** are plain HTML repeated in each page. When adding a page, copy them from an existing page and set `aria-current="page"` on its nav link. Add the new tool to the nav and footer of *every* page, the homepage grid, `sitemap.xml`, and a tool colour in `site.css` (`.t-your-tool`).

## Security and privacy settings

Every page carries a Content Security Policy in a `<meta>` tag that only allows code, fonts and network requests from the site itself and `cdn.jsdelivr.net` (PDF.js fetches standard fonts and character maps from there for some PDFs). If you add analytics, ads, fonts or another CDN, you'll need to update that policy on every page, and update the privacy page so it stays accurate.

To update a library, change its version in `site.js` and recompute its hash:

```
npm pack pdf-lib@1.17.1
tar xzf pdf-lib-1.17.1.tgz
echo "sha384-$(openssl dgst -sha384 -binary package/dist/pdf-lib.min.js | openssl base64 -A)"
```

## Libraries and licences

| Library | Version | Licence |
| --- | --- | --- |
| pdf-lib | 1.17.1 | MIT |
| PDF.js (pdfjs-dist) | 3.11.174 | Apache-2.0 |
| JSZip | 3.10.1 | MIT or GPLv3 |
| SortableJS | 1.15.6 | MIT |

## Build status

- [x] Shared CSS, JS and worker setup
- [x] Homepage
- [x] Privacy page
- [x] Image to PDF
- [x] PDF to image
- [x] Merge PDF
- [x] Split PDF
- [x] Compress image
- [x] Rotate and delete pages
- [x] Compress PDF
- [x] Add page numbers
- [x] Watermark PDF
- [x] Resize image

## Known limits

- PDFs locked with a password or editing permissions are refused with a clear message. PDF to image can open permission-locked files, but not ones that need a password to open.
- Merging copies pages, not bookmarks or fillable form fields.
- Safari can't save WebP images; Compress image and Resize image tell the user and save JPG instead.
- Compress PDF re-compresses only pictures stored as plain JPEG (DCT) or Flate. Pictures with other or stacked encodings (for example ASCII85 wrapped, JPEG 2000, JBIG2, CCITT) are left as they are, so some old or unusual PDFs shrink less. Pictures are capped by pixel size, not by the DPI they're printed at.
- Flatten pages turns text into pictures: no selecting, searching, links or form fields afterwards. Digital signatures never survive either method.
- Watermark PDF and Add page numbers support Latin letters, numbers and common symbols only (the PDF standard fonts). Text is added on top of the page content, so a watermark can be removed with PDF-editing software.
- Compress PDF needs `CompressionStream` and, to re-compress pictures, `OffscreenCanvas` in workers (current Chrome, Edge, Firefox and Safari 16.4+). Without them it still tidies the file, and Flatten pages works.
