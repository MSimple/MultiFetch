'use strict';

// Shared UI kit: small factory helpers over dom.js so the views stay declarative.
// Everything is built from elements (no innerHTML) and styled by app.css classes.

(function () {
  const { el, clear } = window.DM.dom;
  const { icon } = window.DM.icons;

  /**
   * @param {{label?:string, iconName?:string, variant?:'primary'|'ghost'|'soft'|'danger', size?:'sm'|'md', title?:string, id?:string, onClick?:Function}} opts
   */
  function button(opts) {
    const o = opts || {};
    const cls = ['btn', 'btn-' + (o.variant || 'soft')];
    if (o.size === 'sm') cls.push('btn-sm');
    const node = el('button', {
      class: cls.join(' '),
      type: 'button',
      id: o.id || null,
      title: o.title || o.label || null,
      onclick: o.onClick || null,
    });
    const ic = o.iconName ? icon(o.iconName) : null;
    if (ic) node.appendChild(ic);
    if (o.label) node.appendChild(el('span', { text: o.label }));
    return node;
  }

  /** Icon-only action button (task row actions, token rotate, …). */
  function iconButton(opts) {
    const o = opts || {};
    const label = o.label || '';
    const node = el('button', {
      class: 'ibtn' + (o.danger ? ' danger' : ''),
      type: 'button',
      title: label,
      'aria-label': label,
      onclick: o.onClick
        ? async (e) => {
            e.stopPropagation();
            await o.onClick();
          }
        : null,
    });
    const ic = o.iconName ? icon(o.iconName) : null;
    node.appendChild(ic || el('span', { text: label }));
    return node;
  }

  /**
   * Styled switch. Returns the <label>; the inner checkbox is exposed as
   * `node.input` so callers can read `.checked`.
   */
  function toggle(opts) {
    const o = opts || {};
    const input = el('input', { type: 'checkbox', id: o.id || null, onchange: o.onChange || null });
    input.checked = !!o.checked;
    const track = el('span', { class: 'switch-track' }, el('i', { class: 'switch-knob' }));
    const node = el('label', { class: 'switch' }, input, track);
    node.input = input;
    return node;
  }

  /**
   * A settings row: label + description on the left, a control on the right.
   * @param {{label:string, desc?:string, control:Node, wide?:boolean, column?:boolean}} opts
   */
  function row(opts) {
    const o = opts || {};
    const main = el(
      'div',
      { class: 'row-main' },
      el('div', { class: 'row-label', text: o.label }),
      o.desc ? el('div', { class: 'row-desc', text: o.desc }) : null
    );
    const control = el('div', { class: 'row-control' + (o.wide ? ' wide' : '') }, o.control);
    return el('div', { class: 'row' + (o.column ? ' column' : '') }, main, control);
  }

  /** A titled glass card. `children` may include Nodes. */
  function section(title, children) {
    const kids = (Array.isArray(children) ? children : [children]).flat(Infinity);
    return el(
      'div',
      { class: 'card' },
      title ? el('div', { class: 'card-head' }, el('h2', { class: 'card-title', text: title })) : null,
      el('div', { class: 'section-rows' }, ...kids)
    );
  }

  // ---- toasts ----

  function toastRoot() {
    let root = document.getElementById('toasts');
    if (!root) {
      root = el('div', { id: 'toasts', class: 'toasts' });
      document.body.appendChild(root);
    }
    return root;
  }

  /**
   * @param {string} message
   * @param {'info'|'ok'|'err'} [type]
   * @param {number} [duration] ms
   */
  function toast(message, type, duration) {
    const node = el('div', { class: 'toast ' + (type || 'info'), text: message });
    toastRoot().appendChild(node);
    const ttl = duration || 2600;
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 240);
    }, ttl);
    return node;
  }

  // ---- modal ----

  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  /** Keep Tab focus cycling inside `container`. Returns a release fn. */
  function focusTrap(container) {
    function onKey(e) {
      if (e.key !== 'Tab') return;
      const items = [...container.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    container.addEventListener('keydown', onKey);
    return () => container.removeEventListener('keydown', onKey);
  }

  /**
   * Present `box` in a backdrop. Closes on Escape, backdrop click, or close().
   * Traps focus and restores it to the previously focused element.
   * @param {HTMLElement} box
   * @param {{ initialFocus?: HTMLElement, onClose?: () => void }} [opts]
   * @returns {{ close: () => void, backdrop: HTMLElement }}
   */
  function modal(box, opts) {
    const o = opts || {};
    const previouslyFocused = document.activeElement;
    const backdrop = el(
      'div',
      {
        class: 'modal-backdrop',
        onclick: (e) => {
          if (e.target === backdrop) close();
        },
      },
      box
    );
    const release = focusTrap(box);
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      release();
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
      if (typeof o.onClose === 'function') o.onClose();
    }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    (o.initialFocus || box.querySelector(FOCUSABLE) || box).focus?.();
    return { close, backdrop };
  }

  // ---- select (custom dropdown; native <select> popups are unreadable in dark) ----

  /**
   * @param {{ id?:string, className?:string, options:Array<{value:string,label:string}>, value?:string, onChange?:(v:string)=>void }} opts
   */
  function select(opts) {
    const o = opts || {};
    let options = o.options || [];
    let value = o.value;
    let open = false;
    let elevated = null;
    let active = Math.max(0, options.findIndex((x) => x.value === value));

    const labelEl = el('span', { class: 'sel-label' });
    const btn = el(
      'button',
      { class: 'sel-btn', type: 'button', id: o.id || null, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
      labelEl,
      icon('chevron')
    );
    const list = el('div', { class: 'sel-list', role: 'listbox' });
    const root = el('div', { class: 'sel' + (o.className ? ' ' + o.className : '') }, btn, list);

    function renderLabel() {
      const cur = options.find((x) => x.value === value);
      labelEl.textContent = cur ? cur.label : '';
    }
    function setActive(i) {
      active = i;
      [...list.children].forEach((n, idx) => n.classList.toggle('is-active', idx === i));
    }
    function renderList() {
      clear(list);
      options.forEach((op, i) => {
        list.appendChild(
          el(
            'div',
            {
              class: 'sel-opt' + (op.value === value ? ' is-selected' : '') + (i === active ? ' is-active' : ''),
              role: 'option',
              'aria-selected': String(op.value === value),
              onclick: () => pick(op.value),
              onmousemove: () => setActive(i),
            },
            el('span', { text: op.label })
          )
        );
      });
    }
    function pick(v) {
      value = v;
      renderLabel();
      close();
      if (o.onChange) o.onChange(v);
    }
    function openMenu() {
      if (open) return;
      open = true;
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      // Lift the enclosing glass card above the sticky bars: backdrop-filter
      // makes each card a stacking context, so a child z-index cannot escape it.
      elevated = root.closest('.card');
      if (elevated) elevated.classList.add('is-elevated');
      renderList();
      setActive(Math.max(0, options.findIndex((x) => x.value === value)));
      document.addEventListener('mousedown', onDocDown, true);
    }
    function close() {
      if (!open) return;
      open = false;
      root.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (elevated) {
        elevated.classList.remove('is-elevated');
        elevated = null;
      }
      document.removeEventListener('mousedown', onDocDown, true);
    }
    function onDocDown(e) {
      if (!root.contains(e.target)) close();
    }
    btn.addEventListener('click', () => (open ? close() : openMenu()));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) openMenu();
        else setActive(Math.min(options.length - 1, Math.max(0, active + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!open) openMenu();
        else if (options[active]) pick(options[active].value);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    });
    renderLabel();

    return {
      el: root,
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        renderLabel();
      },
      setOptions(next, v) {
        options = next || [];
        if (v !== undefined) value = v;
        renderLabel();
        if (open) renderList();
      },
      close,
    };
  }

  window.DM = window.DM || {};
  window.DM.ui = { button, iconButton, toggle, row, section, toast, modal, focusTrap, select, clear };
})();
