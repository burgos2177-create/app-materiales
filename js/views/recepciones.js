// Recepciones — entrada de material al almacén. Dos flujos:
//   A — OC (con orden de compra): vinculado a una requisición enviada.
//   B — Caja chica: compra en sitio, el almacenista carga foto del ticket
//       y el concepto destino directo.
// Ambos van al buzón (futuro) para que bitácora los apruebe como gasto.
//
// Por ahora la vista soporta CRUD completo del documento + sus items, con
// botón "Enviar al buzón" deshabilitado/stub — se implementará al cerrar
// el contrato del payload con bitácora.

import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy,
  loadCatalogoMateriales, loadCatalogoConceptos,
  listRecepciones, getRecepcion, createRecepcion, updateRecepcion, deleteRecepcion,
  addRecepcionItem, updateRecepcionItem, removeRecepcionItem, setRecepcionEstado,
  listRequisiciones, getRequisicion,
  findMovimientoCajaChicaByRecepcion, addMovimientoCajaChica,
  updateMovimientoCajaChica, deleteMovimientoCajaChica,
  pushBuzonItem, updateBuzonItem, deleteBuzonItem
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { num, num0, money, dateMx } from '../util/format.js';
import { materialItemDialog } from './_dialogs.js';

// =================== Lista ===================

export async function renderRecepcionesList({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, recepciones] = await Promise.all([
    getObraMetaLegacy(obraId),
    listRecepciones(obraId)
  ]);

  const ids = Object.keys(recepciones);
  ids.sort((a, b) => (recepciones[b].numero || 0) - (recepciones[a].numero || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Recepciones'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => onCreate(obraId) }, '+ Nueva recepción')
  ]);

  let body;
  if (ids.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📥'),
      h('div', {}, 'Sin recepciones todavía.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
        'Crea una para registrar entrada de material (con OC o caja chica).')
    ]);
  } else {
    body = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, '#'),
          h('th', {}, 'Fecha'),
          h('th', {}, 'Origen'),
          h('th', {}, 'Proveedor'),
          h('th', { class: 'num' }, 'Items'),
          h('th', { class: 'num' }, 'Total'),
          h('th', {}, 'Estado'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, ids.map(id => recepcionRow(obraId, id, recepciones[id])))
      ])
    ]);
  }

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, body]));
}

