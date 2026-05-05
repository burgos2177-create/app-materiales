import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { getObraMetaLegacy, listRequisiciones, createRequisicion, deleteRequisicion } from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx, num0 } from '../util/format.js';

export async function renderRequisicionesList({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, reqs] = await Promise.all([
    getObraMetaLegacy(obraId),
    listRequisiciones(obraId)
  ]);

  const ids = Object.keys(reqs);
  // ordenar por numero descendente
  ids.sort((a, b) => (reqs[b].numero || 0) - (reqs[a].numero || 0));

  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Requisiciones'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => onCreate(obraId) }, '+ Nueva requisición')
  ]);

  let body;
  if (ids.length === 0) {
    body = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📝'),
      h('div', {}, 'Sin requisiciones todavía.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
        'Crea una para empezar a listar lo que hace falta en obra.')
    ]);
  } else {
    const rows = ids.map(id => requisicionRow(obraId, id, reqs[id]));
    body = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, '#'),
          h('th', {}, 'Fecha'),
          h('th', {}, 'Solicita'),
          h('th', { class: 'num' }, 'Items'),
          h('th', {}, 'Estado'),
          h('th', {}, 'Última actualización'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, rows)
      ])
    ]);
  }

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [head, body]));
}

function requisicionRow(obraId, reqId, r) {
  const itemsCount = r.items ? Object.keys(r.items).length : 0;
  return h('tr', {
    style: { cursor: 'pointer' },
    onClick: () => navigate(`/obras/${obraId}/requisiciones/${reqId}`)
  }, [
    h('td', { class: 'mono' }, `R-${String(r.numero || 0).padStart(4, '0')}`),
    h('td', {}, dateMx(r.fechaSolicitud) || '—'),
    h('td', { class: 'muted' }, r.solicitadoPor?.displayName || r.solicitadoPor?.email || '—'),
    h('td', { class: 'num' }, num0(itemsCount)),
    h('td', {}, estadoBadge(r.estado)),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, r.updatedAt ? new Date(r.updatedAt).toLocaleString('es-MX') : '—'),
    h('td', {},
      r.estado === 'borrador' && h('button', {
        class: 'btn sm danger',
        onClick: (e) => { e.stopPropagation(); confirmDelete(obraId, reqId, r); }
      }, 'Borrar')
    )
  ]);
}

export function estadoBadge(estado) {
  if (estado === 'borrador') return h('span', { class: 'tag warn' }, '✎ Borrador');
  if (estado === 'enviada')  return h('span', { class: 'tag ok' }, '↗ Enviada');
  if (estado === 'cancelada') return h('span', { class: 'tag muted', style: { textDecoration: 'line-through' } }, '✕ Cancelada');
  return h('span', { class: 'tag muted' }, estado || '—');
}

async function onCreate(obraId) {
  try {
    const u = state.user;
    const id = await createRequisicion(obraId, {
      uid: u.uid, displayName: u.displayName || '', email: u.email || ''
    });
    toast('Requisición creada', 'ok');
    navigate(`/obras/${obraId}/requisiciones/${id}`);
  } catch (err) {
    toast('Error: ' + err.message, 'danger');
  }
}

async function confirmDelete(obraId, reqId, r) {
  await modal({
    title: 'Borrar requisición',
    body: h('div', {}, `Se borrará la requisición R-${String(r.numero).padStart(4,'0')} y todos sus items. Esta acción no se puede deshacer.`),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      await deleteRequisicion(obraId, reqId);
      toast('Requisición borrada', 'ok');
      renderRequisicionesList({ params: { id: obraId } });
      return true;
    }
  });
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Requisiciones' }
  ];
}
