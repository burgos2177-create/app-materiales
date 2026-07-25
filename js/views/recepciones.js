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
  pushBuzonItem, updateBuzonItem, deleteBuzonItem,
  getBuzonItem, enviarRecepcionABuzon,
  computeRecepcionMontos, buildDesgloseRecepcion as buildDesgloseFromRecepcion
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
    h('td', {}, [origenBadge(r.origenTipo), r.origenTipo === 'caja_chica' && ' ', fondoBadge(r)]),
    h('td', { class: 'muted' }, r.proveedor || '—'),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', { class: 'num' }, money(computeRecepcionMontos(r).total)),
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

// Fondo de caja chica del que salió el dinero. Sin valor = transferencia
// (todo lo capturado antes del fondo efectivo).
function fondoLabel(fondo) {
  return fondo === 'efectivo' ? '💵 Fondo efectivo' : '🏦 Fondo transferencia';
}

function fondoBadge(rec) {
  if (rec?.origenTipo !== 'caja_chica') return null;
  const esEfectivo = rec.fondoCaja === 'efectivo';
  return h('span', {
    class: 'tag',
    title: esEfectivo
      ? 'Se pagó con billete del fondo de efectivo de la obra'
      : 'Se pagó del fondo de caja chica que se repone por transferencia',
    style: esEfectivo
      ? { background: 'rgba(93,211,158,.15)', color: '#5dd39e' }
      : { background: 'rgba(76,194,255,.12)', color: '#4cc2ff' }
  }, fondoLabel(rec.fondoCaja));
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

  // Si es caja chica, ¿de cuál de los dos fondos salió? Se pregunta aquí para
  // que quede sellado desde el arranque y viaje al buzón sin que el almacenista
  // tenga que acordarse al reportar (ahí solo se confirma).
  const fondoTransfer = h('input', { type: 'radio', name: 'fondoNuevaRec', value: 'transferencia', checked: true });
  const fondoEfectivo = h('input', { type: 'radio', name: 'fondoNuevaRec', value: 'efectivo' });
  const fondoBlock = h('div', { class: 'field', style: { display: 'none', marginLeft: '22px' } }, [
    h('label', {}, '¿De qué fondo de la caja chica se pagó?'),
    h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [
      fondoTransfer, h('span', {}, '🏦 Fondo transferencia (el de siempre)')
    ]),
    h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [
      fondoEfectivo, h('span', {}, '💵 Fondo efectivo (billete del fondo de efectivo de la obra)')
    ]),
    h('div', { class: 'muted', style: { fontSize: '12px' } },
      'Define de qué saldo se descuenta al aprobar el gasto. Puedes cambiarlo después mientras la recepción siga en borrador.')
  ]);
  const syncFondoVisible = () => { fondoBlock.style.display = tipoCC.checked ? '' : 'none'; };
  tipoOC.addEventListener('change', syncFondoVisible);
  tipoCC.addEventListener('change', syncFondoVisible);

  await modal({
    title: 'Nueva recepción',
    body: h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', {}, 'Origen'),
        h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [tipoOC, h('span', {}, '📋 OC (con orden de compra de materiales)')]),
        h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [tipoCC, h('span', {}, '💵 Caja chica (compra en sitio)')])
      ]),
      fondoBlock,
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
            fondoCaja: fondoEfectivo.checked ? 'efectivo' : 'transferencia',
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

  // Estado en el buzón del contador (solo recepciones de OC ya enviadas).
  const buzonItem = rec.buzonId ? await getBuzonItem(rec.buzonId) : null;
  const buzonActivo = buzonItem && !['rechazado', 'huerfano'].includes(buzonItem.estado);

  const folio = `E-${String(rec.numero || 0).padStart(4, '0')}`;
  const conceptos = catCon?.conceptos || {};
  const materiales = catMat?.items || {};
  const editable = rec.estado === 'borrador' && !buzonActivo;
  const isCajaChica = rec.origenTipo === 'caja_chica';
  const isOC = rec.origenTipo === 'oc';
  const montos = computeRecepcionMontos(rec);
  const totalRec = montos.total;   // total con IVA (lo que se gastó / reporta)
  const movMonto = ccMov ? Number(ccMov.mov.monto) || 0 : 0;
  const movEstado = ccMov?.mov?.estado || null;
  const needsUpdate = ccMov && Math.abs(movMonto - totalRec) > 0.01;

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [
      folio, ' ', estadoBadge(rec.estado), ' ', origenBadge(rec.origenTipo),
      isCajaChica && ' ', isCajaChica && fondoBadge(rec),
      buzonItem && ' ', buzonItem && buzonGastoBadge(buzonItem.estado)
    ]),
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
    // OC → contador (bitácora). Publica gasto_oc al buzón para aprobar/registrar.
    isOC && editable && h('button', {
      class: 'btn primary',
      title: 'Envía esta recepción al buzón del contador para que apruebe y registre el gasto',
      disabled: totalRec <= 0,
      onClick: () => onEnviarContador(obraId, recId, rec, conceptos)
    }, '↗ Enviar al contador'),
    // Reabrir si el contador la rechazó (o quedó huérfana) — vuelve a borrador.
    isOC && rec.estado === 'enviada_buzon' && !buzonActivo && h('button', {
      class: 'btn ghost',
      onClick: () => onReabrirRecepcion(obraId, recId)
    }, '↺ Reabrir')
  ]);

  const metaCard = renderMetaCard(obraId, recId, rec, requisiciones, editable, ccMov, buzonItem);
  const itemsCard = renderItemsCard(obraId, recId, rec, materiales, conceptos, editable);

  renderShell(crumbs(obraId, meta?.nombre, folio), h('div', {}, [head, metaCard, itemsCard]));
}

