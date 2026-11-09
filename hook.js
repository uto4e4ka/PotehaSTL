// Runs before the page's scripts. three.js announces every new Scene and
// WebGLRenderer to window.__THREE_DEVTOOLS__ (if it exists) via an "observe"
// event, so defining it early lets us catch scenes that are never exposed.
(() => {
  const store = (window.__potehaSTL = window.__potehaSTL || { refs: [] });
  let dt = window.__THREE_DEVTOOLS__;
  if (!dt) {
    dt = new EventTarget();
    try { window.__THREE_DEVTOOLS__ = dt; } catch (e) { return; }
  }
  dt.addEventListener('observe', (ev) => {
    const obj = ev.detail;
    if (!obj) return;
    if (obj.isScene || obj.isObject3D) store.refs.push(new WeakRef(obj));
  });
})();
