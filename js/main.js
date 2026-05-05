import { onAuth, getUserProfile } from './services/auth.js';
import { state, setState } from './state/store.js';
import { route, startRouter, navigate } from './state/router.js';
import { renderLogin } from './views/login.js';
import { renderObrasList } from './views/obras.js';
import { renderObra } from './views/obra.js';
import { renderAdmin } from './views/admin.js';
import { renderCatalogo } from './views/catalogo.js';
import { renderDashboard } from './views/dashboard.js';
import { renderCajaChica } from './views/caja-chica.js';
import { renderRequisicionesList } from './views/requisiciones.js';
import { renderRequisicionDetalle } from './views/requisicion.js';
import { renderRecepcionesList, renderRecepcionDetalle } from './views/recepciones.js';
import { renderSalidasList, renderSalidaDetalle } from './views/salidas.js';
import { h, mount } from './util/dom.js';

route('/',                                  () => renderObrasList());
route('/admin',                             () => renderAdmin());
route('/obras/:id',                         renderObra);
route('/obras/:id/catalogo',                renderCatalogo);
route('/obras/:id/dashboard',               renderDashboard);
route('/obras/:id/caja-chica',              renderCajaChica);
route('/obras/:id/requisiciones',           renderRequisicionesList);
route('/obras/:id/requisiciones/:reqid',    renderRequisicionDetalle);
route('/obras/:id/recepciones',             renderRecepcionesList);
route('/obras/:id/recepciones/:recid',      renderRecepcionDetalle);
route('/obras/:id/salidas',                 renderSalidasList);
route('/obras/:id/salidas/:salid',          renderSalidaDetalle);

let started = false;

onAuth(async (fbUser) => {
  if (!fbUser) {
    setState({ user: null });
    renderLogin();
    return;
  }
  let profile = null;
  try { profile = await getUserProfile(fbUser.uid); }
  catch (err) { console.error('No se pudo leer /legacy/estimaciones/users/{uid}', err); }

  if (!profile) {
    mount('#app', h('div', { class: 'login-shell' }, h('div', { class: 'login-card' }, [
      h('h1', {}, 'Sin acceso'),
      h('p', { class: 'sub' }, 'Tu cuenta existe pero no tienes un perfil registrado en la suite.'),
      h('p', { class: 'sub muted', style: { fontSize: '12px' } },
        'Pide al administrador que te dé de alta en la app de estimaciones o aquí mismo.'),
      h('button', { class: 'btn', onClick: async () => {
        const { logout } = await import('./services/auth.js');
        logout();
      } }, 'Salir')
    ])));
    return;
  }
  setState({ user: { uid: fbUser.uid, email: fbUser.email, ...profile } });
  if (!started) { startRouter(); started = true; }
  else { navigate('/'); }
});
