import { h, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { listObrasForUser } from '../services/db.js';
import { navigate } from '../state/router.js';
import { dateMx } from '../util/format.js';

export async function renderObrasList() {
  renderShell([{ label: 'Obras' }], h('div', { class: 'empty' }, 'Cargando obras…'));

  let obras;
  try {
    obras = await listObrasForUser(state.user);
  } catch (err) {
    renderShell([{ label: 'Obras' }], h('div', { class: 'empty' }, 'Error: ' + err.message));
    return;
  }
  setState({ obras });

  const isAdmin = state.user.role === 'admin';
  const head = h('div', { class: 'row' }, [
    h('h1', {}, 'Obras'),
    h('div', { class: 'spacer', style: { flex: 1 } }),
    isAdmin && h('button', { class: 'btn ghost', onClick: () => navigate('/admin') }, '⚙ Admin')
  ]);

  const ids = Object.keys(obras);
  const grid = ids.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📦'),
      h('div', {}, isAdmin
        ? 'No hay obras aún. Las obras se crean desde la app de estimaciones.'
        : 'No tienes obras asignadas. Pídele al admin que te asigne.')
    ])
    : h('div', { class: 'obras-grid' }, ids.map(id => obraCard(id, obras[id])));

  renderShell([{ label: 'Obras' }], h('div', {}, [head, grid]));
}

function obraCard(id, obra) {
  const m = obra.meta || {};
  return h('div', { class: 'obra-card', onClick: () => navigate('/obras/' + id) }, [
    h('h3', {}, m.nombre || 'Sin nombre'),
    h('div', { class: 'meta' }, [
      h('div', {}, [h('span', { class: 'muted' }, 'Contrato '), m.contratoNo || '—']),
      h('div', {}, [h('span', { class: 'muted' }, 'Cliente: '), m.cliente || '—']),
      h('div', {}, [h('span', { class: 'muted' }, 'Ubicación: '), m.ubicacion || '—', m.municipio ? `, ${m.municipio}` : ''])
    ]),
    h('div', { class: 'stats' }, [
      h('div', {}, m.fechaInicio ? dateMx(m.fechaInicio) : '—')
    ])
  ]);
}
