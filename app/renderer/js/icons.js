'use strict';

// Inline SVG icon set. Built through the namespaced `svg()` helper in dom.js
// (CSP-safe: no innerHTML, no external assets). Every icon is 24x24, inherits
// currentColor, and is purely decorative — the owning button carries the
// accessible label.

(function () {
  const { svg } = window.DM.dom;

  const ICONS = {
    pause: { fill: true, paths: ['M7 5h4v14H7z', 'M13 5h4v14h-4z'] },
    resume: { fill: true, paths: ['M8 5l11 7-11 7z'] },
    cancel: { paths: ['M6 6l12 12', 'M18 6L6 18'] },
    open: {
      paths: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
    },
    folder: { paths: ['M4 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'] },
    trash: { paths: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'] },
    add: { paths: ['M12 5v14', 'M5 12h14'] },
    chevron: { paths: ['M6 9l6 6 6-6'] },
    download: { paths: ['M12 3v11', 'M7.5 10l4.5 4.5 4.5-4.5', 'M4 20h16'] },
    link: {
      paths: [
        'M10.5 13.5a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 0 0-5.66-5.66l-1.2 1.2',
        'M13.5 10.5a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 0 0 5.66 5.66l1.2-1.2',
      ],
    },
    key: {
      paths: ['M14.5 7.5a4 4 0 1 1-5.3 5.3L4 18v2h2v-2h2v-2h1.2', 'M15 7l5 5'],
    },
    refresh: { paths: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4v4.2h-4.2'] },
    check: { paths: ['M5 12.5l4.5 4.5L19 7'] },
    shield: {
      paths: ['M12 3.5l6.5 2.6v5.4c0 4.2-2.8 7-6.5 8.5-3.7-1.5-6.5-4.3-6.5-8.5V6.1z', 'M9.2 12l2 2 3.6-4'],
    },
    copy: { paths: ['M8 8h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M5 15V5a1 1 0 0 1 1-1h10'] },
    alert: { paths: ['M12 4l8.5 15h-17z', 'M12 10v4', 'M12 17h.01'] },
    clock: { paths: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'] },
    settings: {
      paths: [
        'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
        'M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.5H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1A2 2 0 1 1 7 3.9l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4z',
      ],
    },
  };

  /**
   * @param {keyof typeof ICONS} name
   * @param {number} [size]
   * @returns {SVGElement|null}
   */
  function icon(name, size) {
    const def = ICONS[name];
    if (!def) return null;
    const px = String(size || 16);
    const node = svg('svg', {
      class: 'icon',
      viewBox: '0 0 24 24',
      width: px,
      height: px,
      'aria-hidden': 'true',
      focusable: 'false',
    });
    if (def.fill) {
      node.setAttribute('fill', 'currentColor');
      node.setAttribute('stroke', 'none');
    } else {
      node.setAttribute('fill', 'none');
      node.setAttribute('stroke', 'currentColor');
      node.setAttribute('stroke-width', '1.8');
      node.setAttribute('stroke-linecap', 'round');
      node.setAttribute('stroke-linejoin', 'round');
    }
    for (const d of def.paths) node.appendChild(svg('path', { d }));
    return node;
  }

  window.DM = window.DM || {};
  window.DM.icons = { icon };
})();
