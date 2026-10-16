'use strict';

// Tiny custom <select> replacement for the extension pages. Native popups
// follow the OS theme and become unreadable on a dark UI, so this renders an
// opaque panel we fully control. UMD so it also loads via <script> in pages.
//
// USAGE: const sel = DMQ.select.makeSelect({ el, options, value, onChange });
//        sel.value (get/set), sel.setOptions(next, newValue).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMQ = Object.assign(root.DMQ || {}, { select: factory() });
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function makeSelect(opts) {
    const o = opts || {};
    let options = o.options || [];
    let value = o.value;
    const root = o.el;
    root.textContent = '';
    root.classList.add('sel');
    if (o.className) root.classList.add(o.className);

    const label = document.createElement('span');
    label.className = 'sel-label';
    const caret = document.createElement('span');
    caret.className = 'sel-caret';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sel-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(label);
    btn.appendChild(caret);
    const list = document.createElement('div');
    list.className = 'sel-list';
    list.setAttribute('role', 'listbox');
    root.appendChild(btn);
    root.appendChild(list);

    let open = false;
    function syncLabel() {
      const cur = options.find((x) => x.value === value);
      label.textContent = cur ? cur.label : '';
    }
    function renderList() {
      list.textContent = '';
      for (const op of options) {
        const d = document.createElement('div');
        d.className = 'sel-opt' + (op.value === value ? ' is-selected' : '');
        d.setAttribute('role', 'option');
        d.setAttribute('aria-selected', String(op.value === value));
        const nm = document.createElement('span');
        nm.className = 'sel-opt-label';
        nm.textContent = op.label;
        d.appendChild(nm);
        if (typeof op.count === 'number') {
          const c = document.createElement('span');
          c.className = 'sel-count';
          c.textContent = String(op.count);
          d.appendChild(c);
        }
        d.addEventListener('click', () => {
          value = op.value;
          syncLabel();
          close();
          if (o.onChange) o.onChange(value);
        });
        list.appendChild(d);
      }
    }
    const docDown = (e) => {
      if (!root.contains(e.target)) close();
    };
    function openMenu() {
      if (open) return;
      open = true;
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      renderList();
      document.addEventListener('mousedown', docDown, true);
    }
    function close() {
      if (!open) return;
      open = false;
      root.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', docDown, true);
    }
    btn.addEventListener('click', () => (open ? close() : openMenu()));
    syncLabel();

    return {
      el: root,
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        syncLabel();
      },
      setOptions(next, v) {
        options = next || [];
        if (v !== undefined) value = v;
        syncLabel();
        if (open) renderList();
      },
    };
  }

  return { makeSelect };
});