// El desglose por concepto (consciente del modo IVA) vive en db.js
// (buildDesgloseRecepcion, importado arriba como buildDesgloseFromRecepcion).

async function onReportarCajaChica(obraId, recId, rec) {
  const montos = computeRecepcionMontos(rec);
  const total = montos.total;   // total con IVA — lo que realmente salió de la caja
  if (total <= 0) { toast('Agrega items con costo primero', 'warn'); return; }
  const conceptos = state.conceptos || {};
  // ¿De qué fondo de la caja chica salió el dinero? Transferencia (histórico)
  // o efectivo (billete físico). Ver spec-caja-chica-fondo-efectivo.md.
  // Viene preseleccionado con lo elegido al crear la recepción; aquí solo se
  // confirma (o se corrige de último momento).
  const fondoActual = rec.fondoCaja === 'efectivo' ? 'efectivo' : 'transferencia';
  const fondoTransfer = h('input', { type: 'radio', name: 'fondoCC', value: 'transferencia', checked: fondoActual !== 'efectivo' });
  const fondoEfectivo = h('input', { type: 'radio', name: 'fondoCC', value: 'efectivo', checked: fondoActual === 'efectivo' });
  await modal({
    title: 'Reportar a caja chica',
    body: h('div', {}, [
      h('p', {}, [
        'Se creará un gasto reportado de ',
        h('b', {}, total.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })),
        ' en la caja chica de esta obra y se publicará al buzón cross-app.'
      ]),
      h('div', { class: 'field' }, [
        h('label', {}, `¿De qué fondo se pagó? (elegiste ${fondoLabel(fondoActual)} al crearla)`),
        h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [
          fondoTransfer, h('span', {}, '🏦 Fondo transferencia (el de siempre)')
        ]),
        h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [
          fondoEfectivo, h('span', {}, '💵 Fondo efectivo (billete del fondo de efectivo de la obra)')
        ])
      ]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El admin/contador lo verá pendiente desde caja chica o desde bitácora. Al aprobar se descuenta del saldo del fondo elegido y se asienta como gasto contable.')
    ]),
    confirmLabel: '📤 Reportar',
    onConfirm: async () => {
      const u = state.user;
      const esEfectivo = fondoEfectivo.checked;
      // Si se corrigió el fondo aquí, que la recepción quede igual que lo
      // reportado — es lo que se ve en el listado y en el detalle.
      const fondoElegido = esEfectivo ? 'efectivo' : 'transferencia';
      if (fondoElegido !== fondoActual) {
        try { await updateRecepcion(obraId, recId, { fondoCaja: fondoElegido }); }
        catch (e) { console.error('No se pudo guardar el fondo en la recepción', e); }
      }
      const comentario = `Recepción E-${String(rec.numero).padStart(4, '0')}` + (rec.proveedor ? ` · ${rec.proveedor}` : '');
      const desglose = buildDesgloseFromRecepcion(rec, conceptos);
      // 1) Crear el movimiento en caja chica
      const mov = {
        tipo: 'gasto',
        estado: 'reportado',
        monto: total,
        fecha: rec.fecha || Date.now(),
        comentario,
        autor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' },
        refRecepcionId: recId
      };
      if (esEfectivo) mov.fondo = 'efectivo';
      const movId = await addMovimientoCajaChica(obraId, mov);
      // 2) Publicar al buzón cross-app
      try {
        const item = {
          tipo: 'gasto_caja_chica',
          origenApp: 'materiales',
          obraId,
          movimientoId: movId,
          refRecepcionId: recId,
          ivaMode: rec.ivaMode || 'sin_iva',
          monto: total,               // total con IVA (== subtotal + iva)
          subtotal: montos.subtotal,  // sin IVA (== sum(desglose.monto))
          iva: montos.iva,
          total,
          fecha: rec.fecha || Date.now(),
          comentario,
          proveedor: rec.proveedor || null,
          factura: rec.factura || null,
          desglose,
          autor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' },
          estado: 'recibido'
        };
        if (esEfectivo) item.fondo = 'efectivo';
        const buzonItemId = await pushBuzonItem(item);
        await updateMovimientoCajaChica(obraId, movId, { buzonItemId });
      } catch (e) {
        console.error('No se pudo publicar al buzón', e);
        toast('Reportado en caja chica, pero falló la publicación al buzón', 'warn');
      }
      toast('Reportado a caja chica' + (esEfectivo ? ' (fondo efectivo)' : ''), 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return true;
    }
  });
}

