const listeners = new Set();
export const state = {
  user: null,            // { uid, email, role, displayName }
  obras: {},             // dict obraId → { meta }
  obraActual: null,      // obraId activo
  catalogo: null,        // { meta, items } del obraActual (catálogo de materiales)
  conceptos: null,       // { conceptoKey → concepto } del obraActual (de /shared/catalogos)
  loading: false
};

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach(fn => fn(state));
}

export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
