import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import AppsView from './views/AppsView.vue';
import { state } from './store.js';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: AppsView, meta: { title: 'Apps' } },
    { path: '/system', component: () => import('./views/SystemView.vue'), meta: { title: 'System' } },
    { path: '/power', component: () => import('./views/PowerView.vue'), meta: { title: 'Power' } },
    { path: '/updates', component: () => import('./views/UpdatesView.vue'), meta: { title: 'Updates' } },
    { path: '/docker', component: () => import('./views/DockerView.vue'), meta: { title: 'Docker' } },
    { path: '/files', component: () => import('./views/FilesView.vue'), meta: { title: 'Files' } },
    { path: '/terminal', component: () => import('./views/TerminalView.vue'), meta: { title: 'Terminal' } },
    // Another server's pages (see server/servers.js): the same views, talking to its agent.
    { path: '/s/:server', component: AppsView, meta: { title: 'Apps' } },
    { path: '/s/:server/system', component: () => import('./views/SystemView.vue'), meta: { title: 'System' } },
    { path: '/s/:server/updates', component: () => import('./views/UpdatesView.vue'), meta: { title: 'Updates' } },
    { path: '/s/:server/files', component: () => import('./views/FilesView.vue'), meta: { title: 'Files' } },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});

// Switching server starts its pages from scratch (apps, statuses, update counts).
router.beforeEach((to) => {
  const server = typeof to.params.server === 'string' ? to.params.server : '';
  if (server !== state.server) {
    state.server = server;
    state.config = null;
    state.status = {};
    state.statusLoaded = false;
    state.statusError = false;
    state.openMenu = null;
  }
});

createApp(App).use(router).mount('#app');
