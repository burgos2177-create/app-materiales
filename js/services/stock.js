// Stock por material: cuánto entró (recepciones) menos cuánto salió (salidas).
// Recepciones canceladas no cuentan; las salidas no tienen cancelación.
//
// `excludeSalidaId` y `excludeRecepcionId` son útiles cuando estás editando
// items de un documento existente: si la salida actual ya tiene items con
// cantidad N, la lógica del modal valida deltas, así que conviene excluir el
// documento entero del cálculo de stock para no contar dos veces.

export function computeStockByMaterial(recepciones, salidas, opts = {}) {
  const { excludeRecepcionId = null, excludeSalidaId = null } = opts;
  const map = new Map();
  const ensure = (k) => {
    if (!map.has(k)) map.set(k, { recibido: 0, consumido: 0, disponible: 0 });
    return map.get(k);
  };

  for (const [recId, rec] of Object.entries(recepciones || {})) {
    if (rec?.estado === 'cancelada') continue;
    if (excludeRecepcionId && recId === excludeRecepcionId) continue;
    for (const it of Object.values(rec?.items || {})) {
      if (!it.materialKey) continue;
      ensure(it.materialKey).recibido += Number(it.cantidad) || 0;
    }
  }
  for (const [salId, sal] of Object.entries(salidas || {})) {
    if (excludeSalidaId && salId === excludeSalidaId) continue;
    for (const it of Object.values(sal?.items || {})) {
      if (!it.materialKey) continue;
      ensure(it.materialKey).consumido += Number(it.cantidad) || 0;
    }
  }
  for (const e of map.values()) {
    e.disponible = e.recibido - e.consumido;
  }
  return map;
}

// Devuelve true si el material tiene stock disponible mayor que cero.
export function hasStock(stockMap, materialKey) {
  const e = stockMap?.get?.(materialKey);
  return !!e && e.disponible > 0;
}
