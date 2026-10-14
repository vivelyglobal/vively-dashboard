/* The view modules are written for a browser and a few of them touch
   `window` or `document` as they load. Node has neither, so a test that
   imports a view imports this first — it is the smallest stand-in that
   lets the module finish loading, not a DOM. */
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return { style: {}, classList: { add() {}, remove() {} }, appendChild() {} }; },
    body: { classList: { add() {}, remove() {} }, appendChild() {} }
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
}
if (typeof globalThis.location === 'undefined') {
  globalThis.location = { origin: 'https://dash.test', href: 'https://dash.test/', pathname: '/', search: '', hash: '' };
}
