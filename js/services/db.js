import {
  ref, get, set, update, push, remove, onValue, off
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';
import { db } from './firebase.js';
import { APP_BASE_PATH } from '../config/firebase-config.js';

// Prefija toda path relativa con APP_BASE_PATH (e.g. "obras/X/catalogo" →
// "shared/materiales/obras/X/catalogo"). Para escapes que apunten fuera del
// namespace de la app (p.ej. /legacy/estimaciones/users/X o /shared/catalogos/X),
// pasar el path comenzando con "/" — se interpreta como absoluto.
function _resolve(path) {
  if (typeof path !== 'string') throw new Error('path debe ser string');
  if (path.startsWith('/')) return path.slice(1);
  return APP_BASE_PATH ? `${APP_BASE_PATH}/${path}` : path;
}

export function appPath(relPath) { return _resolve(relPath); }

function _ref(path) {
  const resolved = _resolve(path);
  return resolved ? ref(db, resolved) : ref(db);
}

export function rread(path) {
  return get(_ref(path)).then(s => s.exists() ? s.val() : null);
}
export function rset(path, val) { return set(_ref(path), val); }
export function rupdate(path, patch) { return update(_ref(path), patch); }
export function rpush(path, val) {
  const r = push(_ref(path));
  return set(r, val).then(() => r.key);
}
export function rremove(path) { return remove(_ref(path)); }
export function rwatch(path, cb) {
  const r = _ref(path);
  const handler = onValue(r, s => cb(s.exists() ? s.val() : null));
  return () => off(r, 'value', handler);
}

// === Usuarios y obras (lecturas a /legacy/estimaciones — fuente única) ===

export async function listUsersLegacy() {
  return (await rread('/legacy/estimaciones/users')) || {};
}
export async function getUserProfileLegacy(uid) {
  return await rread(`/legacy/estimaciones/users/${uid}`);
}
export async function listObrasLegacy() {
  return (await rread('/legacy/estimaciones/obras')) || {};
}
export async function getObraMetaLegacy(obraId) {
  return await rread(`/legacy/estimaciones/obras/${obraId}/meta`);
}

// === Obras visibles para el usuario actual ===
// Admin ve todas; almacenista/ingeniero solo las que tiene en obrasAsignadas.
export async function listObrasForUser(user) {
  if (user.role === 'admin') return await listObrasLegacy();
  const map = await rread(`/legacy/estimaciones/users/${user.uid}/obrasAsignadas`) || {};
  const ids = Object.keys(map);
  const out = {};
  await Promise.all(ids.map(async id => {
    const meta = await getObraMetaLegacy(id);
    if (meta) out[id] = { meta };
  }));
  return out;
}

// === Catálogo de conceptos (lectura cross-app) ===
export async function loadCatalogoConceptos(obraId) {
  const shared = await rread(`/shared/catalogos/${obraId}`);
  if (!shared?.conceptos) return null;
  return { meta: shared.meta, conceptos: shared.conceptos };
}

// === Catálogo de materiales (esta app es escritor único) ===
export async function loadCatalogoMateriales(obraId) {
  const meta = await rread(`obras/${obraId}/catalogo/meta`);
  const items = await rread(`obras/${obraId}/catalogo/items`);
  return { meta, items: items || {} };
}

// Escribe el catálogo de materiales preservando dos cosas:
//   1) Los items que NO son OPUS (ad_hoc_materiales, ad_hoc_compras, ad_hoc
//      legacy) — creados manualmente desde alguna de las apps. Si OPUS termina
//      exportando la misma clave/desc/unidad, el materialKey colisiona y el
//      ad_hoc queda absorbido por el de OPUS — comportamiento deseado.
//   2) Para items OPUS que coinciden por materialKey con el re-import:
//      cualquier campo marcado en `manualOverrides` del item existente
//      (familia, subfamilia, marca, proveedor) se mantiene, en lugar de
//      sobrescribirse con el valor del XLS. Esto protege ediciones hechas
//      desde la app antes de que el round-trip a OPUS se complete. Si OPUS
//      ya tiene el mismo valor que el override, el efecto es cero.
const META_OVERRIDABLE_FIELDS = ['familia', 'subfamilia', 'marca', 'proveedor'];

export async function saveCatalogoMateriales(obraId, meta, items) {
  const existing = await rread(`obras/${obraId}/catalogo/items`) || {};
  const merged = { ...items };
  let preservados = 0;
  let overridesRespetados = 0;
  const ORIGEN_NO_OPUS = new Set(['ad_hoc', 'ad_hoc_materiales', 'ad_hoc_compras']);

  for (const [k, v] of Object.entries(existing)) {
    if (v?.origen && ORIGEN_NO_OPUS.has(v.origen) && !merged[k]) {
      merged[k] = v;
      preservados++;
      continue;
    }
    // Re-import: si el material persiste y el existente tenía overrides
    // manuales, los mantenemos sobre el valor traído por el XLS.
    if (merged[k] && v?.manualOverrides) {
      const carry = {};
      let any = false;
      for (const f of META_OVERRIDABLE_FIELDS) {
        if (v.manualOverrides[f]) { carry[f] = v[f] ?? ''; any = true; }
      }
      if (any) {
        merged[k] = { ...merged[k], ...carry, manualOverrides: { ...v.manualOverrides } };
        if (v.editedAt) merged[k].editedAt = v.editedAt;
        if (v.editedBy) merged[k].editedBy = v.editedBy;
        overridesRespetados++;
      }
    }
  }
  const finalMeta = { ...meta };
  if (preservados > 0) finalMeta.adHocPreservados = preservados;
  if (overridesRespetados > 0) finalMeta.metaOverridesRespetados = overridesRespetados;
  await set(_ref(`obras/${obraId}/catalogo`), { meta: finalMeta, items: merged });
  return { preservados, overridesRespetados };
}

// Crea un material ad-hoc en la obra (no proveniente de OPUS). Usado cuando el
// almacenista necesita registrar algo que el catálogo no contempla.
export async function createMaterialAdHoc(obraId, materialKey, data) {
  await rset(`obras/${obraId}/catalogo/items/${materialKey}`, data);
}

// Edita campos de catálogo del material (familia, subfamilia, marca, proveedor)
// desde la UI. Marca cada campo en `manualOverrides` para que el re-import del
// XLS de OPUS NO sobreescriba la edición hasta que OPUS la tenga también
// (después de subirle el XLS exportado desde esta app). Como `compras` lee del
// mismo path `/shared/materiales/{obraId}/catalogo/items/{materialKey}`, ve el
// cambio automáticamente — no hay sync extra.
//
// `patch` es { familia?, subfamilia?, marca?, proveedor? } con strings ('' OK
// para limpiar). Cualquier campo no presente en patch queda intacto.
export async function updateMaterialMeta(obraId, materialKey, patch, editor) {
  const path = `obras/${obraId}/catalogo/items/${materialKey}`;
  const current = await rread(path);
  if (!current) throw new Error('Material no encontrado');
  const overrides = { ...(current.manualOverrides || {}) };
  const update = {};
  let changedCount = 0;
  for (const f of META_OVERRIDABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    const val = (patch[f] || '').toString().trim();
    const prev = (current[f] || '').toString().trim();
    update[f] = val;
    if (val !== prev) {
      overrides[f] = true;   // flag persiste aunque después se borre el valor:
                             // el "ya lo edité" es la señal, no el valor actual.
      changedCount++;
    }
  }
  if (changedCount === 0) return { changed: 0 };
  update.manualOverrides = overrides;
  update.editedAt = Date.now();
  if (editor) update.editedBy = editor;
  await rupdate(path, update);
  return { changed: changedCount };
}

// Actualiza meta (familia/subfamilia/marca/proveedor) en bulk para múltiples
// materiales en una sola escritura multi-path a RTDB. Cada campo presente en
// el patch se flagea en `manualOverrides`, mismo criterio que updateMaterialMeta.
//
// updatesByKey: { [materialKey]: { familia?, subfamilia?, marca?, proveedor? } }
// editor: { uid, displayName } opcional.
//
// Devuelve { affected: number } con la cuenta de materiales tocados.
export async function bulkUpdateMaterialMeta(obraId, updatesByKey, editor) {
  const keys = Object.keys(updatesByKey || {});
  if (keys.length === 0) return { affected: 0 };
  const patches = {};
  const now = Date.now();
  for (const matKey of keys) {
    const fieldPatch = updatesByKey[matKey] || {};
    let touchedAny = false;
    for (const f of META_OVERRIDABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(fieldPatch, f)) continue;
      const val = (fieldPatch[f] || '').toString().trim();
      patches[`items/${matKey}/${f}`] = val;
      patches[`items/${matKey}/manualOverrides/${f}`] = true;
      touchedAny = true;
    }
    if (touchedAny) {
      patches[`items/${matKey}/editedAt`] = now;
      if (editor) patches[`items/${matKey}/editedBy`] = editor;
    }
  }
  if (Object.keys(patches).length === 0) return { affected: 0 };
  await update(_ref(`obras/${obraId}/catalogo`), patches);
  return { affected: keys.length };
}

