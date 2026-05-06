import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, getRequisicion, getBuzonItem,
  loadCatalogoMateriales, loadCatalogoConceptos,
  addRequisicionItem, updateRequisicionItem, removeRequisicionItem,
  setRequisicionEstado, addRequisicionItemsBatch,
  enviarRequisicionABuzon,
  listRequisiciones, listRecepciones, listSalidas
} from '../services/db.js';
import { computeStockByMaterial } from '../services/stock.js';
import { navigate } from '../state/router.js';
import { num, num0 } from '../util/format.js';
import { estadoBadge } from './requisiciones.js';
import { materialItemDialog } from './_dialogs.js';

export async function renderRequisicionDetalle({ params }) {
  const obraId = params.id;
  const reqId = params.reqid;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...', null), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, req, catMat, catCon, todasReqs, recepciones, salidas] = await Promise.all([
    getObraMetaLegacy(obraId),
    getRequisicion(obraId, reqId),
    loadCatalogoMateriales(obraId),
    loadCatalogoConceptos(obraId),
    listRequisiciones(obraId),
    listRecepciones(obraId),
    listSalidas(obraId)
  ]);
  if (!req) {
    renderShell(crumbs(obraId, meta?.nombre, null), h('div', { class: 'empty' }, 'Requisición no encontrada.'));
    return;
  }
  setState({ catalogo: catMat, conceptos: catCon?.conceptos || null });

  // Estado del buzón en compras (si la requisición ya fue enviada).
  const buzonItem = req.buzonId ? await getBuzonItem(req.buzonId) : null;
  const buzonActivo = buzonItem && !['rechazado', 'huerfano'].includes(buzonItem.estado);

  const folio = `R-${String(req.numero || 0).padStart(4, '0')}`;
  const editable = req.estado === 'borrador' && !buzonActivo;

  // Para el panel informativo del modal: cuánto se ha pedido en OTRAS
  // requisiciones activas (excluyendo la actual y las canceladas) por material.
  const pedidoOtrosMap = new Map();
  for (const [otherReqId, r] of Object.entries(todasReqs || {})) {
    if (otherReqId === reqId) continue;
    if (r.estado === 'cancelada') continue;
    for (const it of Object.values(r.items || {})) {
      if (!it.materialKey) continue;
      pedidoOtrosMap.set(it.materialKey, (pedidoOtrosMap.get(it.materialKey) || 0) + (Number(it.cantidad) || 0));
    }
  }
  const stockMap = computeStockByMaterial(recepciones, salidas);

  const head = h('div', { class: 'row' }, [
    h('h1', {}, [folio, ' ', estadoBadge(req.estado), buzonItem && ' ', buzonItem && buzonBadge(buzonItem.estado)]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', {
      class: 'btn primary',
      onClick: () => addItemDialog(obraId, reqId, catMat?.items || {}, catCon?.conceptos || {}, pedidoOtrosMap, stockMap)
    }, '+ Agregar material'),
    editable && h('button', {
      class: 'btn',
      onClick: () => onEnviar(obraId, reqId, req)
    }, '↗ Enviar a compras'),
    editable && h('button', {
      class: 'btn ghost',
      onClick: () => onCancelar(obraId, reqId)
    }, 'Cancelar'),
    // Reabrir solo si no hay buzón activo (legacy, o el item del buzón fue
    // rechazado/huérfano y se quiere editar para reenviar).
    !editable && req.estado === 'enviada' && !buzonActivo && h('button', {
      class: 'btn ghost',
      onClick: () => onReabrir(obraId, reqId)
    }, '↺ Reabrir')
  ]);

  const metaCard = h('div', { class: 'card' }, [
    h('h3', {}, 'Datos'),
    h('div', { class: 'grid-3' }, [
      kv('Folio', folio),
      kv('Estado', req.estado),
      kv('Solicita', req.solicitadoPor?.displayName || req.solicitadoPor?.email || '—'),
      kv('Fecha solicitud', req.fechaSolicitud ? new Date(req.fechaSolicitud).toLocaleString('es-MX') : '—'),
      req.enviadaAt && kv('Enviada', new Date(req.enviadaAt).toLocaleString('es-MX')),
      req.canceladaAt && kv('Cancelada', new Date(req.canceladaAt).toLocaleString('es-MX'))
    ]),
    buzonItem && h('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' } }, [
      h('h3', {}, 'Estado en compras'),
      h('div', { class: 'row' }, [
        buzonBadge(buzonItem.estado),
        h('span', { class: 'muted', style: { fontSize: '12px' } },
          buzonItem.actualizadoAt
            ? `actualizado ${new Date(buzonItem.actualizadoAt).toLocaleString('es-MX')}`
            : (buzonItem.creadoAt ? `recibido ${new Date(buzonItem.creadoAt).toLocaleString('es-MX')}` : ''))
      ]),
      buzonItem.estado === 'rechazado' && buzonItem.motivoRechazo && h('div', {
        class: 'tag danger',
        style: { marginTop: '8px', whiteSpace: 'normal', maxWidth: '100%' }
      }, [h('b', {}, 'Motivo del rechazo: '), buzonItem.motivoRechazo]),
      buzonItem.estado === 'aprobado' && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
        'Compras está cotizando esta requisición. Se cerrará cuando se emita la orden de compra.'),
      buzonItem.estado === 'cerrado' && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
        'Compras consolidó esta requisición en una orden de compra.')
    ])
  ]);

  const itemsCard = renderItemsCard(obraId, reqId, req, catMat?.items || {}, catCon?.conceptos || {}, editable);

  renderShell(crumbs(obraId, meta?.nombre, folio), h('div', {}, [head, metaCard, itemsCard]));
}

