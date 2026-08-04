import { h, toast } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import { listObrasForUser } from '../services/db.js';
import {
  listHerramientas, listMovimientosHerramientas,
  computeEstadoHerramientas, resumenInventario
} from '../services/herramientas.js';
import { navigate } from '../state/router.js';
import { dateMx, money, num0 } from '../util/format.js';

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

  // El inventario de herramienta vive ANTES de las obras: la herramienta es de
  // SOGRUB y rota entre obras, no pertenece a ninguna. Desde aquí se entra al
  // módulo global; dentro de cada obra hay una vista de "lo que está aquí".
  const herramientaCard = await herramientaEntryCard();

  const ids = Object.keys(obras);
  const grid = ids.length === 0
    ? h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '📦'),
      h('div', {}, isAdmin
        ? 'No hay obras aún. Las obras se crean desde la app de estimaciones.'
        : 'No tienes obras asignadas. Pídele al admin que te asigne.')
    ])
    : h('div', { class: 'obras-grid' }, ids.map(id => obraCard(id, obras[id])));

  renderShell([{ label: 'Obras' }], h('div', {}, [head, herramientaCard, grid]));
}

// Tarjeta de entrada al módulo global de herramienta y equipo. Si el nodo aún
// no existe (o falla la lectura) se muestra igual, invitando a dar de alta.
async function herramientaEntryCard() {
  let resumen = null;
  try {
    const [catalogo, movimientos] = await Promise.all([
      listHerramientas(), listMovimientosHerramientas()
    ]);
    resumen = resumenInventario(catalogo, computeEstadoHerramientas(catalogo, movimientos));
  } catch (err) {
    console.error('No se pudo leer el inventario de herramienta', err);
  }

  const stat = (label, value, color) => h('div', {}, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.4px' } }, label),
    h('div', { style: { fontSize: '17px', fontWeight: 600, marginTop: '2px', color: color || 'var(--text-0)' } }, value)
  ]);

  return h('div', {
    class: 'card',
    style: { cursor: 'pointer', marginBottom: '4px' },
    onClick: () => navigate('/herramientas')
  }, [
    h('div', { class: 'row' }, [
      h('h3', { style: { margin: 0 } }, '🔧 Herramienta y equipo'),
      h('div', { style: { flex: 1 } }),
      h('button', {
        class: 'btn',
        onClick: (e) => { e.stopPropagation(); navigate('/herramientas'); }
      }, 'Ver inventario →')
    ]),
    !resumen || resumen.registros === 0
      ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } },
        'Sin herramienta inventariada todavía. Da de alta el equipo de SOGRUB y asígnalo a cada obra para saber siempre dónde está y con quién.')
      : h('div', {
        class: 'row',
        style: { gap: '28px', marginTop: '12px' }
      }, [
        stat('Piezas', num0(resumen.piezas)),
        stat('🏚 En almacén', num0(resumen.enAlmacen), 'var(--ok)'),
        stat('🏗 En obra', num0(resumen.enObra), 'var(--accent)'),
        resumen.enReparacion > 0 ? stat('🔧 Reparación', num0(resumen.enReparacion), 'var(--warn)') : null,
        stat('Valor', money(resumen.valor))
      ])
  ]);
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