// === Salidas ===
//
// Modelo (nuevo, multi-allocation):
//   { numero, fecha, items: { [itemId]: { materialKey, cantidad, conceptoKey, notas? } },
//     notas, autorizadoPor, createdAt, updatedAt }
//
// Cada item asigna una cantidad de un material a un concepto específico. El
// almacenista elige UN material y luego puede partirlo en varias asignaciones
// — cada asignación se guarda como un item independiente con el mismo
// materialKey y diferente conceptoKey. El sentinel `__indirecto__` marca
// consumo que no se carga a un concepto OPUS (gasto indirecto / generales).
//
// Backward compat: salidas viejas tenían conceptoKey a NIVEL salida e items
// sin conceptoKey. `normalizeSalida` propaga el global a los items al leer.

export const CONCEPTO_INDIRECTO = '__indirecto__';

export function normalizeSalida(sal) {
  if (!sal) return sal;
  // Default estado='borrador' para salidas viejas (anti-tamper se introdujo después).
  const out = sal.estado ? sal : { ...sal, estado: 'borrador' };
  const fallbackCK = out.conceptoKey || null;
  if (!fallbackCK) return out;
  const items = {};
  for (const [id, it] of Object.entries(out.items || {})) {
    items[id] = it.conceptoKey ? it : { ...it, conceptoKey: fallbackCK };
  }
  return { ...out, items };
}