function recepcionRow(obraId, recId, r) {
  const itemsCount = r.items ? Object.keys(r.items).length : 0;
  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/recepciones/${recId}`)
  }, [
    h('td', { class: 'mono' }, `E-${String(r.numero || 0).padStart(4, '0')}`),
    h('td', {}, dateMx(r.fecha) || '—'),
    h('td', {}, origenBadge(r.origenTipo)),
    h('td', { class: 'muted' }, r.proveedor || '—'),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', { class: 'num' }, money(r.totalRecepcion || 0)),
    h('td', {}, estadoBadge(r.estado)),
    h('td', {}, r.estado === 'borrador' && h('button', {
      class: 'btn sm danger',
      onClick: (e) => { e.stopPropagation(); confirmDelete(obraId, recId, r); }
    }, 'Borrar'))
  ]);
}

function origenBadge(tipo) {
  if (tipo === 'oc') return h('span', { class: 'tag', style: { background: 'rgba(76,194,255,.15)', color: '#4cc2ff' } }, '📋 OC');
  if (tipo === 'caja_chica') return h('span', { class: 'tag', style: { background: 'rgba(245,196,81,.15)', color: '#f5c451' } }, '💵 Caja chica');
  return h('span', { class: 'tag muted' }, tipo || '—');
}

function estadoBadge(estado) {
  if (estado === 'borrador') return h('span', { class: 'tag warn' }, '✎ Borrador');
  if (estado === 'enviada_buzon') return h('span', { class: 'tag ok' }, '↗ Enviada a contador');
  if (estado === 'cancelada') return h('span', { class: 'tag muted' }, '✕ Cancelada');
  return h('span', { class: 'tag muted' }, estado || '—');
}

async function onCreate(obraId) {
  // Modal pequeño con tipo origen — luego abrimos el detalle para los items.
  const tipoOC = h('input', { type: 'radio', name: 'origen', value: 'oc', checked: true });
  const tipoCC = h('input', { type: 'radio', name: 'origen', value: 'caja_chica' });
  const proveedor = h('input', { placeholder: 'Proveedor (puedes editarlo después)' });

  await modal({
    title: 'Nueva recepción',
    body: h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', {}, 'Origen'),
        h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [tipoOC, h('span', {}, '📋 OC (con orden de compra de materiales)')]),
        h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [tipoCC, h('span', {}, '💵 Caja chica (compra en sitio)')])
      ]),
      h('div', { class: 'field' }, [h('label', {}, 'Proveedor'), proveedor])
    ]),
    confirmLabel: 'Crear',
    onConfirm: async () => {
      try {
        const u = state.user;
        const id = await createRecepcion(obraId,
          { uid: u.uid, displayName: u.displayName || '', email: u.email || '' },
          {
            origenTipo: tipoOC.checked ? 'oc' : 'caja_chica',
            proveedor: proveedor.value.trim()
          });
        toast('Recepción creada', 'ok');
        navigate(`/obras/${obraId}/recepciones/${id}`);
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function confirmDelete(obraId, recId, r) {
  // Si tiene reporte en caja chica no aprobado, lo eliminamos en cascada.
  // Si está aprobado, advertimos: no se borra (debería reabrirse el gasto primero).
  const ccMov = await findMovimientoCajaChicaByRecepcion(obraId, recId);
  const aprobada = ccMov?.mov?.estado === 'aprobado';
  const reportada = ccMov && !aprobada;

  await modal({
    title: 'Borrar recepción',
    body: h('div', {}, [
      h('p', {}, `Se borrará la recepción E-${String(r.numero).padStart(4, '0')} y todos sus items.`),
      aprobada
        ? h('p', { style: { color: 'var(--danger)', fontSize: '12px' } },
            '⚠ Esta recepción tiene un gasto APROBADO en caja chica. Reabre o rechaza el gasto desde caja chica antes de borrarla.')
        : reportada
          ? h('p', { class: 'muted', style: { fontSize: '12px' } },
              `También se borrará el gasto reportado en caja chica (${ccMov.mov.monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}, estado: ${ccMov.mov.estado}).`)
          : null
    ]),
    confirmLabel: aprobada ? 'Bloqueado' : 'Borrar', danger: true,
    onConfirm: async () => {
      if (aprobada) { toast('Reabre o rechaza el gasto en caja chica primero', 'danger'); return false; }
      if (reportada) {
        if (ccMov.mov.buzonItemId) {
          try { await deleteBuzonItem(ccMov.mov.buzonItemId); }
          catch (e) { console.error('No se pudo eliminar item buzón', e); }
        }
        await deleteMovimientoCajaChica(obraId, ccMov.id);
      }
      await deleteRecepcion(obraId, recId);
      toast('Recepción borrada', 'ok');
      renderRecepcionesList({ params: { id: obraId } });
      return true;
    }
  });
}

// =================== Detalle ===================

export async function renderRecepcionDetalle({ params }) {
  const obraId = params.id;
  const recId = params.recid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', null), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, rec, catMat, catCon, requisiciones, ccMov] = await Promise.all([
    getObraMetaLegacy(obraId),
    getRecepcion(obraId, recId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listRequisiciones(obraId),
    findMovimientoCajaChicaByRecepcion(obraId, recId)
  ]);
  if (!rec) {
    renderShell(crumbs(obraId, meta?.nombre, null), h('div', { class: 'empty' }, 'Recepción no encontrada.'));
    return;
  }
  setState({ catalogo: catMat, conceptos: catCon?.conceptos || null });

  const folio = `E-${String(rec.numero || 0).padStart(4, '0')}`;
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};
  const editable = rec.estado === 'borrador';
  const isCajaChica = rec.origenTipo === 'caja_chica';
  const totalRec = Number(rec.totalRecepcion) || 0;
  const movMonto = ccMov ? Number(ccMov.mov.monto) || 0 : 0;
  const movEstado = ccMov?.mov?.estado || null;
  const needsUpdate = ccMov && Math.abs(movMonto - totalRec) > 0.01;

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoBadge(rec.estado), ' ', origenBadge(rec.origenTipo)]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', {
      class: 'btn primary',
      onClick: () => addItemDialog(obraId, recId, materiales, conceptos)
    }, '+ Agregar material'),
    isCajaChica && editable && (!ccMov
      ? h('button', {
          class: 'btn',
          title: 'Crea un gasto reportado en caja chica con el total actual',
          disabled: totalRec <= 0,
          onClick: () => onReportarCajaChica(obraId, recId, rec)
        }, '📤 Reportar a caja chica')
      : needsUpdate && movEstado !== 'aprobado'
        ? h('button', {
            class: 'btn warn',
            title: `Reporte actualmente registra ${movMonto}, total real es ${totalRec}`,
            onClick: () => onActualizarCajaChica(obraId, recId, rec, ccMov)
          }, '🔄 Actualizar reporte')
        : null),
    editable && h('button', {
      class: 'btn',
      title: 'En construcción — mandará al buzón hacia bitácora',
      disabled: true
    }, '↗ Enviar al contador (próximamente)')
  ]);

  const metaCard = renderMetaCard(obraId, recId, rec, requisiciones, editable, ccMov);
  const itemsCard = renderItemsCard(obraId, recId, rec, materiales, conceptos, editable);

  renderShell(crumbs(obraId, meta?.nombre, folio), h('div', {}, [head, metaCard, itemsCard]));
}

// Construye el desglose por concepto desde los items de la recepción.
// La futura vista del contador/aprobador en bitácora puede usar esto para
// generar el desglose_presupuesto al asentar el gasto.
function buildDesgloseFromRecepcion(rec, conceptos) {
  const acum = new Map();   // conceptoKey → monto
  for (const it of Object.values(rec.items || {})) {
    if (!it.materialKey) continue;
    const ck = it.conceptoKey || null;
    const monto = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);
    if (!ck) continue;
    acum.set(ck, (acum.get(ck) || 0) + monto);
  }
  const out = [];
  for (const [ck, monto] of acum) {
    const c = conceptos?.[ck];
    out.push({
      conceptoKey: ck,
      conceptoClave: c?.clave || null,
      conceptoDescripcion: c?.descripcion || null,
      monto: +monto.toFixed(2)
    });
  }
  return out;
}

async function onReportarCajaChica(obraId, recId, rec) {
  const total = Number(rec.totalRecepcion) || 0;
  if (total <= 0) { toast('Agrega items con costo primero', 'warn'); return; }
  const conceptos = state.conceptos || {};
  await modal({
    title: 'Reportar a caja chica',
    body: h('div', {}, [
      h('p', {}, [
        'Se creará un gasto reportado de ',
        h('b', {}, total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })),
        ' en la caja chica de esta obra y se publicará al buzón cross-app.'
      ]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El admin/contador lo verá pendiente desde caja chica o desde bitácora. Al aprobar se descuenta del saldo y se asienta como gasto contable.')
    ]),
    confirmLabel: '📤 Reportar',
    onConfirm: async () => {
      const u = state.user;
      const comentario = `Recepción E-${String(rec.numero).padStart(4, '0')}` + (rec.proveedor ? ` · ${rec.proveedor}` : '');
      const desglose = buildDesgloseFromRecepcion(rec, conceptos);
      // 1) Crear el movimiento en caja chica
      const movId = await addMovimientoCajaChica(obraId, {
        tipo: 'gasto',
        estado: 'reportado',
        monto: total,
        fecha: rec.fecha || Date.now(),
        comentario,
        autor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' },
        refRecepcionId: recId
      });
      // 2) Publicar al buzón cross-app
      try {
        const buzonItemId = await pushBuzonItem({
          tipo: 'gasto_caja_chica',
          origenApp: 'materiales',
          obraId,
          movimientoId: movId,
          refRecepcionId: recId,
          monto: total,
          fecha: rec.fecha || Date.now(),
          comentario,
          proveedor: rec.proveedor || null,
          factura: rec.factura || null,
          desglose,
          autor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' },
          estado: 'recibido'
        });
        await updateMovimientoCajaChica(obraId, movId, { buzonItemId });
      } catch (e) {
        console.error('No se pudo publicar al buzón', e);
        toast('Reportado en caja chica, pero falló la publicación al buzón', 'warn');
      }
      toast('Reportado a caja chica', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return true;
    }
  });
}

async function onActualizarCajaChica(obraId, recId, rec, ccMov) {
  const total = Number(rec.totalRecepcion) || 0;
  const conceptos = state.conceptos || {};
  await modal({
    title: 'Actualizar reporte de caja chica',
    body: h('div', {}, [
      h('p', {}, [
        'El reporte actual registra ',
        h('b', {}, ccMov.mov.monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })),
        '. El total real de la recepción es ahora ',
        h('b', {}, total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })), '.'
      ]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Se actualizará el monto reportado, vuelve a "reportado" si estaba rechazado, y se sincroniza el item del buzón.')
    ]),
    confirmLabel: '🔄 Actualizar',
    onConfirm: async () => {
      const comentario = `Recepción E-${String(rec.numero).padStart(4, '0')}` + (rec.proveedor ? ` · ${rec.proveedor}` : '');
      const desglose = buildDesgloseFromRecepcion(rec, conceptos);
      await updateMovimientoCajaChica(obraId, ccMov.id, {
        monto: total,
        estado: 'reportado',
        fecha: rec.fecha || Date.now(),
        comentario
      });
      if (ccMov.mov.buzonItemId) {
        try {
          await updateBuzonItem(ccMov.mov.buzonItemId, {
            monto: total,
            estado: 'recibido',
            fecha: rec.fecha || Date.now(),
            comentario,
            desglose,
            proveedor: rec.proveedor || null,
            factura: rec.factura || null
          });
        } catch (e) { console.error('No se pudo sincronizar buzón', e); }
      }
      toast('Reporte actualizado', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return true;
    }
  });
}

function renderMetaCard(obraId, recId, rec, requisiciones, editable, ccMov) {
  const fechaInput = h('input', { type: 'date', value: toDateInputVal(rec.fecha), disabled: !editable });
  fechaInput.addEventListener('change', async () => {
    const ms = fechaInput.value ? new Date(fechaInput.value + 'T12:00').getTime() : Date.now();
    await updateRecepcion(obraId, recId, { fecha: ms });
    toast('Fecha actualizada', 'ok');
  });

  const proveedorInput = h('input', { value: rec.proveedor || '', disabled: !editable, placeholder: 'Proveedor' });
  proveedorInput.addEventListener('change', async () => {
    await updateRecepcion(obraId, recId, { proveedor: proveedorInput.value.trim() });
    toast('Proveedor actualizado', 'ok');
  });

  const facturaInput = h('input', { value: rec.factura || '', disabled: !editable, placeholder: 'Folio de factura (opcional)' });
  facturaInput.addEventListener('change', async () => {
    await updateRecepcion(obraId, recId, { factura: facturaInput.value.trim() });
  });

  const notasInput = h('input', { value: rec.notas || '', disabled: !editable, placeholder: 'Notas (opcional)' });
  notasInput.addEventListener('change', async () => {
    await updateRecepcion(obraId, recId, { notas: notasInput.value.trim() || null });
  });

  // Vínculo con requisición — disponible para AMBOS orígenes (la de caja chica
  // suele venir de una req hecha en sitio que el auxiliar fue a comprar al
  // momento). Para caja_chica además agregamos campo "Ticket".
  const reqEntries = Object.entries(requisiciones || {})
    .filter(([, r]) => r.estado === 'enviada' || r.estado === 'borrador')
    .sort((a, b) => (b[1].numero || 0) - (a[1].numero || 0));

  const reqSel = h('select', { disabled: !editable }, [
    h('option', { value: '' }, '— sin vínculo —'),
    ...reqEntries.map(([rid, r]) => h('option', {
      value: rid,
      selected: rec.origenRef?.reqId === rid
    }, `R-${String(r.numero).padStart(4, '0')}  (${Object.keys(r.items || {}).length} items, ${r.estado})`))
  ]);
  reqSel.addEventListener('change', async () => {
    const reqId = reqSel.value || null;
    const newOrigenRef = reqId
      ? { ...(rec.origenRef || {}), reqId }
      : { ...(rec.origenRef || {}), reqId: null };
    // Limpiamos reqId null si quedó undefined
    if (!newOrigenRef.reqId) delete newOrigenRef.reqId;
    await updateRecepcion(obraId, recId, { origenRef: Object.keys(newOrigenRef).length ? newOrigenRef : null });
    if (reqId) {
      // Ofrecer importar items si hay req válida
      offerImportItems(obraId, recId, reqId);
    } else {
      toast('Vínculo removido', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
    }
  });

  const vinculoCards = [
    h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [
      h('label', {}, 'Requisición vinculada'),
      reqSel
    ])
  ];

  if (rec.origenTipo === 'caja_chica') {
    const ticketDescInput = h('input', {
      value: rec.origenRef?.ticketDescripcion || '', disabled: !editable,
      placeholder: 'Descripción del ticket / referencia (foto se subirá próximamente)'
    });
    ticketDescInput.addEventListener('change', async () => {
      const newOrigenRef = { ...(rec.origenRef || {}), ticketDescripcion: ticketDescInput.value.trim() };
      if (!newOrigenRef.ticketDescripcion) delete newOrigenRef.ticketDescripcion;
      await updateRecepcion(obraId, recId, { origenRef: Object.keys(newOrigenRef).length ? newOrigenRef : null });
    });
    vinculoCards.push(h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [
      h('label', {}, 'Ticket'), ticketDescInput
    ]));
  }

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Datos'),
    h('div', { class: 'grid-3' }, [
      kv('Folio', `E-${String(rec.numero || 0).padStart(4, '0')}`),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaInput]),
      kv('Total recepción', money(rec.totalRecepcion || 0)),
      h('div', { class: 'field' }, [h('label', {}, 'Proveedor'), proveedorInput]),
      h('div', { class: 'field' }, [h('label', {}, 'Factura'), facturaInput]),
      kv('Recibido por', rec.recibidoPor?.displayName || rec.recibidoPor?.email || '—'),
      ...vinculoCards,
      ccMov ? h('div', { style: { gridColumn: 'span 3' } }, [renderCajaChicaStatus(obraId, ccMov, rec)]) : null,
      h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [h('label', {}, 'Notas'), notasInput])
    ])
  ]);
}

function renderCajaChicaStatus(obraId, ccMov, rec) {
  const m = ccMov.mov;
  const totalRec = Number(rec.totalRecepcion) || 0;
  const needsUpdate = Math.abs(m.monto - totalRec) > 0.01 && m.estado !== 'aprobado';
  const badge = m.estado === 'reportado' ? h('span', { class: 'tag warn' }, '⏳ Reportado a caja chica')
    : m.estado === 'aprobado' ? h('span', { class: 'tag ok' }, '✓ Aprobado por contador')
    : m.estado === 'rechazado' ? h('span', { class: 'tag danger' }, '✕ Rechazado por contador')
    : h('span', { class: 'tag muted' }, m.estado);

  return h('div', {
    style: { padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px' }
  }, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, 'Caja chica'),
    h('div', { class: 'row', style: { marginTop: '6px', gap: '10px' } }, [
      badge,
      h('span', { style: { fontSize: '13px' } }, `Monto reportado: ${m.monto.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`),
      needsUpdate ? h('span', { class: 'tag', style: { background: 'rgba(245,196,81,.15)', color: 'var(--warn)' } },
        `⚠ Total real ahora: ${totalRec.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}`) : null,
      h('a', { href: `#/obras/${obraId}/caja-chica`, style: { fontSize: '12px', marginLeft: 'auto' } }, 'Ver caja chica →')
    ])
  ]);
}

