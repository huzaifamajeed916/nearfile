/* Applies the saved light/dark choice before the page paints, so there's no flash. */
try {
  var saved = localStorage.getItem('nearfile-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch (e) { /* Storage blocked: follow the system setting. */ }