async function onActualizarCajaChica(obraId, recId, rec, ccMov) {
  const montos = computeRecepcionMontos(rec);
  const total = montos.total;   // total con IVA
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
            ivaMode: rec.ivaMode || 'sin_iva',
            monto: total,
            subtotal: montos.subtotal,
            iva: montos.iva,
            total,
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

function renderMetaCard(obraId, recId, rec, requisiciones, editable, ccMov, buzonItem) {
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
    // Fondo del que salió el dinero. Se puede corregir mientras la recepción
    // siga en borrador y NO se haya reportado: una vez creado el movimiento en
    // caja chica, el fondo ya está sellado ahí y en el item del buzón.
    const fondoEditable = editable && !ccMov;
    const fondoSel = h('select', { disabled: !fondoEditable }, [
      h('option', { value: 'transferencia', selected: rec.fondoCaja !== 'efectivo' }, '🏦 Fondo transferencia (el de siempre)'),
      h('option', { value: 'efectivo', selected: rec.fondoCaja === 'efectivo' }, '💵 Fondo efectivo (billete del fondo de la obra)')
    ]);
    fondoSel.value = rec.fondoCaja === 'efectivo' ? 'efectivo' : 'transferencia';
    fondoSel.addEventListener('change', async () => {
      await updateRecepcion(obraId, recId, { fondoCaja: fondoSel.value });
      toast(`Fondo: ${fondoLabel(fondoSel.value)}`, 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
    });
    vinculoCards.push(h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [
      h('label', {}, 'Fondo de caja chica'),
      fondoSel,
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } },
        ccMov
          ? 'Ya reportado: el fondo quedó sellado en el movimiento de caja chica y en el buzón.'
          : 'De este saldo se descuenta el gasto cuando el contador lo apruebe.')
    ]));

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

  // ---- IVA de la recepción (cómo cuadra el total que se reporta al contador) ----
  const montos = computeRecepcionMontos(rec);
  const ivaModeActual = rec.ivaMode || 'sin_iva';
  const IVA_MODES = [
    { v: 'sin_iva', label: 'Sin IVA (exento) — total = subtotal, no suma ni divide' },
    { v: 'mas_iva', label: 'Precio SIN IVA — súmale IVA (subtotal × factor)' },
    { v: 'iva_incluido', label: 'Precio YA con IVA — extráelo (total ÷ factor)' }
  ];
  const ivaModeSel = h('select', { disabled: !editable },
    IVA_MODES.map(o => h('option', { value: o.v, selected: ivaModeActual === o.v }, o.label)));
  ivaModeSel.value = ivaModeActual;
  ivaModeSel.addEventListener('change', async () => {
    await updateRecepcion(obraId, recId, { ivaMode: ivaModeSel.value });
    renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
  });

  const ratePct = Math.round((montos.rate || 0.16) * 100);
  const ivaRateInput = h('input', {
    type: 'number', min: '0', max: '100', step: '0.5', value: String(ratePct),
    disabled: !editable || ivaModeActual === 'sin_iva', style: { width: '80px' }
  });
  ivaRateInput.addEventListener('change', async () => {
    const rate = Math.max(0, (Number(ivaRateInput.value) || 0) / 100);
    await updateRecepcion(obraId, recId, { ivaRate: rate });
    renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
  });

  const ivaBlock = h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [
    h('label', {}, 'IVA · cómo cuadra el total que se reporta al contador'),
    h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, [
      h('div', { style: { flex: '1', minWidth: '280px' } }, ivaModeSel),
      ivaModeActual !== 'sin_iva' ? h('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'IVA %'), ivaRateInput
      ]) : null
    ]),
    h('div', { style: { marginTop: '8px', padding: '8px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px' } }, [
      h('div', { class: 'row', style: { gap: '20px', flexWrap: 'wrap', alignItems: 'baseline' } }, [
        h('span', { class: 'muted', style: { fontSize: '12px' } }, ['Subtotal ', h('span', { class: 'mono', style: { color: 'var(--text-0)' } }, money(montos.subtotal))]),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, ['IVA ', h('span', { class: 'mono', style: { color: 'var(--text-0)' } }, money(montos.iva))]),
        h('span', { style: { fontSize: '13px', fontWeight: 600 } }, ['Total a reportar ', h('span', { class: 'mono' }, money(montos.total))])
      ])
    ])
  ]);

  return h('div', { class: 'card' }, [
    h('h3', {}, 'Datos'),
    h('div', { class: 'grid-3' }, [
      kv('Folio', `E-${String(rec.numero || 0).padStart(4, '0')}`),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fechaInput]),
      kv('Total a reportar', money(montos.total)),
      h('div', { class: 'field' }, [h('label', {}, 'Proveedor'), proveedorInput]),
      h('div', { class: 'field' }, [h('label', {}, 'Factura'), facturaInput]),
      kv('Recibido por', rec.recibidoPor?.displayName || rec.recibidoPor?.email || '—'),
      ivaBlock,
      ...vinculoCards,
      ccMov ? h('div', { style: { gridColumn: 'span 3' } }, [renderCajaChicaStatus(obraId, ccMov, rec)]) : null,
      buzonItem ? h('div', { style: { gridColumn: 'span 3' } }, [renderContadorStatus(buzonItem)]) : null,
      h('div', { class: 'field', style: { gridColumn: 'span 3' } }, [h('label', {}, 'Notas'), notasInput])
    ])
  ]);
}

