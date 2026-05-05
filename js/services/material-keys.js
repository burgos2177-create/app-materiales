// Funciones puras para derivar materialKey estables. Mismo patrón que
// conceptoKey en estimaciones (FNV-1a 32-bit truncado a 6 hex).
//
//   materialKey = `{clave_sanitizada}_{hash6(stableKey)}`
//   stableKey   = `mat::{clave}::{descripcion}::{unidad}`
//
// Determinístico → un re-import del mismo XLS produce las mismas keys.
// Hash incluye descripcion+unidad para desambiguar si dos obras importan
// claves repetidas con marca distinta.

export function computeMaterialStableKey(m) {
  return `mat::${(m.clave || '').trim()}::${(m.descripcion || '').trim()}::${(m.unidad || '').trim()}`;
}

export function computeMaterialKey(m) {
  const stable = computeMaterialStableKey(m);
  const h = hash6(stable);
  return `${sanitizeKeySegment(m.clave || 'sn')}_${h}`;
}

export function hash6(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(-6);
}

// RTDB rechaza `.`, `#`, `$`, `[`, `]`, `/` en keys.
export function sanitizeKeySegment(s) {
  return String(s).replace(/[.#$[\]/]/g, '_');
}
