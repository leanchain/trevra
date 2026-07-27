/**
 * Theme boot + toggle.
 *
 * Loaded as a blocking script in <head> on purpose. A deferred script would let
 * the browser paint light stock and repaint dark, which reads as a fault. This
 * resolves the stored choice (falling back to the system preference) and stamps
 * `data-theme` on <html> before first paint.
 *
 * Served from /public as a real file rather than inlined, so it needs no CSP
 * nonce ('self' covers it) and behaves identically under the Vite dev server
 * and the Express production renderer.
 *
 * The switch is bound by delegation on `[data-theme-toggle]`, so the same file
 * serves the static shell, the React marketing screen, and every public
 * sub-page without any of them knowing about each other.
 */
(function () {
  var KEY = 'trevra-theme';
  var root = document.documentElement;

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function currentTheme() {
    return root.getAttribute('data-theme') || systemTheme();
  }

  function labelToggles(theme) {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
    }
  }

  // Restore before paint. Anything other than an explicit choice stays unset so
  // the system preference keeps tracking.
  try {
    var stored = localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
  } catch (error) {
    /* Storage blocked: fall through to the system preference. */
  }

  function setTheme(theme) {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      root.setAttribute('data-theme', theme);
    } else {
      // The class scopes the colour transition to this switch only, so first
      // paint is never animated.
      root.classList.add('theme-turning');
      root.setAttribute('data-theme', theme);
      window.setTimeout(function () {
        root.classList.remove('theme-turning');
      }, 340);
    }
    try {
      localStorage.setItem(KEY, theme);
    } catch (error) {
      /* Storage blocked: the choice lasts for this page only. */
    }
    labelToggles(theme);
  }

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest && event.target.closest('[data-theme-toggle]');
    if (!target) return;
    event.preventDefault();
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });

  document.addEventListener('DOMContentLoaded', function () {
    labelToggles(currentTheme());
  });
})();