function renderItemsCard(obraId, reqId, req, materiales, conceptos, editable) {
  const itemEntries = Object.entries(req.items || {});
  if (itemEntries.length === 0) {
    return h('div', { class: 'card' }, [
      h('h3', {}, 'Items'),
      h('div', { class: 'empty' }, [
        h('div', {}, 'Sin items todavía.'),
        editable && h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
          'Agrega los materiales que necesitas con el botón de arriba.')
      ])
    ]);
  }
  const rows = itemEntries.map(([itemId, it]) => itemRow(obraId, reqId, itemId, it, materiales, conceptos, editable));
  return h('div', { class: 'card', style: { padding: 0 } }, [
    h('div', { style: { padding: '14px 18px 0' } }, h('h3', {}, [
      'Items ', h('span', { class: 'muted', style: { fontWeight: 'normal', textTransform: 'none' } }, `(${num0(itemEntries.length)})`)
    ])),
    h('table', { class: 'tbl' }, [
      h('thead', {}, [h('tr', {}, [
        h('th', {}, 'Material'),
        h('th', {}, 'Unidad'),
        h('th', { class: 'num' }, 'Cantidad'),
        h('th', {}, 'Concepto'),
        h('th', {}, 'Notas'),
        editable && h('th', {}, '')
      ])]),
      h('tbody', {}, rows)
    ])
  ]);
}

function itemRow(obraId, reqId, itemId, it, materiales, conceptos, editable) {
  const m = materiales[it.materialKey];
  const matLabel = m
    ? h('div', {}, [
      h('div', { class: 'mono', style: { fontSize: '11px', color: 'var(--text-2)' } }, m.clave),
      h('div', {}, m.descripcion),
      m.marca && h('div', { class: 'muted', style: { fontSize: '11px' } }, m.marca)
    ])
    : h('div', { class: 'tag danger' }, '⚠ Material eliminado del catálogo');

  const conceptoLabel = it.conceptoKey
    ? (conceptos[it.conceptoKey]
      ? h('span', { title: conceptos[it.conceptoKey].descripcion }, [
        h('span', { class: 'mono', style: { fontSize: '11px' } }, conceptos[it.conceptoKey].clave),
        h('span', { class: 'muted', style: { marginLeft: '6px', fontSize: '11px' } }, (conceptos[it.conceptoKey].descripcion || '').slice(0, 30))
      ])
      : h('span', { class: 'tag warn' }, '⚠ Concepto eliminado'))
    : h('span', { class: 'muted', style: { fontSize: '12px' } }, '—');

  return h('tr', {}, [
    h('td', { style: { maxWidth: '380px' } }, matLabel),
    h('td', {}, m?.unidad || ''),
    h('td', { class: 'num' }, num(it.cantidad, 2)),
    h('td', {}, conceptoLabel),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, it.notas || ''),
    editable && h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      h('button', {
        class: 'btn sm ghost',
        onClick: () => editItemDialog(obraId, reqId, itemId, it, materiales, conceptos)
      }, '✎'),
      h('button', {
        class: 'btn sm danger',
        onClick: () => onRemoveItem(obraId, reqId, itemId)
      }, '🗑')
    ]))
  ]);
}

// === Dialogs ===