function renderCajaChicaStatus(obraId, ccMov, rec) {
  const m = ccMov.mov;
  const totalRec = computeRecepcionMontos(rec).total;   // total con IVA
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

// Badge del estado del gasto en el buzón del contador (máquina de estados
// de la suite: recibido → en_revision → aprobado → rechazado).
function buzonGastoBadge(estado) {
  if (estado === 'recibido') return h('span', { class: 'tag warn' }, '📥 Recibido por contador');
  if (estado === 'en_revision') return h('span', { class: 'tag warn' }, '👁 En revisión');
  if (estado === 'aprobado') return h('span', { class: 'tag ok' }, '✓ Aprobado y registrado');
  if (estado === 'cerrado') return h('span', { class: 'tag ok' }, '🔒 Cerrado');
  if (estado === 'rechazado') return h('span', { class: 'tag danger' }, '✕ Rechazado por contador');
  if (estado === 'huerfano') return h('span', { class: 'tag warn' }, '⚠ Huérfano');
  return h('span', { class: 'tag muted' }, estado || '—');
}

function formaPagoLabel(fp) {
  return ({
    credito: '💳 Crédito (por pagar)',
    efectivo: '💵 Efectivo (ya pagado)',
    transferencia: '🏦 Transferencia (ya pagada)',
    caja_chica: '🧾 Caja chica'
  })[fp] || fp || '—';
}

function renderContadorStatus(buzonItem) {
  const ts = buzonItem.actualizadoAt
    ? `actualizado ${new Date(buzonItem.actualizadoAt).toLocaleString('es-MX')}`
    : (buzonItem.creadoAt ? `enviado ${new Date(buzonItem.creadoAt).toLocaleString('es-MX')}` : '');
  const iva = Number(buzonItem.iva) || 0;
  const totalConIva = Number(buzonItem.total ?? buzonItem.monto) || 0;
  const subtotal = Number(buzonItem.subtotal ?? totalConIva) || 0;
  return h('div', {
    style: { padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px' }
  }, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, 'Contador (bitácora)'),
    h('div', { class: 'row', style: { marginTop: '6px', gap: '10px' } }, [
      buzonGastoBadge(buzonItem.estado),
      buzonItem.formaPago && h('span', { class: 'tag muted', style: { fontSize: '11px' } }, formaPagoLabel(buzonItem.formaPago)),
      ts && h('span', { class: 'muted', style: { fontSize: '12px' } }, ts)
    ]),
    h('div', { class: 'row', style: { marginTop: '6px', gap: '14px', fontSize: '12px' } }, [
      h('span', { class: 'muted' }, ['Subtotal ', h('span', { class: 'mono' }, money(subtotal))]),
      h('span', { class: 'muted' }, ['IVA ', h('span', { class: 'mono' }, money(iva))]),
      h('span', {}, ['Total ', h('span', { class: 'mono', style: { fontWeight: 600 } }, money(totalConIva))])
    ]),
    buzonItem.estado === 'rechazado' && buzonItem.motivoRechazo && h('div', {
      class: 'tag danger', style: { marginTop: '8px', whiteSpace: 'normal', maxWidth: '100%' }
    }, [h('b', {}, 'Motivo del rechazo: '), buzonItem.motivoRechazo]),
    buzonItem.estado === 'aprobado' && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
      'El contador registró el gasto en contabilidad (categoría Materiales) con el desglose por concepto.'),
    (buzonItem.estado === 'rechazado' || buzonItem.estado === 'huerfano') && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
      'Puedes reabrirla para corregir y reenviar.')
  ]);
}