// Si la req tiene items, ofrece importarlos a la recepción.
async function offerImportItems(obraId, recId, reqId) {
  try {
    const req = await getRequisicion(obraId, reqId);
    const items = req?.items || {};
    const itemEntries = Object.entries(items);
    if (itemEntries.length === 0) {
      toast('La requisición no tiene items', 'warn');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return;
    }
    // Cargamos catálogo para precargar costo unitario.
    const catMat = await loadCatalogoMateriales(obraId);
    const materiales = catMat?.items || {};

    const existingItemsRaw = await getRecepcion(obraId, recId).then(r => r?.items || {});
    const yaTiene = Object.keys(existingItemsRaw).length > 0;

    const ok = await modal({
      title: 'Importar items de la requisición',
      body: h('div', {}, [
        h('p', {}, [
          'La requisición R-', String(req.numero).padStart(4, '0'),
          ' tiene ', h('b', {}, itemEntries.length), ' items.'
        ]),
        h('p', { class: 'muted', style: { fontSize: '12px' } },
          yaTiene
            ? '⚠ Esta recepción ya tiene items. Los nuevos se agregarán encima — los que ya existían no se duplican (se detectan por el material).'
            : 'Cada item se crea con cantidad y concepto sugeridos por la requisición, y costo unitario tomado del catálogo. Podrás editar cada uno y registrar la razón si la cantidad recibida difiere.')
      ]),
      confirmLabel: 'Importar',
      onConfirm: async () => true
    });
    if (!ok) {
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return;
    }

    // Dedupe por materialKey: si ya existe un item de recepción con ese material,
    // no lo agregamos (evita duplicar al cambiar de req y volver a vincular).
    const yaPorMaterial = new Set(
      Object.values(existingItemsRaw).map(it => it.materialKey).filter(Boolean)
    );
    let importados = 0, omitidos = 0;
    for (const [reqItemId, it] of itemEntries) {
      if (!it.materialKey) continue;
      if (yaPorMaterial.has(it.materialKey)) { omitidos++; continue; }
      const m = materiales[it.materialKey];
      await addRecepcionItem(obraId, recId, {
        materialKey: it.materialKey,
        cantidad: Number(it.cantidad) || 0,
        costoUnitario: m?.costoUnitario || 0,
        conceptoKey: it.conceptoKey || null,
        notas: it.notas || null,
        requisicionItemRef: { reqId, itemId: reqItemId, cantidadOriginal: Number(it.cantidad) || 0 },
        razonDiferencia: null
      });
      importados++;
    }
    toast(`${importados} items importados${omitidos > 0 ? ` · ${omitidos} omitidos (ya estaban)` : ''}`, 'ok');
    renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
  } catch (err) {
    console.error(err);
    toast('Error al importar: ' + err.message, 'danger');
  }
}

