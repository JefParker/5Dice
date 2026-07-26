/* Skins — shared by the lobby app and the Score Sheet app.
 *
 * Loaded as a plain (non-deferred) script in <head> so the skin is applied
 * before first paint and you never see a flash of the Original theme.
 *
 * "Original" is the absence of a skin: no data-skin attribute means no rules in
 * skins.css match, so Original renders exactly as it always has.
 */
(function () {
  var STORAGE_KEY = 'skin';
  var SKINS = ['original', 'glass-dark', 'steampunk'];

  // Browser chrome (status bar / title bar) color per skin.
  var THEME_COLORS = {
    'original': null,          // leave whatever the page already declares
    'glass-dark': '#0d0f12',
    'steampunk': '#241009'
  };

  function readSkin() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return SKINS.indexOf(v) !== -1 ? v : 'original';
    } catch (e) {
      return 'original';
    }
  }

  function applySkin(name) {
    if (SKINS.indexOf(name) === -1) name = 'original';
    var root = document.documentElement;

    if (name === 'original') {
      root.removeAttribute('data-skin');
    } else {
      root.setAttribute('data-skin', name);
    }

    var themeColor = THEME_COLORS[name];
    if (themeColor) {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        if (!meta.dataset.originalContent) {
          meta.dataset.originalContent = meta.getAttribute('content') || '';
        }
        meta.setAttribute('content', themeColor);
      }
    } else {
      var m = document.querySelector('meta[name="theme-color"]');
      if (m && m.dataset.originalContent) {
        m.setAttribute('content', m.dataset.originalContent);
      }
    }
  }

  function setSkin(name) {
    if (SKINS.indexOf(name) === -1) name = 'original';
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) { /* private mode */ }
    applySkin(name);
  }

  // Apply immediately — <html> exists by the time this runs in <head>.
  applySkin(readSkin());

  // Another tab (or the other app) changed the skin: follow along live.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) applySkin(readSkin());
  });

  window.Skins = {
    list: SKINS.slice(),
    get: readSkin,
    set: setSkin,
    apply: applySkin
  };
})();
