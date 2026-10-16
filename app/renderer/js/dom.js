'use strict';

// The ONLY DOM construction path in the renderer. Everything goes through
// el(); text always lands via textContent/text nodes, never innerHTML.
// tools/lint-dom.js enforces that no injection sink appears anywhere else.

(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Apply an attrs map to an element. `className` is HTML-specific (on SVG
   * `className` is a read-only object), so SVG nodes are flagged and always
   * go through setAttribute.
   */
  function applyAttrs(node, attrs, isSvg) {
    if (!attrs) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') {
        if (isSvg) node.setAttribute('class', String(v));
        else node.className = String(v);
      } else if (k === 'text') node.textContent = String(v);
      else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2), v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }

  /**
   * @param {string} tag
   * @param {Record<string, any>|null} attrs  class/text/dataset/on<event>/attribute map
   * @param {...(Node|string|number|null|Array)} children
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    applyAttrs(node, attrs, false);
    appendAll(node, children);
    return node;
  }

  /**
   * SVG-namespaced element factory (for inline icons). Same attrs semantics as
   * el(), minus `dataset` (SVG has no dataset on older engines).
   * @param {string} tag
   * @param {Record<string, any>|null} attrs
   * @param {...(Node|string|number|null|Array)} children
   */
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs, true);
    appendAll(node, children);
    return node;
  }

  function appendAll(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? document.createTextNode(String(child))
          : child
      );
    }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const $ = (sel) => document.querySelector(sel);

  window.DM = window.DM || {};
  window.DM.dom = { el, svg, clear, appendAll, $ };
})();
