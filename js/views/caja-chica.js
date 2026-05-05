// Módulo de caja chica por obra. Vive en /shared/cajaChica compartido con
// appsogrub. Esta app SOLICITA y reporta; la autoridad de aprobación vive
// solo en bitácora (el contador es el único que puede aprobar/rechazar).
//
// Flujo:
//   1. Almacenista/admin solicita depósito → estado='solicitado', publica al
//      buzón. NO afecta saldo todavía.
//   2. Almacenista crea recepción tipo caja_chica → "Reportar a caja chica"
//      → estado='reportado', publica al buzón.
//   3. Contador aprueba o rechaza DESDE bitácora (no desde aquí). Al aprobar:
//      el sync via /shared/cajaChica/.../movimientos/{id} cambia el estado a
//      'aprobado' y el saldo conciliado se recalcula (transferencia aprobada
//      suma; gasto aprobado resta; efectivo nunca afecta saldo).
//   4. Si saldo < umbral → alerta visual.

import { h, toast, modal } from '../util/dom.js';
import { renderShell } from './shell.js';
import { state, setState } from '../state/store.js';
import {
  getObraMetaLegacy, listRecepciones,
  listMovimientosCajaChica, getCajaChicaMeta, setCajaChicaMeta,
  addMovimientoCajaChica, updateMovimientoCajaChica, deleteMovimientoCajaChica,
  computeSaldoCajaChica,
  pushBuzonItem, deleteBuzonItem
} from '../services/db.js';
import { navigate } from '../state/router.js';
import { money, dateMx, num0 } from '../util/format.js';

const DEFAULT_UMBRAL = 1000;

export async function renderCajaChica({ params }) {
  const obraId = params.id;
  setState({ obraActual: obraId });
  renderShell(crumbs(obraId, '...'), h('div', { class: 'empty' }, 'Cargando…'));

  const [meta, ccMeta, movimientos, recepciones] = await Promise.all([
    getObraMetaLegacy(obraId),
    getCajaChicaMeta(obraId),
    listMovimientosCajaChica(obraId),
    listRecepciones(obraId)
  ]);

  const sums = computeSaldoCajaChica(movimientos);
  const umbral = (ccMeta?.umbralAlerta ?? DEFAULT_UMBRAL);
  const isAdmin = state.user?.role === 'admin';
  const lowBalance = sums.saldo < umbral && sums.saldo > 0;
  const empty = sums.saldo <= 0 && sums.totalDepositado === 0;

  // ============ Cabecera con saldo ============
  const saldoColor = sums.saldo <= 0 ? 'var(--danger)' : (lowBalance ? 'var(--warn)' : 'var(--ok)');
  const saldoCard = h('div', { class: 'card', style: { padding: '24px', textAlign: 'center' } }, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, 'Saldo conciliado'),
    h('div', { style: { fontSize: '36px', fontWeight: 700, marginTop: '6px', color: saldoColor } },
      money(sums.saldo)),
    sums.saldo <= 0 && !empty
      ? h('div', { class: 'tag danger', style: { marginTop: '8px' } }, '🔴 Saldo agotado · solicita depósito al contador')
      : lowBalance
        ? h('div', { class: 'tag warn', style: { marginTop: '8px' } },
            `⚠ Saldo bajo · umbral ${money(umbral)} · solicita depósito al contador`)
        : empty
          ? h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
              'Sin depósitos aún. Solicita el depósito inicial al contador.')
          : null,
    h('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '14px', marginTop: '20px', textAlign: 'left' }
    }, [
      kpiCell('Transferencia aprobada', money(sums.totalTransferAprobado),
        `${num0(sums.countTransferAprobado)} ✓ · afecta saldo`),
      kpiCell('Gastado aprobado', money(sums.totalGastadoAprobado),
        `${num0(sums.countGastoAprobado)} ✓ · descuenta saldo`),
      sums.totalSolicitadoPendiente > 0
        ? kpiCell('Pendiente de aprobación', money(sums.totalSolicitadoPendiente),
            `${num0(sums.countSolicitadoPendiente)} esperando al contador`,
            'var(--accent)')
        : null,
      sums.totalEfectivoAprobado > 0
        ? kpiCell('Efectivo aprobado', money(sums.totalEfectivoAprobado),
            `${num0(sums.countEfectivoAprobado)} ✓ · informativo, no afecta saldo`,
            'var(--text-1)')
        : null,
      sums.totalGastoRechazado > 0 || sums.totalTransferRechazado > 0
        ? kpiCell('Rechazado', money(sums.totalGastoRechazado + sums.totalTransferRechazado + sums.totalEfectivoRechazado),
            `${num0(sums.countGastoRechazado + sums.countTransferRechazado + sums.countEfectivoRechazado)} rechazados`)
        : null
    ])
  ]);

  // ============ Acciones ============
  // Desde esta app SOLO se solicita y se reporta. La aprobación es del contador
  // en bitácora — por eso no hay botones Aprobar/Rechazar aquí.
  const actionRow = h('div', { class: 'row' }, [
    h('h2', {}, 'Movimientos'),
    h('div', { style: { flex: 1 } }),
    h('button', { class: 'btn primary', onClick: () => onSolicitarDeposito(obraId) }, '+ Solicitar depósito'),
    isAdmin && h('button', { class: 'btn', onClick: () => onUmbral(obraId, umbral) }, '⚙ Umbral de alerta')
  ]);

  // ============ Tabla de movimientos ============
  const ids = Object.keys(movimientos);
  ids.sort((a, b) => (movimientos[b].fecha || movimientos[b].createdAt || 0) - (movimientos[a].fecha || movimientos[a].createdAt || 0));

  let table;
  if (ids.length === 0) {
    table = h('div', { class: 'empty' }, [
      h('div', { class: 'ico' }, '💰'),
      h('div', {}, 'Sin movimientos todavía.'),
      h('div', { class: 'muted', style: { marginTop: '8px', fontSize: '12px' } },
        'Solicita el depósito inicial al contador. Los gastos llegan reportados desde recepciones de caja chica.')
    ]);
  } else {
    const rows = ids.map(id => movRow(obraId, id, movimientos[id], recepciones, isAdmin));
    table = h('div', { class: 'card', style: { padding: 0, overflow: 'auto' } }, [
      h('table', { class: 'tbl' }, [
        h('thead', {}, [h('tr', {}, [
          h('th', {}, 'Fecha'),
          h('th', {}, 'Tipo'),
          h('th', {}, 'Estado'),
          h('th', { class: 'num' }, 'Monto'),
          h('th', {}, 'Comentario'),
          h('th', {}, 'Autor'),
          h('th', {}, 'Ref'),
          h('th', {}, '')
        ])]),
        h('tbody', {}, rows)
      ])
    ]);
  }

  renderShell(crumbs(obraId, meta?.nombre), h('div', {}, [
    h('h1', {}, 'Caja Chica'),
    saldoCard,
    actionRow,
    table
  ]));
}

