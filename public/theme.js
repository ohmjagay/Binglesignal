// Applies the saved light or dark choice BEFORE the page is drawn, so there is never a flash of the wrong colours. Dark is the default look.
(function () {
  try {
    var saved = localStorage.getItem('bs_theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
    var bar = document.querySelector('meta[name="theme-color"]');
    if (bar && saved === 'light') bar.setAttribute('content', '#F3F6FB');
  } catch (e) { /* private mode: the default (dark) is used */ }
})();