function addItemDialog(obraId, reqId, materiales, conceptos, pedidoOtrosMap, stockMap) {
  materialItemDialog({
    obraId,
    title: 'Agregar material a la requisición',
    materiales, conceptos,
    showConcepto: true, showCosto: false,
    multiAllocation: true,
    showInfoPanel: true,
    pedidoOtrosMap, stockMap,
    // Para "Prorratear" cuando no hay total escrito: usa la cantidad que falta
    // por pedir (cantOpus - pedidoOtros). Si ya se sobrepidió, queda 0 y el
    // usuario debe escribir un total explícito.
    prorrataDefault: (matKey) => {
      const m = materiales[matKey];
      if (!m) return 0;
      const cantOpus = Number(m.cantidadOpus) || 0;
      const otros = pedidoOtrosMap.get(matKey) || 0;
      return Math.max(0, cantOpus - otros);
    },
    onSave: async (items) => {
      await addRequisicionItemsBatch(obraId, reqId, items);
      toast(`${items.length} asignación${items.length > 1 ? 'es' : ''} agregada${items.length > 1 ? 's' : ''}`, 'ok');
      renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
    }
  });
}

function editItemDialog(obraId, reqId, itemId, it, materiales, conceptos) {
  materialItemDialog({
    obraId,
    title: 'Editar item',
    materiales, conceptos,
    initial: it,
    lockedMaterial: true,
    showConcepto: true, showCosto: false,
    onSave: async (data) => {
      await updateRequisicionItem(obraId, reqId, itemId, data);
      toast('Item actualizado', 'ok');
      renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
    }
  });
}


async function onRemoveItem(obraId, reqId, itemId) {
  await modal({
    title: 'Quitar item',
    body: h('div', {}, '¿Quitar este material de la requisición?'),
    confirmLabel: 'Quitar', danger: true,
    onConfirm: async () => {
      await removeRequisicionItem(obraId, reqId, itemId);
      toast('Item eliminado', 'ok');
      renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
      return true;
    }
  });
}

async function onEnviar(obraId, reqId, req) {
  const itemsCount = req.items ? Object.keys(req.items).length : 0;
  if (itemsCount === 0) { toast('La requisición no tiene items', 'danger'); return; }
  await modal({
    title: 'Enviar requisición a compras',
    body: h('div', {}, [
      h('p', {}, [`Se enviará la requisición R-${String(req.numero).padStart(4, '0')} con `, h('b', {}, itemsCount), ' items al departamento de compras.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Compras la cotiza con proveedores y emite una orden de compra. Mientras esté en proceso no se puede editar; si compras la rechaza, se puede reabrir para corregir y reenviar.')
    ]),
    confirmLabel: 'Enviar',
    onConfirm: async () => {
      try {
        const u = state.user;
        await enviarRequisicionABuzon(obraId, reqId, {
          uid: u.uid, displayName: u.displayName || '', email: u.email || ''
        });
        toast('Requisición enviada a compras', 'ok');
        renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
        return true;
      } catch (err) {
        toast('Error: ' + err.message, 'danger');
        return false;
      }
    }
  });
}

function buzonBadge(estado) {
  if (estado === 'recibido') return h('span', { class: 'tag warn' }, '📥 Recibida en compras');
  if (estado === 'en_revision') return h('span', { class: 'tag warn' }, '👁 En revisión por compras');
  if (estado === 'aprobado') return h('span', { class: 'tag ok' }, '✓ Cotizando');
  if (estado === 'cerrado') return h('span', { class: 'tag muted' }, '🔒 Cerrada · con OC');
  if (estado === 'rechazado') return h('span', { class: 'tag danger' }, '✕ Rechazada por compras');
  if (estado === 'huerfano') return h('span', { class: 'tag warn' }, '⚠ Huérfana');
  return h('span', { class: 'tag muted' }, estado || '');
}

async function onCancelar(obraId, reqId) {
  await modal({
    title: 'Cancelar requisición',
    body: h('div', {}, '¿Cancelar esta requisición? Quedará marcada como cancelada (no se borra).'),
    confirmLabel: 'Cancelar requisición', danger: true,
    onConfirm: async () => {
      await setRequisicionEstado(obraId, reqId, 'cancelada');
      toast('Requisición cancelada', 'ok');
      renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
      return true;
    }
  });
}

async function onReabrir(obraId, reqId) {
  await modal({
    title: 'Reabrir requisición',
    body: h('div', {}, 'Se vuelve a estado borrador para editar items.'),
    confirmLabel: 'Reabrir',
    onConfirm: async () => {
      await setRequisicionEstado(obraId, reqId, 'borrador');
      toast('Requisición reabierta', 'ok');
      renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
      return true;
    }
  });
}

function kv(label, val) {
  return h('div', { class: 'field' }, [
    h('label', {}, label),
    h('div', {}, val || '—')
  ]);
}

function crumbs(obraId, nombre, folio) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Requisiciones', to: `/obras/${obraId}/requisiciones` },
    { label: folio || '...' }
  ];
}