function kpiCell(label, value, sub, color) {
  return h('div', {}, [
    h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.4px' } }, label),
    h('div', { style: { fontSize: '18px', fontWeight: 600, marginTop: '2px', color: color || 'var(--text-0)' } }, value),
    sub && h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '2px' } }, sub)
  ]);
}

function movRow(obraId, movId, m, recepciones, isAdmin) {
  const isDeposito = m.tipo === 'deposito';
  const isGasto = m.tipo === 'gasto';
  const estado = m.estado || (isDeposito ? 'aprobado' : 'reportado');  // legacy default
  const metodo = m.metodoDeposito || 'transferencia';

  const isAprobado = estado === 'aprobado';
  const isRechazado = estado === 'rechazado';
  const isPending = estado === 'solicitado' || estado === 'reportado';

  // Tipo con método si es depósito
  const tipoCell = !isDeposito
    ? h('span', { class: 'tag', style: { background: 'rgba(255,107,107,.15)', color: 'var(--danger)' } }, '⬇ Gasto')
    : metodo === 'efectivo'
      ? h('span', { class: 'tag', style: { background: 'var(--bg-3)', color: 'var(--text-1)' } }, '⬆ Depósito · 💵 Efectivo')
      : h('span', { class: 'tag', style: { background: 'rgba(93,211,158,.18)', color: 'var(--ok)' } }, '⬆ Depósito · 🏦 Transferencia');

  const buzonBadge = m.buzonItemId
    ? h('span', { class: 'tag', style: { marginLeft: '4px', fontSize: '10px', background: 'var(--bg-3)', color: 'var(--text-2)' }, title: 'Item espejo en /shared/buzon hacia bitácora' }, '↔ buzón')
    : null;
  const estadoCell = isDeposito
    ? (estado === 'solicitado' ? h('span', {}, [h('span', { class: 'tag warn' }, '⏳ Solicitado'), buzonBadge])
      : estado === 'aprobado'  ? h('span', {}, [h('span', { class: 'tag ok' }, '✓ Aprobado'), buzonBadge])
      : estado === 'rechazado' ? h('span', {}, [h('span', { class: 'tag danger' }, '✕ Rechazado'), buzonBadge])
      : h('span', { class: 'muted' }, estado))
    : (estado === 'reportado' ? h('span', {}, [h('span', { class: 'tag warn' }, '⏳ Reportado'), buzonBadge])
      : estado === 'aprobado' ? h('span', {}, [h('span', { class: 'tag ok' }, '✓ Aprobado'), buzonBadge])
      : estado === 'rechazado' ? h('span', {}, [h('span', { class: 'tag danger' }, '✕ Rechazado'), buzonBadge])
      : h('span', { class: 'muted' }, estado));

  // Color del monto: solo lo que ya afecta saldo se ve fuerte
  const afectaSaldo = (isDeposito && isAprobado && metodo === 'transferencia') || (isGasto && isAprobado);
  const montoColor = isDeposito && isAprobado && metodo === 'transferencia' ? 'var(--ok)'
    : isGasto && isAprobado ? 'var(--danger)'
    : 'var(--text-1)';
  const montoSign = isDeposito && isAprobado && metodo === 'transferencia' ? '+'
    : isGasto && isAprobado ? '−' : '';

  const recepcion = m.refRecepcionId ? recepciones[m.refRecepcionId] : null;
  const refCell = !m.refRecepcionId
    ? h('span', { class: 'muted', style: { fontSize: '12px' } }, '—')
    : recepcion
      ? h('a', {
          href: `#/obras/${obraId}/recepciones/${m.refRecepcionId}`,
          style: { fontSize: '12px' },
          title: 'Abrir la recepción'
        }, `E-${String(recepcion.numero || 0).padStart(4, '0')}`)
      : h('span', { class: 'tag warn' }, '⚠ Recepción borrada');

  // Comentario clickable cuando hay refRecepcionId — lleva directo a la recepción
  // para revisión rápida. Si no hay ref, queda como texto plano.
  const comentarioCell = m.refRecepcionId && recepcion
    ? h('a', {
        href: `#/obras/${obraId}/recepciones/${m.refRecepcionId}`,
        style: { fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '4px',
                 maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: 'Abrir la recepción para revisar items'
      }, [
        h('span', { style: { fontSize: '10px', opacity: '.6' } }, '↗'),
        h('span', {}, m.comentario || `Recepción E-${String(recepcion.numero || 0).padStart(4, '0')}`)
      ])
    : h('span', {
        class: 'muted',
        style: { fontSize: '12px', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        title: m.comentario || ''
      }, m.comentario || '');

  return h('tr', {}, [
    h('td', {}, dateMx(m.fecha) || dateMx(m.createdAt) || '—'),
    h('td', {}, tipoCell),
    h('td', {}, estadoCell),
    h('td', { class: 'num', style: { color: montoColor, fontWeight: afectaSaldo ? 600 : 400 } }, montoSign + money(m.monto)),
    h('td', {}, comentarioCell),
    h('td', { class: 'muted', style: { fontSize: '12px' } }, m.autor?.displayName || m.autor?.email || '—'),
    h('td', {}, refCell),
    h('td', {}, h('div', { class: 'row', style: { gap: '4px' } }, [
      // Solo se puede borrar mientras esté pendiente. Una vez aprobado o
      // rechazado por el contador, hay que pedir ajuste vía bitácora.
      isPending
        ? h('button', { class: 'btn sm danger', title: 'Cancelar la solicitud (solo permitido mientras esté pendiente)', onClick: () => onBorrar(obraId, movId, m) }, '🗑')
        : h('span', { class: 'muted', style: { fontSize: '11px' }, title: 'Ya procesado por contador. Para ajustar, pide cambios en bitácora.' }, '—')
    ]))
  ]);
}

// =================== Acciones del admin ===================

// Crea una SOLICITUD de depósito (no aplica todavía al saldo). El contador
// la apruebay/rechaza desde bitácora; al aprobarla, el sync cross-app
// actualiza el estado de este movimiento a 'aprobado' y el saldo se recalcula.
async function onSolicitarDeposito(obraId) {
  const monto = h('input', { type: 'number', step: '0.01', min: '0.01', placeholder: '0.00', autofocus: true });
  const fecha = h('input', { type: 'date', value: toDateInputVal(Date.now()) });
  const comentario = h('input', { placeholder: 'p.ej. depósito mensual, fondo inicial, recarga urgente…' });
  const metodoTransfer = h('input', { type: 'radio', name: 'metodoDep', value: 'transferencia', checked: true });
  const metodoEfectivo = h('input', { type: 'radio', name: 'metodoDep', value: 'efectivo' });
  const body = h('div', {}, [
    h('div', { class: 'grid-2' }, [
      h('div', { class: 'field' }, [h('label', {}, 'Monto *'), monto]),
      h('div', { class: 'field' }, [h('label', {}, 'Fecha'), fecha])
    ]),
    h('div', { class: 'field' }, [
      h('label', {}, 'Método solicitado'),
      h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [
        metodoTransfer, h('span', {}, '🏦 Transferencia bancaria — al aprobar el contador, sumará al saldo conciliado y se asentará como movimiento bancario en bitácora.')
      ]),
      h('label', { class: 'row', style: { padding: '4px 0', gap: '6px', cursor: 'pointer' } }, [
        metodoEfectivo, h('span', {}, '💵 Efectivo — al aprobar el contador, queda como registro histórico. NO afecta saldo conciliado (ese efectivo ya se contabilizó al retirarlo del banco).')
      ])
    ]),
    h('div', { class: 'field' }, [h('label', {}, 'Comentario'), comentario]),
    h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '6px' } },
      'Esto crea una SOLICITUD pendiente de aprobación. El saldo de caja chica solo cambia cuando el contador aprueba desde bitácora.')
  ]);

  await modal({
    title: 'Solicitar depósito a caja chica', body, confirmLabel: 'Solicitar',
    onConfirm: async () => {
      const m = Number(monto.value);
      if (!m || m <= 0) { toast('Monto inválido', 'danger'); return false; }
      try {
        const u = state.user;
        const metodoDeposito = metodoEfectivo.checked ? 'efectivo' : 'transferencia';
        const fechaMs = fecha.value ? new Date(fecha.value + 'T12:00').getTime() : Date.now();
        const movId = await addMovimientoCajaChica(obraId, {
          tipo: 'deposito',
          estado: 'solicitado',
          metodoDeposito,
          monto: m,
          fecha: fechaMs,
          comentario: comentario.value.trim() || null,
          autor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' }
        });
        // Tanto transferencia como efectivo van al buzón — ambos requieren
        // confirmación del contador (aunque solo transferencia aprobada
        // afecte el saldo).
        try {
          const buzonItemId = await pushBuzonItem({
            tipo: 'deposito_caja_chica',
            origenApp: 'materiales',
            obraId,
            movimientoId: movId,
            monto: m,
            fecha: fechaMs,
            metodoDeposito,
            comentario: comentario.value.trim() || null,
            autor: { uid: u.uid, displayName: u.displayName || '', email: u.email || '' },
            estado: 'recibido'
          });
          await updateMovimientoCajaChica(obraId, movId, { buzonItemId });
        } catch (e) {
          console.error('No se pudo publicar al buzón', e);
          toast('Solicitud creada, pero falló la publicación al buzón', 'warn');
        }
        toast(`Depósito solicitado: ${money(m)} (${metodoDeposito})`, 'ok');
        renderCajaChica({ params: { id: obraId } });
        return true;
      } catch (err) { toast('Error: ' + err.message, 'danger'); return false; }
    }
  });
}