// Envía la recepción de OC al buzón del contador (tipo gasto_oc).
async function onEnviarContador(obraId, recId, rec, conceptos) {
  const items = Object.values(rec.items || {}).filter(it => it.materialKey);
  const total = Number(rec.totalRecepcion) || 0;
  if (items.length === 0) { toast('Agrega items primero', 'warn'); return; }
  if (total <= 0) { toast('La recepción no tiene importe (agrega costo a los items)', 'warn'); return; }

  // Todos los items deben tener concepto — el gasto se desglosa por concepto.
  const sinConcepto = items.filter(it => !it.conceptoKey);
  if (sinConcepto.length > 0) {
    const materiales = state.catalogo?.items || {};
    await modal({
      title: 'Faltan conceptos por asignar',
      body: h('div', {}, [
        h('p', {}, [
          h('b', {}, sinConcepto.length),
          ` item(s) no tienen concepto OPUS asignado. El gasto se registra desglosado por concepto, así que cada material debe tener uno antes de enviar al contador.`
        ]),
        h('ul', { style: { margin: '8px 0 0', paddingLeft: '18px', fontSize: '13px' } },
          sinConcepto.slice(0, 12).map(it => {
            const m = materiales[it.materialKey] || {};
            return h('li', { style: { marginBottom: '2px' } }, `${m.clave || it.materialKey} — ${m.descripcion || ''}`);
          })),
        h('p', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } },
          'Edita cada item (✎) y elige su concepto destino.')
      ]),
      confirmLabel: 'Entendido'
    });
    return;
  }

  const desglose = buildDesgloseFromRecepcion(rec, conceptos);
  const folio = `E-${String(rec.numero).padStart(4, '0')}`;
  // subtotal / iva / total salen del modo IVA configurado en la recepción.
  const montos = computeRecepcionMontos(rec);
  const ivaModeTxt = ({
    sin_iva: 'Sin IVA (exento)',
    mas_iva: `Precio sin IVA + ${Math.round(montos.rate * 100)}% IVA`,
    iva_incluido: `Precio con IVA incluido (${Math.round(montos.rate * 100)}%)`
  })[montos.mode] || 'Sin IVA';

  // Forma de pago — le dice al contador si crea CxP (crédito) o si ya está pagado.
  const formaSel = h('select', {}, [
    h('option', { value: 'credito' }, 'Crédito — se paga después (queda por pagar / CxP)'),
    h('option', { value: 'efectivo' }, 'Efectivo — ya pagado'),
    h('option', { value: 'transferencia' }, 'Transferencia — ya pagada'),
    h('option', { value: 'caja_chica' }, 'Caja chica (fondo formal)')
  ]);
  formaSel.value = rec.formaPago || 'credito';

  // Si se pagó de caja chica, hay que decir de cuál de los dos fondos salió:
  // es lo que define qué saldo baja del lado del contador.
  const fondoOCSel = h('select', {}, [
    h('option', { value: 'transferencia' }, '🏦 Fondo transferencia (el de siempre)'),
    h('option', { value: 'efectivo' }, '💵 Fondo efectivo (billete del fondo de la obra)')
  ]);
  fondoOCSel.value = rec.fondoCaja === 'efectivo' ? 'efectivo' : 'transferencia';
  const fondoOCField = h('div', { class: 'field', style: { marginBottom: '10px', display: 'none' } }, [
    h('label', {}, '¿De qué fondo de la caja chica se pagó?'),
    fondoOCSel
  ]);
  const syncFondoOC = () => { fondoOCField.style.display = formaSel.value === 'caja_chica' ? '' : 'none'; };
  formaSel.addEventListener('change', syncFondoOC);
  setTimeout(syncFondoOC, 0);

  await modal({
    title: 'Enviar recepción al contador',
    body: h('div', {}, [
      h('p', {}, [`Se enviará la recepción ${folio} al buzón del contador (bitácora) para que apruebe y registre el gasto.`]),

      h('div', { class: 'field', style: { marginBottom: '10px' } }, [h('label', {}, 'Forma de pago'), formaSel]),
      fondoOCField,

      // Desglose por concepto (sin IVA — suma == subtotal) + IVA según modo de la recepción
      h('div', {
        style: { margin: '10px 0', padding: '10px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px' }
      }, [
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: '6px' } },
          `Desglose por concepto · sin IVA (${desglose.length})`),
        ...desglose.map(d => h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px' } }, [
          h('span', { class: 'mono', style: { fontSize: '12px' }, title: d.conceptoDescripcion || '' },
            `${d.conceptoClave || d.conceptoKey.slice(0, 10)} `),
          h('span', { class: 'mono', style: { fontSize: '12px' } }, money(d.monto))
        ])),
        h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)' } }, [
          h('span', { class: 'muted' }, 'Subtotal'), h('span', { class: 'mono', style: { fontSize: '12px' } }, money(montos.subtotal))
        ]),
        h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px' } }, [
          h('span', { class: 'muted' }, `IVA (${ivaModeTxt})`), h('span', { class: 'mono', style: { fontSize: '12px' } }, money(montos.iva))
        ]),
        h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '10px', marginTop: '4px', paddingTop: '4px', borderTop: '1px solid var(--border)', fontWeight: 600 } }, [
          h('span', {}, 'Total'), h('span', { class: 'mono' }, money(montos.total))
        ])
      ]),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El IVA se ajusta desde el campo "IVA" de la recepción. Mientras esté con el contador no se puede editar; si la rechaza, podrás reabrirla y reenviar.')
    ]),
    confirmLabel: '↗ Enviar al contador',
    onConfirm: async () => {
      try {
        const u = state.user;
        await enviarRecepcionABuzon(obraId, recId, {
          uid: u.uid, displayName: u.displayName || '', email: u.email || ''
        }, {
          formaPago: formaSel.value,
          fondoCaja: fondoOCSel.value
        });
        toast('Recepción enviada al contador', 'ok');
        renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

async function onReabrirRecepcion(obraId, recId) {
  await modal({
    title: 'Reabrir recepción',
    body: h('div', {}, 'Vuelve a estado borrador para editar items y reenviar al contador.'),
    confirmLabel: 'Reabrir',
    onConfirm: async () => {
      await setRecepcionEstado(obraId, recId, 'borrador');
      toast('Recepción reabierta', 'ok');
      renderRecepcionDetalle({ params: { id: obraId, recid: recId } });
      return true;
    }
  });
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