export async function listSalidas(obraId) {
  const raw = (await rread(`obras/${obraId}/salidas`)) || {};
  const out = {};
  for (const [id, sal] of Object.entries(raw)) out[id] = normalizeSalida(sal);
  return out;
}
export async function getSalida(obraId, salId) {
  return normalizeSalida(await rread(`obras/${obraId}/salidas/${salId}`));
}
export async function createSalida(obraId, autorizadoPor) {
  const all = await rread(`obras/${obraId}/salidas`) || {};
  const numero = Math.max(0, ...Object.values(all).map(s => s.numero || 0)) + 1;
  return rpush(`obras/${obraId}/salidas`, {
    numero,
    fecha: Date.now(),
    items: {},
    notas: null,
    autorizadoPor,
    estado: 'borrador',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}
// Cambio de estado con auditoría mínima. Una salida cerrada bloquea
// edición/borrado de items por la UI; reapertura típicamente requiere admin.
export async function setSalidaEstado(obraId, salId, estado, extra = {}) {
  const patch = { estado, updatedAt: Date.now(), ...extra };
  if (estado === 'cerrada') patch.cerradaAt = Date.now();
  if (estado === 'borrador') { patch.cerradaAt = null; patch.cerradaPor = null; }
  return rupdate(`obras/${obraId}/salidas/${salId}`, patch);
}
export async function updateSalida(obraId, salId, patch) {
  return rupdate(`obras/${obraId}/salidas/${salId}`, { ...patch, updatedAt: Date.now() });
}
export async function addSalidaItem(obraId, salId, item) {
  const id = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await rset(`obras/${obraId}/salidas/${salId}/items/${id}`, item);
  await rupdate(`obras/${obraId}/salidas/${salId}`, { updatedAt: Date.now() });
  return id;
}
// Bulk: agrega varias asignaciones (cada una = item independiente). Útil para
// el modal de consumo multi-allocation.
export async function addSalidaItemsBatch(obraId, salId, items) {
  const ids = [];
  for (const it of items) {
    const id = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await rset(`obras/${obraId}/salidas/${salId}/items/${id}`, it);
    ids.push(id);
  }
  await rupdate(`obras/${obraId}/salidas/${salId}`, { updatedAt: Date.now() });
  return ids;
}
export async function updateSalidaItem(obraId, salId, itemId, patch) {
  await rupdate(`obras/${obraId}/salidas/${salId}/items/${itemId}`, patch);
  await rupdate(`obras/${obraId}/salidas/${salId}`, { updatedAt: Date.now() });
}
export async function removeSalidaItem(obraId, salId, itemId) {
  await rremove(`obras/${obraId}/salidas/${salId}/items/${itemId}`);
  await rupdate(`obras/${obraId}/salidas/${salId}`, { updatedAt: Date.now() });
}
export async function deleteSalida(obraId, salId) {
  return rremove(`obras/${obraId}/salidas/${salId}`);
}

// === Recepciones ===
//
// Modelo:
//   { numero, fecha, origenTipo: 'oc' | 'caja_chica',
//     origenRef: { reqId? | ticketDescripcion? },
//     proveedor, factura?,
//     items: { [itemId]: { materialKey, cantidad, costoUnitario, conceptoKey? } },
//     totalRecepcion, notas, recibidoPor,
//     estado: 'borrador' | 'enviada_buzon' | 'cancelada',
//     buzonId?, enviadaBuzonAt?,
//     createdAt, updatedAt }

export async function listRecepciones(obraId) {
  return (await rread(`obras/${obraId}/recepciones`)) || {};
}
export async function getRecepcion(obraId, recId) {
  return await rread(`obras/${obraId}/recepciones/${recId}`);
}
export async function createRecepcion(obraId, recibidoPor, data = {}) {
  const all = await rread(`obras/${obraId}/recepciones`) || {};
  const numero = Math.max(0, ...Object.values(all).map(r => r.numero || 0)) + 1;
  return rpush(`obras/${obraId}/recepciones`, {
    numero,
    fecha: Date.now(),
    origenTipo: data.origenTipo || 'oc',
    origenRef: data.origenRef || null,
    proveedor: data.proveedor || '',
    factura: data.factura || '',
    items: {},
    totalRecepcion: 0,
    notas: null,
    recibidoPor,
    estado: 'borrador',
    buzonId: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
}
export async function updateRecepcion(obraId, recId, patch) {
  return rupdate(`obras/${obraId}/recepciones/${recId}`, { ...patch, updatedAt: Date.now() });
}
export async function addRecepcionItem(obraId, recId, item) {
  const id = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await rset(`obras/${obraId}/recepciones/${recId}/items/${id}`, item);
  await recalcTotalRecepcion(obraId, recId);
  return id;
}
export async function updateRecepcionItem(obraId, recId, itemId, patch) {
  await rupdate(`obras/${obraId}/recepciones/${recId}/items/${itemId}`, patch);
  await recalcTotalRecepcion(obraId, recId);
}
export async function removeRecepcionItem(obraId, recId, itemId) {
  await rremove(`obras/${obraId}/recepciones/${recId}/items/${itemId}`);
  await recalcTotalRecepcion(obraId, recId);
}
async function recalcTotalRecepcion(obraId, recId) {
  const items = await rread(`obras/${obraId}/recepciones/${recId}/items`) || {};
  let total = 0;
  for (const it of Object.values(items)) {
    total += (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
  }
  await rupdate(`obras/${obraId}/recepciones/${recId}`, { totalRecepcion: total, updatedAt: Date.now() });
}
export async function deleteRecepcion(obraId, recId) {
  return rremove(`obras/${obraId}/recepciones/${recId}`);
}
export async function setRecepcionEstado(obraId, recId, estado, extra = {}) {
  return rupdate(`obras/${obraId}/recepciones/${recId}`, { estado, ...extra, updatedAt: Date.now() });
}

// === Requisiciones ===
//
// Modelo (ver CLAUDE.md):
//   { numero, fechaSolicitud, solicitadoPor: { uid, displayName, email },
//     items: { [itemId]: { materialKey, cantidad, conceptoKey?, notas } },
//     estado: 'borrador' | 'enviada' | 'cancelada',
//     enviadaAt?, canceladaAt?, ocBuzonId? }
//
// numero es autoincremental por obra (max + 1) calculado al crear.

export async function listRequisiciones(obraId) {
  return (await rread(`obras/${obraId}/requisiciones`)) || {};
}
export async function getRequisicion(obraId, reqId) {
  return await rread(`obras/${obraId}/requisiciones/${reqId}`);
}

export async function createRequisicion(obraId, solicitadoPor) {
  const all = await rread(`obras/${obraId}/requisiciones`) || {};
  const numero = Math.max(0, ...Object.values(all).map(r => r.numero || 0)) + 1;
  const data = {
    numero,
    fechaSolicitud: Date.now(),
    solicitadoPor,
    estado: 'borrador',
    items: {},
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  return rpush(`obras/${obraId}/requisiciones`, data);
}

export async function updateRequisicion(obraId, reqId, patch) {
  return rupdate(`obras/${obraId}/requisiciones/${reqId}`, { ...patch, updatedAt: Date.now() });
}

export async function addRequisicionItem(obraId, reqId, item) {
  const id = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await rset(`obras/${obraId}/requisiciones/${reqId}/items/${id}`, item);
  await rupdate(`obras/${obraId}/requisiciones/${reqId}`, { updatedAt: Date.now() });
  return id;
}
// Bulk: agrega varias asignaciones en una sola requisición (multi-allocation).
export async function addRequisicionItemsBatch(obraId, reqId, items) {
  const ids = [];
  for (const it of items) {
    const id = `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await rset(`obras/${obraId}/requisiciones/${reqId}/items/${id}`, it);
    ids.push(id);
  }
  await rupdate(`obras/${obraId}/requisiciones/${reqId}`, { updatedAt: Date.now() });
  return ids;
}
export async function updateRequisicionItem(obraId, reqId, itemId, patch) {
  await rupdate(`obras/${obraId}/requisiciones/${reqId}/items/${itemId}`, patch);
  await rupdate(`obras/${obraId}/requisiciones/${reqId}`, { updatedAt: Date.now() });
}
export async function removeRequisicionItem(obraId, reqId, itemId) {
  await rremove(`obras/${obraId}/requisiciones/${reqId}/items/${itemId}`);
  await rupdate(`obras/${obraId}/requisiciones/${reqId}`, { updatedAt: Date.now() });
}

export async function setRequisicionEstado(obraId, reqId, estado) {
  const patch = { estado, updatedAt: Date.now() };
  if (estado === 'enviada') patch.enviadaAt = Date.now();
  if (estado === 'cancelada') patch.canceladaAt = Date.now();
  if (estado === 'borrador') { patch.enviadaAt = null; patch.canceladaAt = null; }
  return rupdate(`obras/${obraId}/requisiciones/${reqId}`, patch);
}

export async function deleteRequisicion(obraId, reqId) {
  return rremove(`obras/${obraId}/requisiciones/${reqId}`);
}

// Envía la requisición al buzón cross-app con tipo='requisicion_materiales'
// para que app-compras la procese (cotice + emita OC). Hace 3 cosas atómicas
// desde el punto de vista de la UI:
//   1. Snapshot de la requisición en el item del buzón (compras no necesita
//      leer la requisición original; el buzón es self-contained).
//   2. Estado='recibido' en el buzón (entrada de la máquina de estados que
//      ya usa la suite).
//   3. En la requisición: estado='enviada' + buzonId (referencia inversa
//      para mostrar el estado de compras en la UI del almacenista).
//
// Si ya existe un buzonId activo (no rechazado/huerfano), no vuelve a publicar.
export async function enviarRequisicionABuzon(obraId, reqId, autor) {
  const req = await rread(`obras/${obraId}/requisiciones/${reqId}`);
  if (!req) throw new Error('Requisición no encontrada');
  if (req.buzonId) {
    const existente = await rread(`/shared/buzon/${req.buzonId}`);
    if (existente && !['rechazado', 'huerfano'].includes(existente.estado)) {
      throw new Error('Esta requisición ya está en el buzón de compras');
    }
  }
  const itemsCount = req.items ? Object.keys(req.items).length : 0;
  if (itemsCount === 0) throw new Error('La requisición no tiene items');

  const buzonItem = {
    tipo: 'requisicion_materiales',
    origenApp: 'materiales',
    obraId,
    reqId,
    numero: req.numero,
    fechaSolicitud: req.fechaSolicitud,
    items: req.items || {},
    autor: autor || req.solicitadoPor || null,
    estado: 'recibido',
    creadoAt: Date.now()
  };
  const buzonId = await rpush('/shared/buzon', buzonItem);
  await rupdate(`obras/${obraId}/requisiciones/${reqId}`, {
    estado: 'enviada',
    enviadaAt: Date.now(),
    buzonId,
    updatedAt: Date.now()
  });
  return buzonId;
}

// === Caja chica por obra ===
//
// Vive en /shared/cajaChica/{obraId} para que appsogrub (contador) la lea/
// escriba también. Movimientos:
//   tipo: 'deposito' (entra dinero, +saldo)
//        | 'gasto'  (sale dinero, −saldo cuando estado=aprobado)
//   estado (solo gastos): 'reportado' | 'aprobado' | 'rechazado'
//
// Saldo = sum(depositos) − sum(gastos aprobados).
// Reportados pendientes no afectan el saldo (se muestran como reservación).

export async function listMovimientosCajaChica(obraId) {
  return (await rread(`/shared/cajaChica/${obraId}/movimientos`)) || {};
}
export async function getCajaChicaMeta(obraId) {
  return await rread(`/shared/cajaChica/${obraId}/meta`);
}
export async function setCajaChicaMeta(obraId, patch) {
  await rupdate(`/shared/cajaChica/${obraId}/meta`, { ...patch, updatedAt: Date.now() });
}
export async function addMovimientoCajaChica(obraId, mov) {
  return rpush(`/shared/cajaChica/${obraId}/movimientos`, { ...mov, createdAt: Date.now() });
}
export async function updateMovimientoCajaChica(obraId, movId, patch) {
  return rupdate(`/shared/cajaChica/${obraId}/movimientos/${movId}`, { ...patch, updatedAt: Date.now() });
}
export async function deleteMovimientoCajaChica(obraId, movId) {
  return rremove(`/shared/cajaChica/${obraId}/movimientos/${movId}`);
}
// Busca el movimiento de tipo gasto vinculado a una recepción (refRecepcionId).
export async function findMovimientoCajaChicaByRecepcion(obraId, recepcionId) {
  const all = await listMovimientosCajaChica(obraId);
  for (const [id, m] of Object.entries(all)) {
    if (m.refRecepcionId === recepcionId) return { id, mov: m };
  }
  return null;
}
// Cálculo del saldo + sumas auxiliares. Puro, testeable.
//
// Reglas:
//   - Saldo conciliado SOLO incluye depósitos `metodoDeposito='transferencia'`
//     con `estado='aprobado'`. Solicitados (pendientes) y rechazados no
//     afectan el saldo. Efectivo nunca afecta saldo (es informativo).
//   - Backward compat: depósitos sin `estado` se asumen aprobados (legacy).
//   - Gastos: solo aprobados restan al saldo.
export function computeSaldoCajaChica(movimientos) {
  let saldo = 0;
  // Depósitos por estado/método
  let totalTransferAprobado = 0, totalTransferSolicitado = 0, totalTransferRechazado = 0;
  let totalEfectivoAprobado = 0, totalEfectivoSolicitado = 0, totalEfectivoRechazado = 0;
  let countTransferAprobado = 0, countTransferSolicitado = 0, countTransferRechazado = 0;
  let countEfectivoAprobado = 0, countEfectivoSolicitado = 0, countEfectivoRechazado = 0;
  // Gastos por estado
  let totalGastadoAprobado = 0, totalGastoReportado = 0, totalGastoRechazado = 0;
  let countGastoAprobado = 0, countGastoReportado = 0, countGastoRechazado = 0;

  for (const m of Object.values(movimientos || {})) {
    const monto = Number(m.monto) || 0;
    if (m.tipo === 'deposito') {
      const metodo = m.metodoDeposito || 'transferencia';
      const estado = m.estado || 'aprobado';   // legacy default
      if (metodo === 'transferencia') {
        if (estado === 'aprobado')   { saldo += monto; totalTransferAprobado   += monto; countTransferAprobado++; }
        else if (estado === 'solicitado') { totalTransferSolicitado += monto; countTransferSolicitado++; }
        else if (estado === 'rechazado')  { totalTransferRechazado  += monto; countTransferRechazado++; }
      } else { // efectivo (nunca suma al saldo)
        if (estado === 'aprobado')   { totalEfectivoAprobado   += monto; countEfectivoAprobado++; }
        else if (estado === 'solicitado') { totalEfectivoSolicitado += monto; countEfectivoSolicitado++; }
        else if (estado === 'rechazado')  { totalEfectivoRechazado  += monto; countEfectivoRechazado++; }
      }
    } else if (m.tipo === 'gasto') {
      if (m.estado === 'aprobado')   { saldo -= monto; totalGastadoAprobado += monto; countGastoAprobado++; }
      else if (m.estado === 'reportado') { totalGastoReportado += monto; countGastoReportado++; }
      else if (m.estado === 'rechazado') { totalGastoRechazado += monto; countGastoRechazado++; }
    }
  }

  // Sumarios derivados
  const totalSolicitadoPendiente = totalTransferSolicitado + totalEfectivoSolicitado + totalGastoReportado;
  const countSolicitadoPendiente = countTransferSolicitado + countEfectivoSolicitado + countGastoReportado;

  return {
    saldo,
    // Detalle depósitos
    totalTransferAprobado, totalTransferSolicitado, totalTransferRechazado,
    totalEfectivoAprobado, totalEfectivoSolicitado, totalEfectivoRechazado,
    countTransferAprobado, countTransferSolicitado, countTransferRechazado,
    countEfectivoAprobado, countEfectivoSolicitado, countEfectivoRechazado,
    // Detalle gastos
    totalGastadoAprobado, totalGastoReportado, totalGastoRechazado,
    countGastoAprobado, countGastoReportado, countGastoRechazado,
    // Agregados generales
    totalSolicitadoPendiente, countSolicitadoPendiente,
    // Aliases legacy (compat con la UI vieja durante migración)
    totalDepositadoTransfer: totalTransferAprobado,
    totalDepositadoEfectivo: totalEfectivoAprobado,
    totalDepositado: totalTransferAprobado + totalEfectivoAprobado,
    totalReportadoPendiente: totalGastoReportado,
    totalRechazado: totalGastoRechazado,
    countDepositosTransfer: countTransferAprobado,
    countDepositosEfectivo: countEfectivoAprobado,
    countDepositos: countTransferAprobado + countEfectivoAprobado,
    countAprobados: countGastoAprobado,
    countReportados: countGastoReportado,
    countRechazados: countGastoRechazado
  };
}

// === Buzón cross-app ===
//
// `/shared/buzon` es el bus de aprobación entre apps. Esta app publica:
//   - tipo='gasto_caja_chica'      cuando se reporta un gasto de caja chica.
//   - tipo='deposito_caja_chica'   cuando el contador deposita por transferencia.
// Bitácora (appsogrub) consume desde su lado y al aprobar genera los
// movimientos contables correspondientes. Al cambiar el estado en este lado,
// también sincronizamos el item del buzón.

export async function pushBuzonItem(item) {
  return rpush('/shared/buzon', { ...item, creadoAt: Date.now() });
}
export async function updateBuzonItem(itemId, patch) {
  return rupdate(`/shared/buzon/${itemId}`, { ...patch, actualizadoAt: Date.now() });
}
export async function deleteBuzonItem(itemId) {
  return rremove(`/shared/buzon/${itemId}`);
}
export async function getBuzonItem(itemId) {
  return await rread(`/shared/buzon/${itemId}`);
}