async function onUmbral(obraId, umbralActual) {
  const monto = h('input', { type: 'number', step: '0.01', min: '0', value: umbralActual });
  const body = h('div', {}, [
    h('div', { class: 'field' }, [h('label', {}, 'Umbral de alerta de saldo bajo (MXN)'), monto]),
    h('div', { class: 'muted', style: { fontSize: '11px' } },
      'Cuando el saldo conciliado quede por debajo de este monto, aparecerá una alerta visual aquí (y en el futuro notificación al contador).')
  ]);
  await modal({
    title: 'Umbral de alerta', body, confirmLabel: 'Guardar',
    onConfirm: async () => {
      const v = Number(monto.value);
      if (isNaN(v) || v < 0) { toast('Valor inválido', 'danger'); return false; }
      await setCajaChicaMeta(obraId, { umbralAlerta: v });
      toast('Umbral actualizado', 'ok');
      renderCajaChica({ params: { id: obraId } });
      return true;
    }
  });
}

async function onBorrar(obraId, movId, m) {
  const isAprobado = m.tipo === 'gasto' && m.estado === 'aprobado';
  await modal({
    title: 'Borrar movimiento',
    body: h('div', {}, [
      h('p', {}, [`Borrar este ${m.tipo === 'deposito' ? 'depósito' : 'gasto'} de `, h('b', {}, money(m.monto)), '.']),
      isAprobado && h('p', { class: 'muted', style: { fontSize: '12px', color: 'var(--warn)' } },
        '⚠ Este gasto ya está aprobado. Borrarlo recalculará el saldo automáticamente.'),
      m.buzonItemId && h('p', { class: 'muted', style: { fontSize: '12px' } },
        'El item asociado en el buzón cross-app también se eliminará.')
    ]),
    confirmLabel: 'Borrar', danger: true,
    onConfirm: async () => {
      if (m.buzonItemId) {
        try { await deleteBuzonItem(m.buzonItemId); }
        catch (e) { console.error('No se pudo eliminar item de buzón', e); }
      }
      await deleteMovimientoCajaChica(obraId, movId);
      toast('Movimiento borrado', 'ok');
      renderCajaChica({ params: { id: obraId } });
      return true;
    }
  });
}

// =================== Helpers ===================

function toDateInputVal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function crumbs(obraId, nombre) {
  return [
    { label: 'Obras', to: '/' },
    { label: nombre || obraId.slice(0, 6), to: '/obras/' + obraId },
    { label: 'Caja chica' }
  ];
}