function renderItemsCard(obraId, recId, rec, materiales, conceptos, editable) {
  const itemEntries = Object.entries(rec.items || {});
  if (itemEntries.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Items'),
      h('div', { class: 'empty' }, [
        h('div', {}, 'Sin items todavía.'),
        editable && h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
          'Agrega los materiales que llegaron, con su cantidad y costo unitario.')
      ])
    ]);
  }
  const rows = itemEntries.map(([itemId, it]) => itemRow(obraId, recId, itemId, it, materiales, conceptos, editable));
  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 0' } }, h('h3', {}, [
      'Items ',
      h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(itemEntries.length)})`)
    ])),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', { class: 'num' }, 'Costo unit.'),
        h('th', { class: 'num' }, 'Importe'),
        h('th', {}, 'Concepto'),
        editable && h('th', {}, '')
      ])]),
      h('tbody', {}, rows)
    ])
  ]);
}

function itemRow(obraId, recId, itemId, it, materiales, conceptos, editable) {
  const m = materiales[it.materialKey];
  const matLabel = m
    ? h('div', {}, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave),
      h('div', {}, m.descripcion),
      m.marca && h('div', { class: 'muted', style: { fontSize: '11px' } }, m.marca)
    ])
    : h('div', { class: 'tag danger' }, '⚠ Material eliminado del catálogo');

  const importe = (Number(it.cantidad) || 0) * (Number(it.costoUnitario) || 0);

  const conceptoLabel = it.conceptoKey && conceptos[it.conceptoKey]
    ? h('span', { title: conceptos[it.conceptoKey].descripcion }, [
      h('span', { class: 'mono', style: { fontSize: '11px' } }, conceptos[it.conceptoKey].clave),
      h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } }, (conceptos[it.conceptoKey].descripcion || '').slice(0, 30))
    ])
    : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');

  // Cantidad cell: muestra Δ si hay requisicionItemRef y la cantidad difiere.
  const cantCell = (() => {
    const cur = Number(it.cantidad) || 0;
    if (!it.requisicionItemRef) return num(it.cantidad, 2);
    const orig = Number(it.requisicionItemRef.cantidadOriginal) || 0;
    const delta = cur - orig;
    if (Math.abs(delta) < 0.0001) return num(it.cantidad, 2);
    const sign = delta > 0 ? '+' : '';
    const tooltip = `Requisitada: ${orig} · Recibida: ${cur} · Δ ${sign}${delta}` + (it.razonDiferencia ? `\nRazón: ${it.razonDiferencia}` : '\nSin razón registrada');
    return h('span', { title: tooltip }, [
      num(it.cantidad, 2),
      h('span', {
        class: 'tag',
        style: {
          marginLeft: '4px', fontSize: '10px',
          background: delta > 0 ? 'rgba(76,194,255,.18)' : 'rgba(245,196,81,.18)',
          color: delta > 0 ? '#4cc2ff' : '#f5c451'
        }
      }, `Δ ${sign}${delta}`)
    ]);
  })();

  return h('tr', {}, [
    h('td', { style: { maxWidth: '320px' } }, matLabel),
    h('td', {}, m?.unidad || ''),
    h('td', { class: 'num' }, cantCell),
    h('td', { class: 'num' }, money(it.costoUnitario)),
    h('td', { class: 'num' }, money(importe)),
    h('td', {}, conceptoLabel),
    editable && h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', {
        class: 'btn sm ghost',
        onClick: () => editItemDialog(obraId, recId, itemId, it, materiales, conceptos)
      }, '✎'),
      h('button', {
        class: 'btn sm danger',
        onClick: () => onRemoveItem(obraId, recId, itemId)
      }, '🗑')
    ]))
  ]);
}

function addItemDialog(obraId, recId, materiales, conceptos) {
  materialItemDialog({
    obraId,
    title: 'Agregar material a la recepción',
    materiales, conceptos,
    showConcepto: true, showCosto: true,
    onSave: async (data) => {
      await addRecepcionItem(obraId, recId, data);
      toast('Item agregado', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
    }
  });
}

function editItemDialog(obraId, recId, itemId, it, materiales, conceptos) {
  materialItemDialog({
    obraId,
    title: 'Editar item',
    materiales, conceptos,
    initial: it,
    lockedMaterial: true,
    showConcepto: true, showCosto: true,
    showRequisicionDelta: !!it.requisicionItemRef,
    onSave: async (data) => {
      await updateRecepcionItem(obraId, recId, itemId, data);
      toast('Item actualizado', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
    }
  });
}

async function onRemoveItem(obraId, recId, itemId) {
  await modal({
    title: 'Quitar item',
    body: h('div', {}, '¿Quitar este material de la recepción?'),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeRecepcionItem(obraId, recId, itemId);
      toast('Item eliminado', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return true;
    }
  });
}

// === Helpers ===

function kv(label, val) {
  return h('div', { class: 'field' }, [h('label', {}, label), h('div', {}, val || '—')]);
}
function toDateInputVal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function crumbs(obraId, nombre, folio) {
  const c = [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Recepciones', to: `/obras/${obraId}/recepciones` }
  ];
  if (folio !== undefined) c.push({ label: folio || '...' });
  return c;
}
