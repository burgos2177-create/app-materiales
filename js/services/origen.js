// Origen de un material en el catálogo:
//   'opus'              → vino del XLS de OPUS
//   'ad_hoc_materiales' → creado por el almacenista desde la app de materiales
//                         (cuando en obra se requiere algo no contemplado)
//   'ad_hoc_compras'    → creado por el comprador desde la app de compras
//                         (cuando no se encontró el material solicitado y se
//                          sustituye/agrega al cotizar/emitir OC)
//   'ad_hoc'            → LEGACY (antes del 2026-05-06 todo lo no-OPUS era 'ad_hoc',
//                         lo trataba materiales). Backward compat: se interpreta
//                         como 'ad_hoc_materiales'.

export const ORIGEN_OPUS              = 'opus';
export const ORIGEN_AD_HOC_MATERIALES = 'ad_hoc_materiales';
export const ORIGEN_AD_HOC_COMPRAS    = 'ad_hoc_compras';

export function isAdHoc(origen) {
  return origen === 'ad_hoc' ||
         origen === ORIGEN_AD_HOC_MATERIALES ||
         origen === ORIGEN_AD_HOC_COMPRAS;
}

export function isAdHocMateriales(origen) {
  return origen === 'ad_hoc' || origen === ORIGEN_AD_HOC_MATERIALES;
}

export function isAdHocCompras(origen) {
  return origen === ORIGEN_AD_HOC_COMPRAS;
}

// Etiqueta corta para badges UI.
export function origenLabel(origen) {
  if (origen === ORIGEN_AD_HOC_COMPRAS) return 'ad-hoc compras';
  if (isAdHocMateriales(origen)) return 'ad-hoc almacén';
  return '';
}
