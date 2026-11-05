(() => {
  'use strict';
  const colors = { primaryColor: '--ink', accentColor: '--acid', backgroundColor: '--paper' };
  function apply(settings) {
    const link = document.getElementById('site-theme');
    function update() {
      const rule = link?.sheet?.cssRules?.[0];
      if (!rule?.style) return;
      for (const [key, variable] of Object.entries(colors)) {
        if (/^#[0-9a-f]{6}$/i.test(settings[key] || '')) rule.style.setProperty(variable, settings[key]);
      }
    }
    try { update(); } catch { /* The stylesheet load event retries while it initializes. */ }
    if (!link?.sheet) link?.addEventListener('load', update, { once: true });
  }
  window.MR1Theme = Object.freeze({ apply });
})();
