/* PARA-PO theme switcher + jeepney colour helper.
   Load in <head> (before the body paints, so there is no flash of the wrong theme):
   <script src="/theme.js"></script> */
(function () {
  var KEY = 'paraPoTheme';
  var root = document.documentElement;

  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  var current = stored() === 'light' || stored() === 'dark' ? stored() : systemTheme();
  root.setAttribute('data-theme', current);

  var SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  var MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

  function wire() {
    var b = document.getElementById('theme-toggle');
    if (!b) return;
    function paint() {
      b.innerHTML = current === 'dark' ? SUN : MOON;            // icon shows what you will switch TO
      var label = current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      b.setAttribute('aria-label', label); b.title = label;
    }
    paint();
    b.onclick = function () {
      current = current === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', current);
      save(current);
      paint();
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  // follow the phone's setting until the person picks a theme themselves
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onSys = function () { if (!stored()) { current = systemTheme(); root.setAttribute('data-theme', current); wire(); } };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
  }

  // Jeepney colour comes from the server (so every page shows the same colour for the same jeepney).
  // Only values the server generates are accepted, because the colour ends up inside a style attribute.
  var FALLBACK = '#a3e635';
  window.jeepColor = function (j) {
    var c = j && j.color;
    return (typeof c === 'string' && /^(#[0-9a-f]{6}|hsl\(\d{1,3}, ?\d{1,3}%, ?\d{1,3}%\))$/i.test(c)) ? c : FALLBACK;
  };
})();
