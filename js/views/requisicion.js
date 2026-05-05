import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, getRequisicion,
  loadCatalogoMateriales, loadCatalogoConceptos,
  addRequisicionItem, updateRequisicionItem, removeRequisicionItem,
  setRequisicionEstado, addRequisicionItemsBatch,
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

  const folio = `R-${String(req.numero || 0).padStart(4, '0')}`;
  const editable = req.estado === 'borrador';

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
    h('h1', {}, [folio, ' ', estadoBadge(req.estado)]),
    h('div', { style: { flex: 1 } }),
    editable && h('button', {
      class: 'btn primary',
      onClick: () => addItemDialog(obraId, reqId, catMat?.items || {}, catCon?.conceptos || {}, pedidoOtrosMap, stockMap)
    }, '+ Agregar material'),
    editable && h('button', {
      class: 'btn',
      onClick: () => onEnviar(obraId, reqId, req)
    }, '↗ Enviar requisición'),
    editable && h('button', {
      class: 'btn ghost',
      onClick: () => onCancelar(obraId, reqId)
    }, 'Cancelar'),
    !editable && req.estado === 'enviada' && h('button', {
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
    title: 'Enviar requisición',
    body: h('div', {}, [
      h('p', {}, [`Se enviará la requisición R-${String(req.numero).padStart(4, '0')} con `, h('b', {}, itemsCount), ' items.']),
      h('p', { class: 'muted', style: { fontSize: '12px' } },
        'Una vez enviada, ya no se puede editar. Compras la convierte en orden de compra. Si necesitas modificarla, podrás reabrirla mientras compras no la haya tomado.')
    ]),
    confirmLabel: 'Enviar',
    onConfirm: async () => {
      await setRequisicionEstado(obraId, reqId, 'enviada');
      toast('Requisición enviada', 'ok');
      renderRequisicionDetalle({ params: { id: obraId, reqid: reqId } });
      return true;
    }
  });
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
