import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import AppsView from './views/AppsView.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: AppsView, meta: { title: 'Apps' } },
    { path: '/system', component: () => import('./views/SystemView.vue'), meta: { title: 'System' } },
    { path: '/updates', component: () => import('./views/UpdatesView.vue'), meta: { title: 'Updates' } },
    { path: '/docker', component: () => import('./views/DockerView.vue'), meta: { title: 'Docker' } },
    { path: '/files', component: () => import('./views/FilesView.vue'), meta: { title: 'Files' } },
    { path: '/terminal', component: () => import('./views/TerminalView.vue'), meta: { title: 'Terminal' } },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});

createApp(App).use(router).mount('#app');
