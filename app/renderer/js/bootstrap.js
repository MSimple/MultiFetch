'use strict';

// Renderer bootstrap: init i18n, localize static labels, mount views, wire nav.
// applyLocale() is re-runnable so the settings view can switch languages live
// (no restart): it re-inits strings, re-fills static labels and remounts both
// views — every mount is idempotent (tasks re-subscribes with an unsubscribe).

(async function () {
  const { $ } = window.DM.dom;

  let locale = 'zh-CN';
  const s = await window.dm.settings.get();
  if (s.ok && s.data && s.data.locale) locale = s.data.locale;

  const navTasks = $('#nav-tasks');
  const navSettings = $('#nav-settings');
  const viewTasks = $('#tasks-view');
  const viewSettings = $('#settings-view');
  let current = 'tasks';

  function show(which) {
    current = which;
    const tasksActive = which === 'tasks';
    viewTasks.hidden = !tasksActive;
    viewSettings.hidden = tasksActive;
    navTasks.classList.toggle('is-active', tasksActive);
    navSettings.classList.toggle('is-active', !tasksActive);
  }

  async function applyLocale(next) {
    await window.DM.i18n.init(next || undefined);
    document.title = window.DM.i18n.t('app.title');
    window.DM.i18n.fillStatic(document);
    window.DM.views.tasks.mount(viewTasks);
    window.DM.views.settings.mount(viewSettings);
    show(current);
  }

  window.DM.app = { applyLocale, show };

  await applyLocale(locale);
  navTasks.addEventListener('click', () => show('tasks'));
  navSettings.addEventListener('click', () => show('settings'));
})();
