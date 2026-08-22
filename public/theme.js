/**
 * Theme boot + toggle.
 *
 * Loaded as a blocking script in <head> on purpose. A deferred script would let
 * the browser paint light stock and repaint dark, which reads as a fault. This
 * resolves the stored choice (falling back to light) and stamps `data-theme`
 * on <html> before first paint.
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

  function currentTheme() {
    return root.getAttribute('data-theme') || 'light';
  }

  function labelToggles(theme) {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute(
        'aria-label',
        'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme'
      );
    }
  }

  // Restore before paint. Light is Trevra's product default; only an explicit
  // saved dark choice overrides it. Setting the attribute even for the default
  // also prevents the CSS system-theme media query from taking over on first paint.
  var initialTheme = 'light';
  try {
    var stored = localStorage.getItem(KEY);
    if (stored === 'dark' || stored === 'light') initialTheme = stored;
  } catch (error) {
    /* Storage blocked: keep the product default. */
  }
  root.setAttribute('data-theme', initialTheme);

  function setTheme(theme) {
    var reduced =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
    var target =
      event.target && event.target.closest && event.target.closest('[data-theme-toggle]');
    if (!target) return;
    event.preventDefault();
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });

  function syncNavCompactState() {
    var navs = document.querySelectorAll('.launch-nav');
    var shouldExpand = window.scrollY <= 4;
    var shouldCompact = window.scrollY > 32;

    for (var i = 0; i < navs.length; i += 1) {
      if (shouldExpand) navs[i].classList.remove('is-compact');
      else if (shouldCompact) navs[i].classList.add('is-compact');
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    labelToggles(currentTheme());
    syncNavCompactState();
    window.addEventListener('scroll', syncNavCompactState, { passive: true });
  });
})();
