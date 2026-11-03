// Minimal hash router. Routes: #/ , #/tools, #/favorites, #/recent, #/category/:id,
// #/settings, #/about, #/tool/:id. Hash routing means browser refresh works on any static server.
export function parseHash(hash = location.hash) {
  const path = hash.replace(/^#\/?/, '').split('?')[0];
  const [name = '', param = ''] = path.split('/').map(decodeURIComponent);
  return { name: name || 'dashboard', param };
}

export const hrefTo = (name, param) => `#/${name}${param ? '/' + encodeURIComponent(param) : ''}`;

export function createRouter(onRoute) {
  const run = () => onRoute(parseHash());
  window.addEventListener('hashchange', run);
  return { start: run, go: (name, param) => { location.hash = hrefTo(name, param); } };
}
