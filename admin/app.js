/*
 * app.js  -  Panel de administración MANIAWORLD (Supabase)
 * Vanilla JS, sin dependencias. Usa window.GigaSB (assets/js/sb.js).
 */
(function () {
  'use strict';

  var SB = window.GigaSB;
  var S = { user: null, me: null, tab: 'dashboard', cache: {} };

  /* =========================================================
   *  Utilidades DOM
   * ========================================================= */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function toast(msg, type, actionLabel, onAction) {
    var t = el('div', { class: 'toast ' + (type || '') });
    t.appendChild(el('span', { class: 'toast-msg' }, esc(msg)));
    if (actionLabel) {
      var a = el('button', { class: 'toast-action', type: 'button' }, esc(actionLabel));
      a.addEventListener('click', function () { t.remove(); onAction && onAction(); });
      t.appendChild(a);
    }
    $('#toast').appendChild(t);
    var life = actionLabel ? 6500 : 3000;
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; }, life - 350);
    setTimeout(function () { t.remove(); }, life);
    return t;
  }
  function money(n) { return '$' + (Number(n) || 0).toFixed(2); }

  function skeleton(rows) {
    var out = '';
    for (var i = 0; i < (rows || 4); i++) {
      out += '<div class="sk-row"><span class="sk sk-thumb"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>';
    }
    return '<div class="skeleton">' + out + '</div>';
  }
  function emptyState(title, sub, ctaLabel, ctaId, icon) {
    return '<div class="card empty">' +
      (icon ? '<div class="empty-ico">' + icon + '</div>' : '') +
      '<div class="empty-title">' + esc(title) + '</div>' +
      (sub ? '<p class="muted">' + esc(sub) + '</p>' : '') +
      (ctaLabel ? '<button class="btn primary" ' + (ctaId ? 'id="' + ctaId + '"' : '') + '>+ ' + esc(ctaLabel) + '</button>' : '') +
      '</div>';
  }

  // Registro de actividad (tabla privada activity_log, aislada por tienda).
  function logActivity(text) {
    if (!S.me) return Promise.resolve();
    return SB.insert('activity_log', {
      store_id: sid(),
      user_id: (S.me && S.me.id) || (S.user && S.user.id) || null,
      text: String(text || '').slice(0, 500)
    }).catch(function () {});
  }

  // Borrado con deshacer: recuerda la fila y la reinserta si el usuario pulsa "Deshacer".
  function removeWithUndo(table, row, opts) {
    opts = opts || {};
    return SB.remove(table, { id: 'eq.' + row.id }).then(function () {
      invalidate();
      if (opts.after) opts.after();
      toast(opts.label || 'Elemento eliminado', 'ok', 'Deshacer', function () {
        var copy = JSON.parse(JSON.stringify(row));
        SB.insert(table, copy).then(function () {
          invalidate();
          if (opts.after) opts.after();
          toast('Restaurado', 'ok');
        }).catch(function (e) { toast('No se pudo restaurar: ' + e.message, 'err'); });
      });
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  /* =========================================================
   *  Modal genérico
   * ========================================================= */
  function openModal(opts) {
    closeModal();
    var root = $('#modalRoot');
    var ov = el('div', { class: 'overlay' });
    var modal = el('div', { class: 'modal' });
    var head = el('header', null,
      '<h3>' + esc(opts.title || '') + '</h3>' +
      '<button class="btn ghost sm" data-x>✕</button>');
    var body = el('div', { class: 'body' }, opts.body || '');
    var foot = el('footer');
    (opts.buttons || []).forEach(function (b) {
      foot.appendChild(el('button', { class: 'btn ' + (b.class || '') }, esc(b.label)));
      foot.lastChild.addEventListener('click', function () { b.onClick && b.onClick(); });
    });
    if (!opts.buttons || !opts.buttons.length) {
      var cancel = el('button', { class: 'btn' }, 'Cerrar');
      cancel.addEventListener('click', closeModal);
      foot.appendChild(cancel);
    }
    modal.appendChild(head); modal.appendChild(body); modal.appendChild(foot);
    ov.appendChild(modal);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(); });
    head.querySelector('[data-x]').addEventListener('click', closeModal);
    root.appendChild(ov);
    opts.onMount && opts.onMount(body, modal);
    return { body: body, close: closeModal };
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function confirmDialog(msg, onYes, opts) {
    opts = opts || {};
    openModal({
      title: opts.title || 'Confirmar',
      body: '<p>' + esc(msg) + '</p>',
      buttons: [
        { label: opts.cancelLabel || 'Cancelar', onClick: closeModal },
        { label: opts.dangerLabel || 'Eliminar', class: opts.dangerClass || 'danger', onClick: function () { closeModal(); onYes(); } }
      ]
    });
  }

  /* =========================================================
   *  API + caché  (todo acotado a la tienda del admin)
   * ========================================================= */
  var TENANT = ['settings', 'categories', 'subcategories', 'products', 'combo_items',
    'nav_groups', 'nav_items', 'builder_slots', 'builder_parts', 'themes', 'orders', 'admins', 'activity_log'];
  function sid() { return (S.me && S.me.store_id) || 1; }
  function scope(table, params) {
    if (TENANT.indexOf(table) === -1) return params;
    var p = params || {};
    p.store_id = 'eq.' + sid();
    return p;
  }
  function load(key, params) {
    return SB.get(key, scope(key, params)).then(function (rows) { S.cache[key] = rows; return rows; });
  }
  function invalidate() { S.cache = {}; }

  /* =========================================================
   *  Definición de entidades CRUD simples
   * ========================================================= */
  var ENTITIES = {
    categories: {
      title: 'Categorías', order: 'position.asc,id.asc',
      cols: [
        { k: 'name', l: 'Nombre' },
        { k: 'slug', l: 'Slug' },
        { k: 'color', l: 'Color', r: function (v) { return '<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;border:1px solid #e5e7eb;background:' + esc(v || '#7c3aed') + '"></span>' + esc(v || '') + '</span>'; } },
        { k: 'position', l: 'Pos' },
        { k: 'hidden', l: 'Oculto', r: boolTag }
      ],
      fields: [
        { k: 'name', l: 'Nombre', req: true },
        { k: 'slug', l: 'Slug (URL)' },
        { k: 'color', l: 'Color', t: 'color' },
        { k: 'icon', l: 'Icono SVG (opcional)' },
        { k: 'image', l: 'Imagen', t: 'image' },
        { k: 'position', l: 'Posición', t: 'number' },
        { k: 'hidden', l: 'Oculto', t: 'bool' }
      ]
    },
    subcategories: {
      title: 'Subcategorías', order: 'position.asc,id.asc',
      cols: [
        { k: 'name', l: 'Nombre' },
        { k: 'category_id', l: 'Categoría', r: function (v) { return esc(refName('categories', v)); } },
        { k: 'position', l: 'Pos' },
        { k: 'hidden', l: 'Oculto', r: boolTag }
      ],
      fields: [
        { k: 'category_id', l: 'Categoría', t: 'ref', ref: 'categories', req: true },
        { k: 'name', l: 'Nombre', req: true },
        { k: 'position', l: 'Posición', t: 'number' },
        { k: 'hidden', l: 'Oculto', t: 'bool' }
      ]
    },
    nav_groups: {
      title: 'Grupos de navegación', order: 'position.asc,id.asc',
      cols: [
        { k: 'name', l: 'Nombre' },
        { k: 'position', l: 'Pos' },
        { k: 'hidden', l: 'Oculto', r: boolTag }
      ],
      fields: [
        { k: 'name', l: 'Nombre', req: true },
        { k: 'icon', l: 'Icono SVG (paths)', t: 'textarea', help: 'Se inyecta dentro de <svg>. Pega los <path .../>.' },
        { k: 'position', l: 'Posición', t: 'number' },
        { k: 'hidden', l: 'Oculto', t: 'bool' }
      ]
    },
    nav_items: {
      title: 'Ítems de navegación', order: 'position.asc,id.asc',
      cols: [
        { k: 'name', l: 'Nombre' },
        { k: 'group_id', l: 'Grupo', r: function (v) { return esc(refName('nav_groups', v)); } },
        { k: 'position', l: 'Pos' }
      ],
      fields: [
        { k: 'group_id', l: 'Grupo', t: 'ref', ref: 'nav_groups', req: true },
        { k: 'name', l: 'Nombre', req: true },
        { k: 'position', l: 'Posición', t: 'number' }
      ]
    },
    builder_slots: {
      title: 'Slots del armador', order: 'position.asc,id.asc',
      cols: [
        { k: 'key', l: 'Clave' },
        { k: 'name', l: 'Nombre' },
        { k: 'label', l: 'Etiqueta' },
        { k: 'position', l: 'Pos' }
      ],
      fields: [
        { k: 'key', l: 'Clave (case, cpu, mb, ram, gpu, psu, cooler)', req: true },
        { k: 'name', l: 'Nombre', req: true },
        { k: 'label', l: 'Etiqueta' },
        { k: 'icon', l: 'Icono' },
        { k: 'position', l: 'Posición', t: 'number' }
      ]
    },
    builder_parts: {
      title: 'Piezas del armador', order: 'slot_id.asc,position.asc,id.asc',
      cols: [
        { k: 'name', l: 'Nombre' },
        { k: 'slot_id', l: 'Slot', r: function (v) { return esc(refName('builder_slots', v)); } },
        { k: 'short', l: 'Resumen' },
        { k: 'price', l: 'Precio', r: function (v) { return money(v); } },
        { k: 'position', l: 'Pos' }
      ],
      fields: [
        { k: 'slot_id', l: 'Slot', t: 'ref', ref: 'builder_slots', req: true },
        { k: 'name', l: 'Nombre', req: true },
        { k: 'short', l: 'Resumen' },
        { k: 'price', l: 'Precio', t: 'money', req: true },
        { k: 'image', l: 'Imagen', t: 'image' },
        { k: 'position', l: 'Posición', t: 'number' }
      ]
    }
  };

  function boolTag(v) { return v ? '<span class="tag off">Sí</span>' : '<span class="tag on">No</span>'; }
  function refName(table, id) {
    var rows = S.cache[table] || [];
    var hit = rows.filter(function (r) { return String(r.id) === String(id); })[0];
    return hit ? (hit.name || hit.label || hit.key || id) : '—';
  }

  /* =========================================================
   *  Helpers de lista (búsqueda, filtros, orden, CSV)
   * ========================================================= */
  function downloadBlob(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function toCSV(rows, cols) {
    function cell(v) { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    return '\uFEFF' + cols.map(function (c) { return cell(c.l); }).join(',') + '\n' +
      rows.map(function (r) { return cols.map(function (c) { return cell(c.v(r)); }).join(','); }).join('\n');
  }
  var SEARCH_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

  function filterRows(rows, q, fields) {
    if (!q) return rows;
    q = q.toLowerCase();
    return rows.filter(function (r) {
      return fields.some(function (f) {
        var v = typeof f === 'function' ? f(r) : r[f];
        return String(v == null ? '' : v).toLowerCase().indexOf(q) !== -1;
      });
    });
  }
  function toolbarHtml(o) {
    o = o || {};
    var h = '<div class="list-toolbar">';
    if (o.search) h += '<div class="search-box">' + SEARCH_ICO + '<input type="search" id="' + o.searchId + '" placeholder="' + esc(o.placeholder || 'Buscar…') + '" autocomplete="off"></div>';
    (o.filters || []).forEach(function (f) {
      h += '<select id="' + f.id + '" class="filter-select">' + f.options.map(function (x) {
        return '<option value="' + esc(x[0]) + '">' + esc(x[1]) + '</option>';
      }).join('') + '</select>';
    });
    h += '<span class="toolbar-spacer"></span>';
    (o.buttons || []).forEach(function (b) {
      h += '<button class="btn ' + (b.class || '') + '"' + (b.id ? ' id="' + b.id + '"' : '') + '>' + esc(b.label) + '</button>';
    });
    h += '</div>';
    if (o.countId) h += '<div class="list-count" id="' + o.countId + '">' + (o.countText || '') + '</div>';
    return h;
  }

  // Ordenar filas de una tabla arrastrando (drag & drop). Llama onReorder con la lista de ids.
  function enableRowSort(tbody, onReorder) {
    if (!tbody) return;
    var dragEl = null;
    function rows() { return $all('tr[data-id]', tbody); }
    rows().forEach(function (tr) {
      tr.draggable = true;
      tr.classList.add('sortable-row');
      tr.addEventListener('dragstart', function (e) {
        dragEl = tr; tr.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', tr.dataset.id); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      });
      tr.addEventListener('dragend', function () { tr.classList.remove('dragging'); dragEl = null; });
      tr.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
      tr.addEventListener('drop', function (e) {
        e.preventDefault();
        if (!dragEl || dragEl === tr) return;
        var list = rows();
        if (list.indexOf(dragEl) < list.indexOf(tr)) tbody.insertBefore(dragEl, tr.nextSibling);
        else tbody.insertBefore(dragEl, tr);
        dragEl.classList.remove('dragging');
        onReorder($all('tr[data-id]', tbody).map(function (r) { return r.dataset.id; }));
      });
    });
  }
  // Persiste el nuevo orden de position para una lista de ids.
  function saveOrder(table, ids) {
    return Promise.all(ids.map(function (id, i) {
      return SB.update(table, { id: 'eq.' + id }, { position: i });
    })).then(function () { invalidate(); toast('Orden guardado', 'ok'); })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  /* =========================================================
   *  Formularios
   * ========================================================= */
  function fieldHtml(f, val) {
    val = val == null ? '' : val;
    var id = 'f_' + f.k;
    var h = '<div class="field" data-field="' + f.k + '"><label for="' + id + '">' + esc(f.l) +
      (f.req ? ' *' : '') + '</label>';
    if (f.t === 'bool') {
      h += '<div class="check"><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (val ? ' checked' : '') + '><span>Activado</span></div>';
    } else if (f.t === 'textarea') {
      h += '<textarea id="' + id + '" data-k="' + f.k + '">' + esc(val) + '</textarea>';
    } else if (f.t === 'color') {
      h += '<div style="display:flex;gap:10px;align-items:center"><input type="color" id="' + id + '" data-k="' + f.k + '" value="' + esc(val || '#7c3aed') + '"><input type="text" data-for="' + f.k + '" value="' + esc(val) + '"></div>';
    } else if (f.t === 'image') {
      h += '<div class="img-drop" data-drop="' + f.k + '">' +
        '<img class="thumb" data-prev="' + f.k + '" src="' + esc(SB.resolveImage(val, 96)) + '" style="width:56px;height:56px' + (val ? '' : ';visibility:hidden') + '">' +
        '<input type="hidden" data-k="' + f.k + '" value="' + esc(val) + '">' +
        '<div class="img-drop-info"><input type="file" accept="image/*" data-upload="' + f.k + '"><span class="help">Arrastra una imagen aquí o elige un archivo</span></div>' +
        '<button type="button" class="btn sm ghost" data-clear="' + f.k + '">Quitar</button></div>';
    } else if (f.t === 'gallery') {
      var gval = Array.isArray(val) ? val.join('\n') : (val || '');
      h += '<div class="gallery-field">' +
        '<div class="gallery-chips" data-chips="' + f.k + '"></div>' +
        '<textarea id="' + id + '" data-k="' + f.k + '" data-gallery-ta="' + f.k + '" rows="2" placeholder="Una ruta/URL por linea">' + esc(gval) + '</textarea>' +
        '<div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input type="file" accept="image/*" multiple data-gallery-add="' + f.k + '"><span class="help">Arrastra las miniaturas para reordenar. Sube archivos para añadir.</span></div>' +
        '</div>';
    } else if (f.t === 'ref') {
      var opts = '<option value="">— elegir —</option>';
      (S.cache[f.ref] || []).forEach(function (r) {
        opts += '<option value="' + esc(r.id) + '"' + (String(r.id) === String(val) ? ' selected' : '') + '>' + esc(r.name || r.label || r.key) + '</option>';
      });
      h += '<select id="' + id + '" data-k="' + f.k + '" data-ref="' + f.ref + '"' + (f.req ? ' required' : '') + '>' + opts + '</select>';
    } else if (f.t === 'money') {
      h += '<input type="text" inputmode="decimal" class="money-input" id="' + id + '" data-k="' + f.k + '"' +
        ' value="' + esc(val) + '"' + (f.req ? ' required' : '') + ' data-type="money">';
    } else {
      h += '<input type="' + (f.t === 'number' ? 'number' : 'text') + '" id="' + id + '" data-k="' + f.k + '"' +
        (f.t === 'number' ? ' step="any"' : '') + ' value="' + esc(val) + '"' + (f.req ? ' required' : '') +
        ' data-type="' + (f.t || 'text') + '">';
    }
    if (f.help) h += '<div class="help">' + esc(f.help) + '</div>';
    return h + '</div>';
  }

  function renderForm(fields, values) {
    return fields.map(function (f) { return fieldHtml(f, values ? values[f.k] : ''); }).join('');
  }

  function readForm(fields, root) {
    var out = {};
    fields.forEach(function (f) {
      var node = root.querySelector('[data-k="' + f.k + '"]');
      if (!node) return;
      if (f.t === 'bool') out[f.k] = node.checked;
      else if (f.t === 'number') {
        var nv = node.value === '' ? null : Number(node.value);
        out[f.k] = (nv === null && (f.req || f.k === 'position')) ? 0 : nv;
      }
      else if (f.t === 'money') {
        var raw = String(node.value).replace(',', '.').replace(/[^0-9.\-]/g, '').trim();
        var mv = raw === '' ? null : Number(raw);
        out[f.k] = (mv === null || isNaN(mv)) ? (f.req ? 0 : null) : mv;
      }
      else if (f.t === 'ref') out[f.k] = node.value === '' ? null : (/^\d+$/.test(node.value) ? Number(node.value) : node.value);
      else if (f.t === 'color') out[f.k] = root.querySelector('[data-for="' + f.k + '"]').value.trim() || node.value;
      else if (f.t === 'gallery') out[f.k] = node.value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      else out[f.k] = node.value.trim();
    });
    return out;
  }

  function wireForm(fields, root, formState) {
    // color: sincroniza picker <-> texto
    $all('[data-k]', root).forEach(function (picker) {
      if (picker.type !== 'color') return;
      var txt = root.querySelector('[data-for="' + picker.dataset.k + '"]');
      picker.addEventListener('input', function () { txt.value = picker.value; });
      txt.addEventListener('input', function () { if (/^#[0-9a-f]{6}$/i.test(txt.value)) picker.value = txt.value; });
    });
    // subida de imágenes
    function doUpload(file, k, prev) {
      formState.uploading = (formState.uploading || 0) + 1;
      toast('Subiendo imagen…');
      return SB.upload('catalog', file).then(function (url) {
        root.querySelector('input[type=hidden][data-k="' + k + '"]').value = url;
        if (prev) { prev.src = url; prev.style.visibility = ''; }
        toast('Imagen subida', 'ok');
        return url;
      }).catch(function (e) { toast('Error: ' + e.message, 'err'); })
        .then(function (r) { formState.uploading--; return r; });
    }
    $all('[data-upload]', root).forEach(function (input) {
      input.addEventListener('change', function () {
        var file = input.files[0];
        if (file) doUpload(file, input.dataset.upload, root.querySelector('[data-prev="' + input.dataset.upload + '"]'));
      });
    });
    // zona drag & drop de imagen
    $all('[data-drop]', root).forEach(function (zone) {
      var k = zone.dataset.drop;
      zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault(); zone.classList.remove('over');
        var file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) doUpload(file, k, root.querySelector('[data-prev="' + k + '"]'));
      });
    });
    $all('[data-clear]', root).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.dataset.clear;
        root.querySelector('input[type=hidden][data-k="' + k + '"]').value = '';
        var prev = root.querySelector('[data-prev="' + k + '"]');
        if (prev) { prev.removeAttribute('src'); prev.style.visibility = 'hidden'; }
      });
    });
    // galería: chips reordenables + subida múltiple
    $all('[data-gallery-add]', root).forEach(function (fileIn) {
      var k = fileIn.dataset.galleryAdd;
      var ta = root.querySelector('[data-gallery-ta="' + k + '"]');
      var chips = root.querySelector('[data-chips="' + k + '"]');
      function lines() { return ta.value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean); }
      function renderChips() {
        var arr = lines(), dragI = null;
        chips.innerHTML = arr.map(function (u, i) {
          return '<span class="chip" draggable="true" data-ci="' + i + '"><img src="' + esc(SB.resolveImage(u, 80)) + '" alt="">' +
            '<button type="button" class="chip-x" data-ci-rm="' + i + '">×</button></span>';
        }).join('');
        $all('[data-ci]', chips).forEach(function (ch) {
          ch.addEventListener('dragstart', function (e) { dragI = Number(ch.dataset.ci); ch.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', ch.dataset.ci); } catch (_) {} });
          ch.addEventListener('dragend', function () { ch.classList.remove('dragging'); });
          ch.addEventListener('dragover', function (e) { e.preventDefault(); });
          ch.addEventListener('drop', function (e) {
            e.preventDefault();
            var to = Number(ch.dataset.ci);
            if (dragI == null || dragI === to) return;
            var a = lines(); a.splice(to, 0, a.splice(dragI, 1)[0]);
            ta.value = a.join('\n'); renderChips();
          });
        });
        $all('[data-ci-rm]', chips).forEach(function (b) {
          b.addEventListener('click', function () { var a = lines(); a.splice(Number(b.dataset.ciRm), 1); ta.value = a.join('\n'); renderChips(); });
        });
      }
      ta.addEventListener('input', renderChips);
      fileIn.addEventListener('change', function () {
        var files = Array.prototype.slice.call(fileIn.files);
        if (!files.length) return;
        formState.uploading = (formState.uploading || 0) + files.length;
        toast('Subiendo ' + files.length + ' imagen(es)…');
        Promise.all(files.map(function (f) { return SB.upload('catalog', f); })).then(function (urls) {
          var a = lines(); urls.forEach(function (u) { if (u) a.push(u); });
          ta.value = a.join('\n'); renderChips(); toast('Imágenes añadidas', 'ok');
        }).catch(function (e) { toast(e.message, 'err'); })
          .then(function () { formState.uploading -= files.length; });
      });
      renderChips();
    });
    // filtro dependiente: subcategory_id según category_id
    var catSel = root.querySelector('[data-k="category_id"][data-ref="categories"]');
    var subSel = root.querySelector('[data-k="subcategory_id"][data-ref="subcategories"]');
    if (catSel && subSel) {
      var applySubFilter = function () {
        var cid = catSel.value;
        var cur = subSel.value;
        var rows = (S.cache.subcategories || []).filter(function (s) { return !cid || String(s.category_id) === String(cid); });
        subSel.innerHTML = '<option value="">— elegir —</option>' + rows.map(function (s) {
          return '<option value="' + esc(s.id) + '"' + (String(s.id) === String(cur) ? ' selected' : '') + '>' + esc(s.name) + '</option>';
        }).join('');
      };
      catSel.addEventListener('change', applySubFilter);
      applySubFilter();
    }
  }

  /* =========================================================
   *  Lista CRUD genérica
   * ========================================================= */
  function renderEntityList(key, mount) {
    var ent = ENTITIES[key];
    mount.innerHTML = skeleton(4);
    var deps = ent.fields.filter(function (f) { return f.t === 'ref'; }).map(function (f) { return f.ref; });
    var uniq = deps.filter(function (d, i) { return deps.indexOf(d) === i; });
    var sortable = ent.fields.some(function (f) { return f.k === 'position'; });
    Promise.all(uniq.map(function (t) { return S.cache[t] ? null : load(t, { select: '*', order: 'position.asc,id.asc' }); }))
      .then(function () { return load(key, { select: '*', order: ent.order }); })
      .then(function (rows) {
        var state = { q: '' };
        draw();

        function searchFields() {
          return ent.cols.map(function (c) { return function (r) { return r[c.k]; }; })
            .concat([function (r) { return r.name; }]);
        }
        function labelOf(r) { return r && (r.name || r.label || r.key || r.slug); }

        function draw() {
          var html = toolbarHtml({
            search: true, searchId: 'entQ', placeholder: 'Buscar ' + ent.title.toLowerCase() + '…',
            countId: 'entCount',
            buttons: [
              { label: 'Exportar CSV', id: 'csvBtn', class: 'ghost' },
              { label: '+ Nuevo', id: 'newBtn', class: 'primary' }
            ]
          }) + '<div id="entBody"></div>';
          mount.innerHTML = html;
          renderBody();
          $('#entQ', mount).addEventListener('input', function () { state.q = this.value; renderBody(); });
          $('#newBtn', mount).addEventListener('click', function () { openEditor(null); });
          $('#csvBtn', mount).addEventListener('click', exportCsv);
        }

        function renderBody() {
          var body = $('#entBody', mount);
          var view = filterRows(rows, state.q, searchFields());
          $('#entCount', mount).textContent = view.length + ' de ' + rows.length + ' registro(s)';
          if (!rows.length) {
            body.innerHTML = emptyState('Sin ' + ent.title.toLowerCase() + ' todavía', 'Crea el primer registro para empezar.', 'Nuevo', 'emptyNew');
            var eb = $('#emptyNew', body); if (eb) eb.addEventListener('click', function () { openEditor(null); });
            return;
          }
          if (!view.length) { body.innerHTML = '<div class="card empty">Nada coincide con «' + esc(state.q) + '».</div>'; return; }
          body.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table class="responsive' + (sortable ? ' sortable' : '') + '"><thead><tr>' +
            (sortable ? '<th class="drag-h"></th>' : '') +
            ent.cols.map(function (c) { return '<th>' + esc(c.l) + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
            view.map(function (r) {
              return '<tr data-id="' + esc(r.id) + '">' +
                (sortable ? '<td class="drag-cell" data-label=""><span class="drag-handle" title="Arrastrar para ordenar">⠿</span></td>' : '') +
                ent.cols.map(function (c) {
                  var v = r[c.k];
                  return '<td data-label="' + esc(c.l) + '">' + (c.r ? c.r(v, r) : esc(v == null ? '' : v)) + '</td>';
                }).join('') +
                '<td data-label=""><div class="list-actions"><button class="btn sm" data-edit="' + esc(r.id) + '">Editar</button>' +
                '<button class="btn sm danger" data-del="' + esc(r.id) + '">Borrar</button></div></td></tr>';
            }).join('') + '</tbody></table></div>';

          body.onclick = function (e) {
            var ed = e.target.closest('[data-edit]');
            if (ed) { openEditor(rows.filter(function (r) { return String(r.id) === ed.dataset.edit; })[0]); return; }
            var de = e.target.closest('[data-del]');
            if (de) doDelete(de.dataset.del);
          };
          if (sortable) enableRowSort($('tbody', body), function (ids) {
            saveOrder(key, ids); logActivity('Reordenó ' + ent.title.toLowerCase());
          });
        }

        function reload() { return load(key, { select: '*', order: ent.order }).then(function (r2) { rows = r2; renderBody(); }); }

        function doDelete(id) {
          var row = rows.filter(function (r) { return String(r.id) === id; })[0];
          confirmDialog('¿Eliminar «' + (labelOf(row) || 'este registro') + '»?', function () {
            removeWithUndo(key, row, { label: 'Registro eliminado', after: reload });
            logActivity('Eliminó ' + ent.title.toLowerCase() + ': ' + (labelOf(row) || id));
          });
        }

        function exportCsv() {
          var cols = ent.cols.map(function (c) {
            return { l: c.l, v: function (r) { return c.r ? String(c.r(r[c.k], r)).replace(/<[^>]+>/g, '') : r[c.k]; } };
          });
          downloadBlob(key + '-' + Date.now() + '.csv', toCSV(rows, cols), 'text/csv;charset=utf-8');
        }

        function openEditor(row) {
          var formState = {};
          var m = openModal({
            title: (row ? 'Editar ' : 'Nuevo ') + ent.title.toLowerCase(),
            body: '<form id="entForm">' + renderForm(ent.fields, row || { position: rows.length }) + '</form>',
            buttons: [
              { label: 'Cancelar', onClick: closeModal },
              { label: 'Guardar', class: 'primary', onClick: save }
            ]
          });
          wireForm(ent.fields, m.body, formState);

          function save() {
            if (formState.uploading) return toast('Espera: subiendo imagen…', 'err');
            var form = $('#entForm', m.body);
            if (!form.reportValidity()) return;
            var data = readForm(ent.fields, m.body);
            if (!row) data.store_id = sid();
            var p = row ? SB.update(key, { id: 'eq.' + row.id }, data) : SB.insert(key, data);
            p.then(function () {
              closeModal(); invalidate(); toast('Guardado', 'ok');
              logActivity((row ? 'Editó ' : 'Creó ') + ent.title.toLowerCase() + ': ' + (data[ent.cols[0].k] || ''));
              reload();
            }).catch(function (e) { toast(e.message, 'err'); });
          }
        }
      }).catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });
  }

  /* =========================================================
   *  Productos (type = product)
   * ========================================================= */
  var PRODUCT_FIELDS = [
    { k: 'name', l: 'Nombre', req: true },
    { k: 'sub', l: 'Subtítulo (tarjeta)' },
    { k: 'price', l: 'Precio', t: 'money', req: true },
    { k: 'original_price', l: 'Precio anterior (oferta)', t: 'money' },
    { k: 'badge', l: 'Etiqueta (Top Ventas / Destacado / Nuevo / Oferta / Popular)' },
    { k: 'category_id', l: 'Categoría', t: 'ref', ref: 'categories' },
    { k: 'subcategory_id', l: 'Subcategoría', t: 'ref', ref: 'subcategories' },
    { k: 'image', l: 'Imagen', t: 'image' },
    { k: 'images', l: 'Galería (una imagen por línea)', t: 'gallery' },
    { k: 'description', l: 'Descripción', t: 'textarea' },
    { k: 'featured', l: 'Destacado', t: 'bool' },
    { k: 'hidden', l: 'Oculto', t: 'bool' },
    { k: 'position', l: 'Posición', t: 'number' }
  ];

  function renderProducts(mount) {
    renderTyped('product', PRODUCT_FIELDS, 'Productos', mount);
  }
  function renderCombos(mount) {
    renderTyped('combo', COMBO_FIELDS, 'Combos', mount, true);
  }

  var COMBO_FIELDS = [
    { k: 'name', l: 'Nombre', req: true },
    { k: 'sub', l: 'Subtítulo' },
    { k: 'price', l: 'Precio', t: 'money', req: true },
    { k: 'badge', l: 'Etiqueta' },
    { k: 'image', l: 'Imagen (case)', t: 'image' },
    { k: 'category_id', l: 'Categoría', t: 'ref', ref: 'categories' },
    { k: 'hidden', l: 'Oculto', t: 'bool' },
    { k: 'position', l: 'Posición', t: 'number' }
  ];

  function renderTyped(type, fields, title, mount, isCombo) {
    var noun = isCombo ? 'combo' : 'producto';
    mount.innerHTML = skeleton(5);
    Promise.all([
      S.cache.categories ? null : load('categories', { select: '*', order: 'position.asc,id.asc' }),
      S.cache.subcategories ? null : load('subcategories', { select: '*', order: 'position.asc,id.asc' })
    ]).then(function () {
      return load('products', { select: '*', type: 'eq.' + type, order: 'position.asc,id.asc' });
    }).then(function (rows) {
      var state = { q: '', cat: '', status: '', view: 'cards' };
      draw();

      function catOptions() {
        return [['', 'Todas las categorías']].concat((S.cache.categories || []).map(function (c) { return [String(c.id), c.name]; }));
      }
      function searchFields() {
        return ['name', 'sub', 'badge', function (r) { return refName('categories', r.category_id); }];
      }
      function visibleRows() {
        var v = filterRows(rows, state.q, searchFields());
        if (state.cat) v = v.filter(function (r) { return String(r.category_id) === state.cat; });
        if (state.status) v = v.filter(function (r) { return state.status === 'hidden' ? !!r.hidden : !r.hidden; });
        return v;
      }

      function draw() {
        var html = toolbarHtml({
          search: true, searchId: 'pQ', placeholder: 'Buscar ' + esc(title.toLowerCase()) + '…',
          filters: [
            { id: 'pCat', options: catOptions() },
            { id: 'pStatus', options: [['', 'Todos los estados'], ['visible', 'Visibles'], ['hidden', 'Ocultos']] }
          ],
          countId: 'pCount',
          buttons: [
            { label: state.view === 'cards' ? 'Ver lista' : 'Ver tarjetas', id: 'viewBtn', class: 'ghost' },
            { label: 'Exportar CSV', id: 'csvBtn', class: 'ghost' },
            { label: '+ Nuevo', id: 'newBtn', class: 'primary' }
          ]
        }) + '<div id="pBody"></div>';
        mount.innerHTML = html;
        renderBody();
        $('#pQ', mount).addEventListener('input', function () { state.q = this.value; renderBody(); });
        $('#pCat', mount).addEventListener('change', function () { state.cat = this.value; renderBody(); });
        $('#pStatus', mount).addEventListener('change', function () { state.status = this.value; renderBody(); });
        $('#viewBtn', mount).addEventListener('click', function () {
          state.view = state.view === 'cards' ? 'table' : 'cards';
          this.textContent = state.view === 'cards' ? 'Ver lista' : 'Ver tarjetas';
          renderBody();
        });
        $('#newBtn', mount).addEventListener('click', function () { openEditor(null); });
        $('#csvBtn', mount).addEventListener('click', exportCsv);
      }

      function renderBody() {
        var body = $('#pBody', mount);
        var view = visibleRows();
        $('#pCount', mount).textContent = view.length + ' de ' + rows.length + ' ' + esc(title.toLowerCase());
        if (!rows.length) {
          body.innerHTML = emptyState('Sin ' + title.toLowerCase() + ' todavía', 'Añade tu primer ' + noun + ' para mostrarlo en la tienda.', 'Nuevo', 'emptyNew');
          var eb = $('#emptyNew', body); if (eb) eb.addEventListener('click', function () { openEditor(null); });
          return;
        }
        if (!view.length) { body.innerHTML = '<div class="card empty">Ningún ' + noun + ' coincide con los filtros.</div>'; return; }

        if (state.view === 'cards') {
          body.innerHTML = '<div class="pcard-grid">' + view.map(function (r) {
            var cat = refName('categories', r.category_id);
            return '<div class="pcard" data-id="' + esc(r.id) + '">' +
              '<div class="pcard-img"><img src="' + esc(SB.resolveImage(r.image, 480)) + '" alt="" loading="lazy" decoding="async">' +
                (r.badge ? '<span class="pcard-badge">' + esc(r.badge) + '</span>' : '') +
                (r.hidden ? '<span class="pcard-hidden">Oculto</span>' : '') +
              '</div>' +
              '<div class="pcard-body">' +
                '<div class="pcard-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' +
                (r.sub ? '<div class="pcard-sub">' + esc(r.sub) + '</div>' : '') +
                '<div class="pcard-meta">' +
                  '<div class="pcard-price"><span class="cur">$</span><input class="inline-price" type="text" inputmode="decimal" data-price="' + esc(r.id) + '" value="' + esc(r.price) + '"></div>' +
                  (cat ? '<span class="pcard-cat">' + esc(cat) + '</span>' : '') +
                '</div>' +
                '<div class="pcard-actions">' +
                  '<button class="btn sm" data-edit="' + esc(r.id) + '">Editar</button>' +
                  (isCombo ? '<button class="btn sm" data-items="' + esc(r.id) + '">Piezas</button>' : '') +
                  '<button class="btn sm" data-dup="' + esc(r.id) + '">Duplicar</button>' +
                  '<button class="tag ' + (r.hidden ? 'off' : 'on') + '" data-toggle="' + esc(r.id) + '">' + (r.hidden ? 'Oculto' : 'Visible') + '</button>' +
                  '<button class="btn sm danger" data-del="' + esc(r.id) + '">Borrar</button>' +
                '</div>' +
              '</div></div>';
          }).join('') + '</div>';
        } else {
          body.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table class="responsive sortable"><thead><tr><th class="drag-h"></th><th></th><th>Nombre</th><th>Precio</th>' +
            '<th>Categoría</th>' + (isCombo ? '<th>Piezas</th>' : '') + '<th>Estado</th><th></th></tr></thead><tbody>' +
            view.map(function (r) {
              return '<tr data-id="' + esc(r.id) + '">' +
                '<td class="drag-cell" data-label=""><span class="drag-handle" title="Arrastrar para ordenar">⠿</span></td>' +
                '<td data-label="Imagen"><img class="thumb" src="' + esc(SB.resolveImage(r.image, 96)) + '"></td>' +
                '<td data-label="Nombre"><strong>' + esc(r.name) + '</strong><div class="muted" style="font-size:12px">' + esc(r.sub || '') + '</div></td>' +
                '<td data-label="Precio"><input class="inline-price" type="text" inputmode="decimal" data-price="' + esc(r.id) + '" value="' + esc(r.price) + '"></td>' +
                '<td data-label="Categoría">' + esc(refName('categories', r.category_id)) + '</td>' +
                (isCombo ? '<td data-label="Piezas" class="muted">—</td>' : '') +
                '<td data-label="Estado"><button class="tag ' + (r.hidden ? 'off' : 'on') + '" data-toggle="' + esc(r.id) + '">' + (r.hidden ? 'Oculto' : 'Visible') + '</button></td>' +
                '<td data-label=""><div class="list-actions">' + (isCombo ? '<button class="btn sm" data-items="' + esc(r.id) + '">Piezas</button>' : '') +
                '<button class="btn sm" data-dup="' + esc(r.id) + '">Duplicar</button>' +
                '<button class="btn sm" data-edit="' + esc(r.id) + '">Editar</button>' +
                '<button class="btn sm danger" data-del="' + esc(r.id) + '">Borrar</button></div></td></tr>';
            }).join('') + '</tbody></table></div>';

          enableRowSort($('tbody', body), function (ids) { saveOrder('products', ids); logActivity('Reordenó ' + title.toLowerCase()); });
        }

        body.onclick = function (e) {
          var t = e.target;
          var ed = t.closest('[data-edit]'); if (ed) { openEditor(byId(ed.dataset.edit)); return; }
          var de = t.closest('[data-del]'); if (de) { doDelete(de.dataset.del); return; }
          var du = t.closest('[data-dup]'); if (du) { doDuplicate(du.dataset.dup); return; }
          var it = t.closest('[data-items]'); if (it) { openItemsEditor(it.dataset.items, reload); return; }
          var tg = t.closest('[data-toggle]'); if (tg) { toggleHidden(tg.dataset.toggle); return; }
        };
        $all('[data-price]', body).forEach(function (inp) {
          inp.addEventListener('change', function () { savePrice(inp.dataset.price, inp); });
          inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
        });
      }

      function byId(id) { return rows.filter(function (r) { return String(r.id) === String(id); })[0]; }
      function reload() { return load('products', { select: '*', type: 'eq.' + type, order: 'position.asc,id.asc' }).then(function (r2) { rows = r2; renderBody(); }); }

      function savePrice(id, inp) {
        var raw = String(inp.value).replace(',', '.').replace(/[^0-9.\-]/g, '').trim();
        var price = raw === '' ? null : Number(raw);
        if (price === null || isNaN(price)) { var cur = byId(id); inp.value = cur ? cur.price : ''; return toast('Precio no válido', 'err'); }
        SB.update('products', { id: 'eq.' + id }, { price: price }).then(function () {
          var r = byId(id); if (r) r.price = price;
          inp.value = price;
          toast('Precio actualizado', 'ok');
        }).catch(function (e) { toast(e.message, 'err'); renderBody(); });
      }
      function toggleHidden(id) {
        var r = byId(id); var hidden = !r.hidden;
        SB.update('products', { id: 'eq.' + id }, { hidden: hidden }).then(function () {
          r.hidden = hidden; toast(hidden ? 'Oculto' : 'Visible', 'ok'); renderBody();
        }).catch(function (e) { toast(e.message, 'err'); });
      }
      function doDelete(id) {
        var row = byId(id);
        confirmDialog('¿Eliminar «' + (row && row.name) + '»?', function () {
          removeWithUndo('products', row, { label: 'Eliminado', after: reload });
          logActivity('Eliminó ' + noun + ': ' + (row && row.name));
        });
      }
      function doDuplicate(id) {
        var row = byId(id);
        var copy = {}; Object.keys(row).forEach(function (k) { if (k !== 'id' && k !== 'created_at') copy[k] = row[k]; });
        copy.name = row.name + ' (copia)'; copy.position = rows.length; copy.store_id = sid();
        SB.insert('products', copy).then(function () {
          toast('Duplicado', 'ok'); logActivity('Duplicó ' + noun + ': ' + row.name); reload();
        }).catch(function (e) { toast(e.message, 'err'); });
      }
      function exportCsv() {
        var cols = [
          { l: 'ID', v: function (r) { return r.id; } },
          { l: 'Nombre', v: function (r) { return r.name; } },
          { l: 'Precio', v: function (r) { return r.price; } },
          { l: 'Categoría', v: function (r) { return refName('categories', r.category_id); } },
          { l: 'Estado', v: function (r) { return r.hidden ? 'Oculto' : 'Visible'; } }
        ];
        downloadBlob('products-' + type + '-' + Date.now() + '.csv', toCSV(rows, cols), 'text/csv;charset=utf-8');
      }

      function openEditor(row) {
        var formState = {};
        var extra = isCombo ? comboMetaHtml(row) : '';
        var m = openModal({
          title: (row ? 'Editar ' : 'Nuevo ') + noun,
          body: '<form id="entForm">' + renderForm(fields, row || { position: rows.length, price: 0 }) + extra + '</form>',
          buttons: [
            { label: 'Cancelar', onClick: closeModal },
            { label: 'Guardar', class: 'primary', onClick: save }
          ]
        });
        wireForm(fields, m.body, formState);

        function save() {
          if (formState.uploading) return toast('Espera: subiendo imagen…', 'err');
          var form = $('#entForm', m.body);
          if (!form.reportValidity()) return;
          var data = readForm(fields, m.body);
          data.type = type;
          if (isCombo) {
            data.meta = {
              cpu_line1: val(m.body, 'cpu_line1'),
              cpu_line2: val(m.body, 'cpu_line2'),
              tag: val(m.body, 'tag')
            };
            if (!data.category_id) data.category_id = null;
          }
          if (!row) data.store_id = sid();
          var p = row ? SB.update('products', { id: 'eq.' + row.id }, data) : SB.insert('products', data);
          p.then(function () {
            closeModal(); invalidate(); toast('Guardado', 'ok');
            logActivity((row ? 'Editó ' : 'Creó ') + noun + ': ' + data.name);
            reload();
          }).catch(function (e) { toast(e.message, 'err'); });
        }
      }
    }).catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });
  }

  function val(root, name) { var n = root.querySelector('[name="' + name + '"]'); return n ? n.value.trim() : ''; }
  function clampNum(v, d, lo, hi) { v = parseFloat(v); if (isNaN(v)) v = d; return Math.min(hi, Math.max(lo, v)); }
  function comboMetaHtml(row) {
    var meta = (row && row.meta) || {};
    return '<hr style="border:0;border-top:1px solid var(--border);margin:18px 0">' +
      '<p class="mt0 muted" style="font-size:12.5px">Textos del combo (líneas de CPU y etiqueta):</p>' +
      '<div class="field"><label>Línea 1 (CPU)</label><input type="text" name="cpu_line1" value="' + esc(meta.cpu_line1 || '') + '"></div>' +
      '<div class="field"><label>Línea 2</label><input type="text" name="cpu_line2" value="' + esc(meta.cpu_line2 || '') + '"></div>' +
      '<div class="field mb0"><label>Etiqueta (tag)</label><input type="text" name="tag" value="' + esc(meta.tag || '') + '"></div>';
  }
  function fillComboMeta() { /* placeholders ya renderizados por comboMetaHtml */ }

  function openItemsEditor(comboId, after) {
    var m = openModal({ title: 'Piezas del combo', body: '<div class="loading"><span class="spinner"></span> Cargando…</div>',
      buttons: [{ label: 'Cerrar', onClick: closeModal }] });
    Promise.all([
      S.cache.products ? null : load('products', { select: 'id,name,type,price', order: 'name.asc' }),
      load('combo_items', { select: '*', combo_id: 'eq.' + comboId, order: 'position.asc' })
    ]).then(function (r) {
      var links = r[1] || [];
      var prods = (S.cache.products || []).filter(function (p) { return p.type !== 'combo'; });
      draw();

      function draw() {
        var opts = prods.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' — ' + money(p.price) + '</option>'; }).join('');
        var html = '<div class="field"><label>Añadir producto real al combo</label><div style="display:flex;gap:8px">' +
          '<select id="pickProd" style="flex:1">' + opts + '</select>' +
          '<input type="number" id="pickQty" value="1" min="1" style="width:80px">' +
          '<button class="btn primary" id="addLink">Añadir</button></div></div><hr style="border:0;border-top:1px solid var(--border);margin:14px 0">';
        html += '<div id="linkList">' + (links.length ? links.map(function (l) {
          var p = prods.filter(function (x) { return String(x.id) === String(l.product_id); })[0] || { name: '(producto eliminado)' };
          return '<div class="chip" style="margin:0 6px 8px 0">' + esc(p.name) + ' × ' + l.qty +
            ' <button data-rm="' + esc(l.id) + '">✕</button></div>';
        }).join('') : '<p class="muted">Sin piezas enlazadas.</p>') + '</div>';
        m.body.innerHTML = html;

        $('#addLink', m.body).addEventListener('click', function () {
          var pid = $('#pickProd', m.body).value;
          var qty = Number($('#pickQty', m.body).value) || 1;
          if (!pid) return;
          SB.insert('combo_items', { combo_id: Number(comboId), product_id: Number(pid), qty: qty, position: links.length, store_id: sid() })
            .then(function () {
              return load('combo_items', { select: '*', combo_id: 'eq.' + comboId, order: 'position.asc' });
            }).then(function (rows) { links = rows; invalidate(); draw(); after && after(); toast('Añadido', 'ok'); })
            .catch(function (e) { toast(e.message, 'err'); });
        });
        $all('[data-rm]', m.body).forEach(function (b) {
          b.addEventListener('click', function () {
            SB.remove('combo_items', { id: 'eq.' + b.dataset.rm }).then(function () {
              links = links.filter(function (l) { return String(l.id) !== b.dataset.rm; });
              invalidate(); draw(); after && after(); toast('Quitado', 'ok');
            }).catch(function (e) { toast(e.message, 'err'); });
          });
        });
      }
    });
  }

  /* =========================================================
   *  Home / Contenido (settings.data)
   * ========================================================= */
  function getSettings() {
    return load('settings', { select: 'data' }).then(function (r) { return (r[0] && r[0].data) || {}; });
  }

  function homeDraftKey() { return 'gh_home_draft_' + sid(); }
  function readHomeDraft() {
    try { return JSON.parse(localStorage.getItem(homeDraftKey()) || 'null'); } catch (e) { return null; }
  }
  function clearHomeDraft() { try { localStorage.removeItem(homeDraftKey()); } catch (e) {} }
  function captureHomeDraft(mount) {
    var d = { set: {}, sections: [] };
    $all('[data-set]', mount).forEach(function (n) { d.set[n.dataset.set] = n.value; });
    d.st = $('#st_open', mount) ? $('#st_open', mount).checked : undefined;
    d.closed = $('#st_closed', mount) ? $('#st_closed', mount).value : '';
    d.pay = $('#payMethods', mount) ? $('#payMethods', mount).value : '';
    d.msg = $('#msgTpl', mount) ? $('#msgTpl', mount).value : '';
    d.contact = $('#contactTpl', mount) ? $('#contactTpl', mount).value : '';
    d.share = $('#shareTpl', mount) ? $('#shareTpl', mount).value : '';
    d.heroShow = $('#hero_show', mount) ? $('#hero_show', mount).checked : undefined;
    var lf = mount.querySelector('input[type=hidden][data-k="logo"]');
    d.logo = lf ? lf.value : undefined;
    d.sections = $all('[data-visible]', mount).map(function (cb, i) {
      var ps = $('[data-pos="' + i + '"]', mount);
      return { visible: cb.checked, position: ps ? Number(ps.value) || 0 : 0 };
    });
    return d;
  }
  function applyHomeDraft(mount, d) {
    Object.keys(d.set || {}).forEach(function (k) { var n = mount.querySelector('[data-set="' + k + '"]'); if (n) n.value = d.set[k]; });
    if (d.st != null && $('#st_open', mount)) $('#st_open', mount).checked = d.st;
    if (d.closed != null && $('#st_closed', mount)) $('#st_closed', mount).value = d.closed;
    if (d.pay != null && $('#payMethods', mount)) $('#payMethods', mount).value = d.pay;
    if (d.msg != null && $('#msgTpl', mount)) $('#msgTpl', mount).value = d.msg;
    if (d.contact != null && $('#contactTpl', mount)) $('#contactTpl', mount).value = d.contact;
    if (d.share != null && $('#shareTpl', mount)) $('#shareTpl', mount).value = d.share;
    if (d.heroShow != null && $('#hero_show', mount)) $('#hero_show', mount).checked = d.heroShow;
    if (d.logo != null) {
      var lf = mount.querySelector('input[type=hidden][data-k="logo"]');
      var lp = mount.querySelector('[data-prev="logo"]');
      if (lf) lf.value = d.logo;
      if (lp) { if (d.logo) { lp.src = SB.resolveImage(d.logo, 96); lp.style.visibility = ''; } else { lp.removeAttribute('src'); lp.style.visibility = 'hidden'; } }
    }
    (d.sections || []).forEach(function (sec, i) {
      var cb = mount.querySelector('[data-visible="' + i + '"]'), ps = mount.querySelector('[data-pos="' + i + '"]');
      if (cb) cb.checked = sec.visible; if (ps) ps.value = sec.position;
    });
  }

  function renderHome(mount) {
    mount.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
    getSettings().then(function (s) {
      var store = s.store || {}, hero = s.hero || {}, texts = s.texts || {}, sections = s.sections || [];
      var logo = store.logo || hero.logo || '';
      var html = '<form id="homeForm">';
      html += '<div class="card"><h3>Logo de la tienda</h3><p class="desc">Se muestra en el encabezado de todas las páginas y en la portada. Sube una imagen o pega una ruta/URL.</p>' +
        fieldHtml({ k: 'logo', l: 'Logo', t: 'image', help: 'PNG, WEBP o SVG con fondo transparente.' }, logo) +
        '<div class="check" style="margin-top:10px"><input type="checkbox" id="hero_show"' + (hero.showLogo !== false ? ' checked' : '') + '><span>Mostrar el logo en la portada</span></div></div>';
      html += '<div class="card"><h3>Tienda</h3><p class="desc">Datos generales y de contacto.</p><div class="row">' +
        fld('store.name', 'Nombre', store.name) + fld('store.whatsapp', 'WhatsApp (número)', store.whatsapp) +
        fld('store.phone', 'Teléfono', store.phone) + fld('store.email', 'Correo', store.email) +
        fld('store.hours', 'Horario', store.hours) + fld('store.address', 'Dirección', store.address) +
        fld('store.currency', 'Símbolo moneda', store.currency) +
        sel('store.currencyPosition', 'Posición moneda', [['before', 'Antes ($10)'], ['after', 'Después (10 $)']], store.currencyPosition || 'before') +
        '</div><div class="check"><input type="checkbox" id="st_open"' + (store.open !== false ? ' checked' : '') + '><span>Tienda abierta</span></div>' +
        '<div class="field"><label>Mensaje de tienda cerrada</label><input type="text" id="st_closed" value="' + esc(store.closedMessage || '') + '"></div>' +
        '</div>';

      html += '<div class="card"><h3>Portada (Hero)</h3><div class="row">' +
        fld('hero.title', 'Título', hero.title) + fld('hero.subtitle', 'Subtítulo', hero.subtitle) +
        fld('hero.buttonText', 'Texto del botón', hero.buttonText) + fld('hero.buttonLink', 'Enlace del botón', hero.buttonLink) +
        '</div></div>';

      html += '<div class="card"><h3>Textos de secciones</h3><div class="row">' +
        fld('texts.combos.badge', 'Combos · badge', texts.combos && texts.combos.badge) +
        fld('texts.combos.title', 'Combos · título', texts.combos && texts.combos.title) +
        ta('texts.combos.subtitle', 'Combos · subtítulo', texts.combos && texts.combos.subtitle) +
        fld('texts.bestSellers.badge', 'Vendidos · badge', texts.bestSellers && texts.bestSellers.badge) +
        fld('texts.bestSellers.title', 'Vendidos · título', texts.bestSellers && texts.bestSellers.title) +
        ta('texts.bestSellers.subtitle', 'Vendidos · subtítulo', texts.bestSellers && texts.bestSellers.subtitle) +
        '</div></div>';

      html += '<div class="card"><h3>Secciones del home</h3><p class="desc">Visibilidad y orden.</p>' +
        '<div id="secList">' + sections.map(function (sec, i) { return sectionRow(sec, i); }).join('') + '</div></div>';

      html += '<div class="card"><h3>Métodos de pago</h3><p class="desc">Uno por línea.</p>' +
        '<textarea id="payMethods" style="min-height:110px">' + esc((store.paymentMethods || []).join('\n')) + '</textarea></div>';

      html += '<div class="card"><h3>Plantilla de mensaje (WhatsApp) — Cotización</h3><p class="desc">Variables: {storeName} {name} {location} {paymentMethod} {items} {total}</p>' +
        '<textarea id="msgTpl" style="min-height:130px">' + esc(store.messageTemplate || '') + '</textarea></div>';

      html += '<div class="card"><h3>Plantilla de mensaje (WhatsApp) — Contacto</h3><p class="desc">Variables: {storeName} {name} {subject} {message}</p>' +
        '<textarea id="contactTpl" style="min-height:110px">' + esc(store.contactTemplate || '') + '</textarea></div>';

      html += '<div class="card"><h3>Plantilla de mensaje (WhatsApp) — Compartir producto</h3><p class="desc">Variables: {storeName} {name} {sub} {url}</p>' +
        '<textarea id="shareTpl" style="min-height:90px">' + esc(store.shareTemplate || '') + '</textarea></div>';

      html += '</form>';
      mount.innerHTML = html;

      wireForm([{ k: 'logo', t: 'image' }], mount, {});

      var va = $('#viewActions');
      if (va) {
        va.innerHTML = '';
        va.appendChild(el('span', { class: 'muted', id: 'draftNote' }));
        va.appendChild(el('button', { class: 'btn primary', id: 'saveHome' }, 'Guardar cambios'));
      }
      var saveBtn = $('#saveHome');
      var note = $('#draftNote');
      var draftTimer = null;
      var form = $('#homeForm', mount);
      form.addEventListener('input', scheduleDraft);
      form.addEventListener('change', scheduleDraft);

      var draft = readHomeDraft();
      if (draft) {
        applyHomeDraft(mount, draft);
        note.textContent = 'Borrador sin guardar';
        toast('Borrador restaurado', 'ok', 'Descartar', function () { clearHomeDraft(); renderHome(mount); });
      }

      if (saveBtn) saveBtn.addEventListener('click', function () { saveHome(s); });

      function scheduleDraft() {
        if (draftTimer) clearTimeout(draftTimer);
        draftTimer = setTimeout(function () {
          try { localStorage.setItem(homeDraftKey(), JSON.stringify(captureHomeDraft(mount))); } catch (e) {}
          note.textContent = 'Borrador sin guardar';
        }, 400);
      }
    }).catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });

    function fld(name, label, v) {
      return '<div class="field"><label>' + esc(label) + '</label><input type="text" data-set="' + name + '" value="' + esc(v == null ? '' : v) + '"></div>';
    }
    function ta(name, label, v) {
      return '<div class="field"><label>' + esc(label) + '</label><textarea data-set="' + name + '">' + esc(v == null ? '' : v) + '</textarea></div>';
    }
    function sel(name, label, opts, v) {
      return '<div class="field"><label>' + esc(label) + '</label><select data-set="' + name + '">' +
        opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(v) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>';
    }
    function sectionRow(sec, i) {
      return '<div class="spread" style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px" data-sec="' + i + '">' +
        '<div class="check"><input type="checkbox" data-visible="' + i + '"' + (sec.visible !== false ? ' checked' : '') + '><span><strong>' + esc(sec.label || sec.key) + '</strong> <span class="muted">(' + esc(sec.key) + ')</span></span></div>' +
        '<div style="display:flex;align-items:center;gap:8px"><span class="muted">Orden</span><input type="number" data-pos="' + i + '" value="' + (sec.position || 0) + '" style="width:80px"></div></div>';
    }
  }

  function saveHome(orig) {
    var root = $('#view');
    var out = JSON.parse(JSON.stringify(orig));
    var set = {};
    $all('[data-set]', root).forEach(function (n) { set[n.dataset.set] = n.value.trim(); });
    out.store = out.store || {}; out.hero = out.hero || {}; out.texts = out.texts || {};
    Object.keys(set).forEach(function (path) {
      var parts = path.split('.');
      var o = out; for (var i = 0; i < parts.length - 1; i++) { o = o[parts[i]] = o[parts[i]] || {}; }
      o[parts[parts.length - 1]] = set[path];
    });
    out.store.open = $('#st_open').checked;
    out.store.closedMessage = $('#st_closed').value.trim();
    out.store.paymentMethods = $('#payMethods').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    out.store.messageTemplate = $('#msgTpl').value;
    out.store.contactTemplate = $('#contactTpl').value;
    out.store.shareTemplate = $('#shareTpl').value;
    out.hero.showLogo = $('#hero_show').checked;
    var logoInp = root.querySelector('input[type=hidden][data-k="logo"]');
    if (logoInp) out.store.logo = logoInp.value.trim();
    (out.sections || []).forEach(function (sec, i) {
      var cb = root.querySelector('[data-visible="' + i + '"]'); var ps = root.querySelector('[data-pos="' + i + '"]');
      if (cb) sec.visible = cb.checked;
      if (ps) sec.position = Number(ps.value) || 0;
    });
    SB.upsert('settings', { store_id: sid(), data: out, updated_at: new Date().toISOString() }, 'store_id')
      .then(function () {
        invalidate(); clearHomeDraft();
        var note = $('#draftNote'); if (note) note.textContent = '';
        logActivity('Guardó configuración del home');
        toast('Configuración guardada', 'ok');
      })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  /* =========================================================
   *  Temas / Festivos
   * ========================================================= */
  var COLOR_KEYS = ['brand', 'brandDark', 'brandLight', 'accent', 'bg', 'surface', 'text', 'darkBg', 'darkSurface', 'darkText'];
  var COLOR_LABELS = {
    brand: 'Color de marca',
    brandDark: 'Marca (oscuro)',
    brandLight: 'Marca (claro)',
    accent: 'Acento',
    bg: 'Fondo de la página',
    surface: 'Fondo de tarjetas',
    text: 'Color de texto',
    darkBg: 'Fondo (modo oscuro)',
    darkSurface: 'Tarjetas (modo oscuro)',
    darkText: 'Texto (modo oscuro)'
  };

  function renderThemes(mount) {
    mount.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
    Promise.all([load('themes', { select: '*', order: 'id.asc' }), getSettings()])
      .then(function (r) { draw(r[0], r[1]); })
      .catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });

    function draw(themes, s) {
      var holiday = s.holiday || {};
      var html = '<div class="card"><h3>Modo festivo</h3><p class="desc">Cuando está activo (y dentro de las fechas), anula el tema por defecto.</p>' +
        '<div class="check"><input type="checkbox" id="h_active"' + (holiday.active ? ' checked' : '') + '><span>Activado</span></div>' +
        '<div class="row" style="margin-top:12px">' +
        sel('h_mode', 'Tema festivo', themes.map(function (t) { return [t.key, t.label]; }), holiday.mode || 'none', true) +
        fld('h_start', 'Desde', holiday.startDate, 'date') + fld('h_end', 'Hasta', holiday.endDate, 'date') + '</div>' +
        '<hr style="border:0;border-top:1px solid var(--border);margin:16px 0">' +
        '<div class="check"><input type="checkbox" id="h_banner_en"' + ((holiday.banner || {}).enabled ? ' checked' : '') + '><span>Mostrar banner</span></div>' +
        '<div class="row" style="margin-top:10px">' + fld('h_banner_text', 'Texto del banner', (holiday.banner || {}).text) + fld('h_banner_link', 'Enlace del banner', (holiday.banner || {}).link) + '</div>' +
        '<div class="spread" style="margin-top:12px"><div class="check"><input type="checkbox" id="h_snow"' + ((holiday.decorations || {}).snow ? ' checked' : '') + '><span>Nieve ❄</span></div>' +
        '<div class="check"><input type="checkbox" id="h_bats"' + ((holiday.decorations || {}).bats ? ' checked' : '') + '><span>Murciélagos 🦇</span></div></div>' +
        '<button class="btn primary" id="saveHoliday" style="margin-top:16px">Guardar festivo</button></div>';

      html += '<div class="card"><h3>Temas</h3><p class="desc">Elige el tema activo. Los colores y efectos se editan en la pestaña <strong>Apariencia</strong>.</p>' +
        '<table class="responsive"><tbody>' +
        themes.map(function (t) {
          return '<tr><td data-label="Tema"><strong>' + esc(t.label) + '</strong> <span class="muted">(' + esc(t.key) + ')</span></td>' +
            '<td data-label="Activo"><label class="check"><input type="radio" name="activeTheme" data-active="' + esc(t.id) + '"' + (t.is_active ? ' checked' : '') + '><span>Activo</span></label></td></tr>';
        }).join('') +
        '</tbody></table></div>';
      mount.innerHTML = html;

      $('#saveHoliday', mount).addEventListener('click', function () {
        s.holiday = {
          active: $('#h_active').checked,
          mode: $('#h_mode').value,
          startDate: $('#h_start').value,
          endDate: $('#h_end').value,
          banner: { enabled: $('#h_banner_en').checked, text: $('#h_banner_text').value.trim(), link: $('#h_banner_link').value.trim() },
          decorations: { snow: $('#h_snow').checked, bats: $('#h_bats').checked }
        };
        SB.upsert('settings', { store_id: sid(), data: s, updated_at: new Date().toISOString() }, 'store_id')
          .then(function () { toast('Modo festivo guardado', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
      });

      $all('[data-active]', mount).forEach(function (rad) {
        rad.addEventListener('change', function () {
          var tid = rad.dataset.active;
          Promise.all(themes.map(function (t) {
            return SB.update('themes', { id: 'eq.' + t.id }, { is_active: String(t.id) === String(tid) });
          })).then(function () { toast('Tema activo actualizado', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
        });
      });
    }
    function fld(name, label, v, type) {
      return '<div class="field"><label>' + esc(label) + '</label><input type="' + (type || 'text') + '" id="' + name + '" value="' + esc(v == null ? '' : v) + '"></div>';
    }
    function sel(name, label, opts, v, allowNone) {
      var o = allowNone ? '<option value="none">— ninguno —</option>' : '';
      o += opts.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(v) ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('');
      return '<div class="field"><label>' + esc(label) + '</label><select id="' + name + '">' + o + '</select></div>';
    }
  }

  /* =========================================================
   *  Apariencia (colores + efectos por tema)
   * ========================================================= */
  function renderApariencia(mount) {
    mount.innerHTML = '<div class="loading"><span class="spinner"></span> Cargando…</div>';
    load('themes', { select: '*', order: 'id.asc' })
      .then(draw)
      .catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });

    function draw(themes) {
      var html = '<div class="card"><h3>Colores y efectos</h3><p class="desc">Personaliza cada tema. La tienda usa el tema activo (o el festivo vigente). El botón de modo <strong>oscuro/claro</strong> de la tienda usa los colores "modo oscuro".</p>';
      themes.forEach(function (t) {
        var c = t.colors || {};
        var fx = (t.decorations || {}).fx || {};
        html += '<div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px" data-theme="' + esc(t.id) + '">' +
          '<div class="spread"><strong>' + esc(t.label) + '</strong>' + (t.is_active ? '<span class="badge" style="position:static">Activo</span>' : '') + '</div>' +
          '<div class="row" style="margin-top:10px">' + COLOR_KEYS.map(function (k) {
            return '<div class="field mb0"><label>' + esc(COLOR_LABELS[k] || k) + '</label><input type="color" data-color="' + k + '" value="' + esc(c[k] || '#7c3aed') + '"></div>';
          }).join('') + '</div>' +
          '<div class="spread" style="margin-top:12px"><strong style="font-size:13px">Partículas</strong>' +
            '<div class="row">' +
              '<label class="check mb0"><input type="checkbox" data-t-snow="' + esc(t.id) + '"' + ((t.decorations || {}).snow ? ' checked' : '') + '><span>Nieve ❄</span></label>' +
              '<label class="check mb0"><input type="checkbox" data-t-bats="' + esc(t.id) + '"' + ((t.decorations || {}).bats ? ' checked' : '') + '><span>Murciélagos 🦇</span></label>' +
            '</div></div>' +
          '<hr style="border:0;border-top:1px solid var(--border);margin:14px 0">' +
          '<strong style="font-size:13px">Efectos de tarjetas y transiciones</strong>' +
          '<div class="row" style="margin-top:8px">' +
            '<div class="field mb0"><label>Color de hover (tarjetas)</label><input type="color" data-fx-hover="' + esc(t.id) + '" value="' + esc(fx.hover || c.brand || '#7c3aed') + '"></div>' +
            '<div class="field mb0"><label>Color del núcleo (barrido)</label><input type="color" data-fx-core="' + esc(t.id) + '" value="' + esc(fx.core || '#ffffff') + '"></div>' +
            '<div class="field mb0"><label>Color del resplandor</label><input type="color" data-fx-glow-color="' + esc(t.id) + '" value="' + esc(fx.glowColor || fx.hover || c.brand || '#7c3aed') + '"></div>' +
          '</div>' +
          '<div class="row" style="margin-top:8px">' +
            '<div class="field mb0"><label>Grosor del borde (px)</label><input type="number" min="1" max="8" step="1" data-fx-ring="' + esc(t.id) + '" value="' + esc(fx.ring != null ? fx.ring : 2) + '"></div>' +
            '<div class="field mb0"><label>Velocidad del giro (s)</label><input type="number" min="0.5" max="12" step="0.1" data-fx-speed="' + esc(t.id) + '" value="' + esc(fx.speed != null ? fx.speed : 3.2) + '"></div>' +
            '<div class="field mb0"><label>Color de transición</label><input type="color" data-fx-transition-color="' + esc(t.id) + '" value="' + esc(fx.transitionColor || '#2a1b4d') + '"></div>' +
          '</div>' +
          '<div class="row" style="margin-top:10px">' +
            '<label class="check"><input type="checkbox" data-fx-enabled="' + esc(t.id) + '"' + (fx.enabled !== false ? ' checked' : '') + '><span>Efecto hover activo</span></label>' +
            '<label class="check"><input type="checkbox" data-fx-animate="' + esc(t.id) + '"' + (fx.animate !== false ? ' checked' : '') + '><span>Girar el borde</span></label>' +
            '<label class="check"><input type="checkbox" data-fx-glow="' + esc(t.id) + '"' + (fx.glow !== false ? ' checked' : '') + '><span>Resplandor exterior</span></label>' +
            '<label class="check"><input type="checkbox" data-fx-transition="' + esc(t.id) + '"' + (fx.transition !== false ? ' checked' : '') + '><span>Transición al abrir/cerrar producto</span></label>' +
          '</div>' +
          '<div class="field" style="margin-top:12px"><label>Vista previa</label>' +
            '<div class="theme-preview" data-preview>' +
              '<div class="tp-top"><span class="tp-dot"></span><span class="tp-dot"></span><span class="tp-dot"></span></div>' +
              '<div class="tp-body"><div class="tp-hero"><span class="tp-title"></span><span class="tp-btn"></span></div>' +
              '<div class="tp-cards"><span class="tp-card"></span><span class="tp-card"></span><span class="tp-card"></span></div></div>' +
            '</div></div>' +
          '<button class="btn" data-save-theme="' + esc(t.id) + '" style="margin-top:10px">Guardar paleta y efectos</button></div>';
      });
      html += '</div>';
      mount.innerHTML = html;

      if (window.ColorPicker && ColorPicker.init) ColorPicker.init(mount);

      function paintPreview(box) {
        var pv = box.querySelector('[data-preview]'); if (!pv) return;
        function cc(k) { var inp = box.querySelector('[data-color="' + k + '"]'); return inp ? inp.value : '#7c3aed'; }
        pv.style.background = cc('bg');
        pv.style.color = cc('text');
        var hero = pv.querySelector('.tp-hero'); hero.style.background = cc('brandLight');
        pv.querySelector('.tp-title').style.background = cc('text');
        pv.querySelector('.tp-btn').style.background = cc('brand');
        $all('.tp-card', pv).forEach(function (card) { card.style.background = cc('surface'); card.style.color = cc('text'); });
        pv.style.borderColor = cc('brandDark');
      }
      $all('[data-theme]', mount).forEach(function (box) {
        paintPreview(box);
        $all('[data-color]', box).forEach(function (inp) { inp.addEventListener('input', function () { paintPreview(box); }); });
      });

      $all('[data-save-theme]', mount).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var tid = btn.dataset.saveTheme;
          var box = mount.querySelector('[data-theme="' + tid + '"]');
          var theme = themes.filter(function (t) { return String(t.id) === String(tid); })[0];
          var colors = {}; COLOR_KEYS.forEach(function (k) { colors[k] = box.querySelector('[data-color="' + k + '"]').value; });
          var fx = {
            hover: box.querySelector('[data-fx-hover]').value,
            core: box.querySelector('[data-fx-core]').value,
            glowColor: box.querySelector('[data-fx-glow-color]').value,
            ring: clampNum(box.querySelector('[data-fx-ring]').value, 2, 1, 8),
            speed: clampNum(box.querySelector('[data-fx-speed]').value, 3.2, 0.5, 12),
            enabled: box.querySelector('[data-fx-enabled]').checked,
            animate: box.querySelector('[data-fx-animate]').checked,
            glow: box.querySelector('[data-fx-glow]').checked,
            transition: box.querySelector('[data-fx-transition]').checked,
            transitionColor: box.querySelector('[data-fx-transition-color]').value
          };
          var deco = Object.assign({}, theme.decorations, {
            snow: box.querySelector('[data-t-snow]').checked,
            bats: box.querySelector('[data-t-bats]').checked,
            fx: fx
          });
          SB.update('themes', { id: 'eq.' + tid }, { colors: colors, decorations: deco })
            .then(function () { toast('Paleta y efectos guardados', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
        });
      });
    }
  }

  /* =========================================================
   *  Usuarios (admins)
   * ========================================================= */
  function renderUsers(mount) {
    mount.innerHTML = skeleton(4);
    load('admins', { select: '*', order: 'created_at.asc' }).then(function (rows) {
      var state = { q: '' };
      draw();

      function reload() { return load('admins', { select: '*', order: 'created_at.asc' }).then(function (r) { rows = r; renderBody(); }); }

      function draw() {
        mount.innerHTML = toolbarHtml({
          search: true, searchId: 'uQ', placeholder: 'Buscar usuario…', countId: 'uCount',
          buttons: [{ label: '+ Invitar usuario', id: 'newUser', class: 'primary' }]
        }) + '<div id="uBody"></div>' +
          '<div class="card"><p class="mb0 muted" style="font-size:12.5px">Los usuarios se crean en <strong>Supabase → Authentication → Users</strong>. Al invitarlos desde aquí se crea la cuenta (si el registro por email está habilitado) y su perfil. Si tienes la confirmación por correo activada, el usuario deberá confirmarla antes de entrar.</p></div>';
        renderBody();
        $('#uQ', mount).addEventListener('input', function () { state.q = this.value; renderBody(); });
        $('#newUser', mount).addEventListener('click', inviteUser);
      }

      function renderBody() {
        var body = $('#uBody', mount);
        var view = filterRows(rows, state.q, ['name', 'username', 'role', function (r) { return r.id; }]);
        $('#uCount', mount).textContent = view.length + ' de ' + rows.length + ' usuario(s)';
        if (!rows.length) {
          body.innerHTML = emptyState('Sin usuarios', 'Invita a un editor para ayudarte a gestionar la tienda.', 'Invitar usuario', 'emptyNew');
          var eb = $('#emptyNew', body); if (eb) eb.addEventListener('click', inviteUser);
          return;
        }
        if (!view.length) { body.innerHTML = '<div class="card empty">Ningún usuario coincide.</div>'; return; }
        body.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table class="responsive"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>' +
          view.map(function (r) {
            return '<tr data-id="' + esc(r.id) + '"><td data-label="Nombre">' + esc(r.name || '—') + '<div class="muted" style="font-size:12px">' + esc(r.id) + '</div></td>' +
              '<td data-label="Usuario">' + esc(r.username || '—') + '</td>' +
              '<td data-label="Rol"><span class="tag role">' + esc(r.role) + '</span></td>' +
              '<td data-label="Estado">' + (r.active ? '<span class="tag on">Activo</span>' : '<span class="tag off">Inactivo</span>') + '</td>' +
              '<td data-label=""><div class="list-actions"><button class="btn sm" data-edit="' + esc(r.id) + '">Editar</button>' +
              (r.id === S.me.id ? '' : '<button class="btn sm danger" data-del="' + esc(r.id) + '">Quitar</button>') + '</div></td></tr>';
          }).join('') + '</tbody></table></div>';
        body.onclick = function (e) {
          var ed = e.target.closest('[data-edit]');
          if (ed) { editUser(rows.filter(function (r) { return r.id === ed.dataset.edit; })[0]); return; }
          var de = e.target.closest('[data-del]');
          if (de) doRemove(de.dataset.del);
        };
      }

      function doRemove(id) {
        var row = rows.filter(function (r) { return r.id === id; })[0];
        confirmDialog('¿Quitar el perfil de «' + ((row && (row.name || row.username)) || id) + '»? (La cuenta de Auth no se borra.)', function () {
          SB.remove('admins', { id: 'eq.' + id }).then(function () {
            toast('Quitado', 'ok'); logActivity('Quitó usuario: ' + (row && (row.name || row.username))); reload();
          }).catch(function (e) { toast(e.message, 'err'); });
        });
      }

      function editUser(row) {
        openModal({
          title: 'Editar usuario',
          body: '<form id="uForm"><div class="field"><label>Nombre</label><input id="u_name" value="' + esc(row.name || '') + '"></div>' +
            '<div class="field"><label>Usuario</label><input id="u_user" value="' + esc(row.username || '') + '"></div>' +
            '<div class="field"><label>Rol</label><select id="u_role"><option value="editor"' + (row.role === 'editor' ? ' selected' : '') + '>editor</option>' +
            '<option value="owner"' + (row.role === 'owner' ? ' selected' : '') + '>owner</option></select></div>' +
            '<div class="check"><input type="checkbox" id="u_active"' + (row.active ? ' checked' : '') + '><span>Activo</span></div></form>',
          buttons: [
            { label: 'Cancelar', onClick: closeModal },
            { label: 'Guardar', class: 'primary', onClick: function () {
              SB.update('admins', { id: 'eq.' + row.id }, {
                name: $('#u_name').value.trim(), username: $('#u_user').value.trim() || null,
                role: $('#u_role').value, active: $('#u_active').checked
              }).then(function () { closeModal(); toast('Guardado', 'ok'); logActivity('Editó usuario: ' + $('#u_name').value.trim()); reload(); })
                .catch(function (e) { toast(e.message, 'err'); });
            } }
          ]
        });
      }

      function inviteUser() {
        openModal({
          title: 'Invitar usuario',
          body: '<form id="invForm"><div class="field"><label>Correo</label><input type="email" id="i_email" required></div>' +
            '<div class="field"><label>Contraseña temporal</label><input type="text" id="i_pass" required></div>' +
            '<div class="field"><label>Nombre</label><input id="i_name"></div>' +
            '<div class="field mb0"><label>Rol</label><select id="i_role"><option value="editor">editor</option><option value="owner">owner</option></select></div>' +
            '<p class="help">Requiere que el registro por email esté habilitado en Supabase Auth.</p></form>',
          buttons: [
            { label: 'Cancelar', onClick: closeModal },
            { label: 'Crear', class: 'primary', onClick: function () {
              var email = $('#i_email').value.trim(), pass = $('#i_pass').value;
              if (!email || !pass) return toast('Correo y contraseña obligatorios', 'err');
              SB.adminSignUp(email, pass).then(function (res) {
                var uid = res && res.user && res.user.id;
                if (!uid) throw new Error('No se pudo crear el usuario (¿confirmación por correo activada?).');
                return SB.insert('admins', { id: uid, name: $('#i_name').value.trim(), role: $('#i_role').value, active: true, store_id: sid() });
              }).then(function () { closeModal(); toast('Usuario creado', 'ok'); logActivity('Invitó usuario: ' + email); reload(); })
                .catch(function (e) { toast(e.message, 'err'); });
            } }
          ]
        });
      }
    }).catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });
  }

  /* =========================================================
   *  Pedidos
   * ========================================================= */
  var ORDER_STATUS = ['nuevo', 'en_proceso', 'pagado', 'entregado', 'cancelado'];
  function renderOrders(mount) {
    mount.innerHTML = skeleton(5);
    load('orders', { select: '*', order: 'created_at.desc' }).then(function (rows) {
      var state = { q: '', status: '' };
      draw();

      function visibleRows() {
        var v = filterRows(rows, state.q, ['name', 'phone', 'location', 'order_number', function (r) { return r.id; }]);
        if (state.status) v = v.filter(function (o) { return o.status === state.status; });
        return v;
      }
      function draw() {
        mount.innerHTML = toolbarHtml({
          search: true, searchId: 'oQ', placeholder: 'Buscar pedido, cliente o teléfono…',
          filters: [{ id: 'oStatus', options: [['', 'Todos los estados']].concat(ORDER_STATUS.map(function (s) { return [s, s]; })) }],
          countId: 'oCount',
          buttons: [{ label: 'Exportar CSV', id: 'csvBtn', class: 'ghost' }]
        }) + '<div id="oBody"></div>';
        renderBody();
        $('#oQ', mount).addEventListener('input', function () { state.q = this.value; renderBody(); });
        $('#oStatus', mount).addEventListener('change', function () { state.status = this.value; renderBody(); });
        $('#csvBtn', mount).addEventListener('click', exportCsv);
      }
      function renderBody() {
        var body = $('#oBody', mount);
        var view = visibleRows();
        $('#oCount', mount).textContent = view.length + ' de ' + rows.length + ' pedido(s)';
        if (!rows.length) {
          body.innerHTML = emptyState('Sin pedidos todavía', 'Cuando un cliente envíe una cotización aparecerá aquí.', '', '', '🧾');
          return;
        }
        if (!view.length) { body.innerHTML = '<div class="card empty">Ningún pedido coincide con los filtros.</div>'; return; }
        body.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table class="responsive"><thead><tr><th>#</th><th>Cliente</th><th>Total</th><th>Estado</th><th>Fecha</th><th></th></tr></thead><tbody>' +
          view.map(function (o) {
            return '<tr><td data-label="Pedido">' + (o.order_number || o.id) + '</td><td data-label="Cliente"><strong>' + esc(o.name) + '</strong><div class="muted" style="font-size:12px">' + esc(o.phone || '') + '</div></td>' +
              '<td data-label="Total">' + money(o.total) + '</td><td data-label="Estado"><span class="pill ' + esc(o.status) + '">' + esc(o.status) + '</span></td>' +
              '<td data-label="Fecha" class="muted">' + esc(new Date(o.created_at).toLocaleString()) + '</td>' +
              '<td data-label=""><button class="btn sm" data-view="' + esc(o.id) + '">Ver</button></td></tr>';
          }).join('') + '</tbody></table></div>';
        body.onclick = function (e) {
          var b = e.target.closest('[data-view]');
          if (b) openOrder(rows.filter(function (r) { return String(r.id) === b.dataset.view; })[0]);
        };
      }
      function reload() { return load('orders', { select: '*', order: 'created_at.desc' }).then(function (r2) { rows = r2; renderBody(); refreshNavBadge(); }); }
      function exportCsv() {
        var cols = [
          { l: 'Nº', v: function (o) { return o.order_number || o.id; } },
          { l: 'Cliente', v: function (o) { return o.name; } },
          { l: 'Teléfono', v: function (o) { return o.phone; } },
          { l: 'Ubicación', v: function (o) { return o.location; } },
          { l: 'Pago', v: function (o) { return o.payment_method; } },
          { l: 'Total', v: function (o) { return o.total; } },
          { l: 'Estado', v: function (o) { return o.status; } },
          { l: 'Fecha', v: function (o) { return o.created_at; } }
        ];
        downloadBlob('pedidos-' + Date.now() + '.csv', toCSV(rows, cols), 'text/csv;charset=utf-8');
      }
      function openOrder(o) {
        var items = (o.items || []).map(function (it) {
          return '<tr><td data-label="Ítem">' + esc(it.name || it.title || '') + '</td><td data-label="Cant.">' + esc(it.qty || 1) + '</td><td data-label="Precio">' + money(it.price) + '</td></tr>';
        }).join('');
        openModal({
          title: 'Pedido #' + (o.order_number || o.id),
          body: '<div class="row"><div class="field"><label>Cliente</label><input value="' + esc(o.name) + '" readonly></div>' +
            '<div class="field"><label>Teléfono</label><input value="' + esc(o.phone || '') + '" readonly></div></div>' +
            '<div class="row"><div class="field"><label>Ubicación</label><input value="' + esc(o.location || '') + '" readonly></div>' +
            '<div class="field"><label>Pago</label><input value="' + esc(o.payment_method || '') + '" readonly></div></div>' +
            (o.note ? '<div class="field"><label>Nota</label><textarea readonly>' + esc(o.note) + '</textarea></div>' : '') +
            '<div class="card" style="padding:0;margin:0 0 14px"><table class="responsive"><thead><tr><th>Ítem</th><th>Cant.</th><th>Precio</th></tr></thead><tbody>' + items + '</tbody></table></div>' +
            '<div class="field"><label>Estado</label><select id="o_status">' + ORDER_STATUS.map(function (s) { return '<option value="' + s + '"' + (s === o.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>',
          buttons: [
            { label: 'Cerrar', onClick: closeModal },
            { label: 'Guardar estado', class: 'primary', onClick: function () {
              var st = $('#o_status').value;
              SB.update('orders', { id: 'eq.' + o.id }, { status: st }).then(function () {
                closeModal(); toast('Estado actualizado', 'ok');
                logActivity('Cambió pedido #' + (o.order_number || o.id) + ' a ' + st);
                invalidate(); refreshNavBadge(); reload();
              }).catch(function (e) { toast(e.message, 'err'); });
            } }
          ]
        });
      }
    }).catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });
  }

  // Actualiza el badge de pedidos nuevos en el menú lateral.
  function refreshNavBadge() {
    var badge = $('[data-badge="pedidos"]');
    if (!badge) return;
    load('orders', { select: 'id,status' }).then(function (rows) {
      var n = rows.filter(function (o) { return o.status === 'nuevo'; }).length;
      badge.textContent = n;
      badge.hidden = !n;
    }).catch(function () {});
  }

  /* =========================================================
   *  Dashboard + Backup
   * ========================================================= */
  function renderDashboard(mount) {
    mount.innerHTML = skeleton(3);
    Promise.all([
      SB.get('products', scope('products', { select: 'id,type,hidden' })),
      SB.get('categories', scope('categories', { select: 'id' })),
      SB.get('orders', scope('orders', { select: 'id,order_number,status,total,created_at' })),
      SB.get('activity_log', scope('activity_log', { select: 'text,created_at,user_id', order: 'created_at.desc', limit: '8' })).catch(function () { return []; }),
      SB.get('admins', scope('admins', { select: 'id,name,username' })).catch(function () { return []; })
    ]).then(function (r) {
      var prod = r[0], cats = r[1], orders = r[2], log = r[3] || [], admins = r[4] || [];
      function ymd(d) { return d.toISOString().slice(0, 10); }
      var range = { from: ymd(new Date(Date.now() - 29 * 864e5)), to: ymd(new Date()) };
      draw();

      function inRange(o) {
        var t = new Date(o.created_at).getTime();
        if (range.from && t < new Date(range.from + 'T00:00:00').getTime()) return false;
        if (range.to && t > new Date(range.to + 'T23:59:59').getTime()) return false;
        return true;
      }
      function draw() {
        var nProd = prod.filter(function (p) { return p.type !== 'combo'; }).length;
        var nCombo = prod.filter(function (p) { return p.type === 'combo'; }).length;
        var nNew = orders.filter(function (o) { return o.status === 'nuevo'; }).length;
        var scoped = orders.filter(inRange);
        var revenue = scoped.filter(function (o) { return o.status === 'pagado' || o.status === 'entregado'; })
          .reduce(function (a, o) { return a + (Number(o.total) || 0); }, 0);
        var paid = scoped.filter(function (o) { return o.status === 'pagado' || o.status === 'entregado'; }).length;
        var ticket = paid ? revenue / paid : 0;

        var counts = {}; ORDER_STATUS.forEach(function (s) { counts[s] = 0; });
        scoped.forEach(function (o) { if (counts[o.status] != null) counts[o.status]++; });
        var maxC = Math.max.apply(null, ORDER_STATUS.map(function (s) { return counts[s]; }).concat([1]));
        var bars = ORDER_STATUS.map(function (s) {
          return '<div class="bar-row"><span class="bar-label pill ' + s + '">' + s + '</span>' +
            '<span class="bar-track"><span class="bar-fill" style="width:' + Math.round(counts[s] / maxC * 100) + '%"></span></span>' +
            '<span class="bar-val">' + counts[s] + '</span></div>';
        }).join('');

        var nameOf = {}; admins.forEach(function (a) { nameOf[a.id] = a.name || a.username || ''; });
        var acts = log.slice(0, 8);
        var actHtml = acts.length ? '<ul class="activity">' + acts.map(function (a) {
          return '<li><span class="act-dot"></span><span class="act-text">' + esc(a.text) + '</span>' +
            '<span class="act-meta">' + esc(nameOf[a.user_id] || '') + ' · ' + esc(timeAgo(a.created_at)) + '</span></li>';
        }).join('') + '</ul>' : '<p class="muted">Sin actividad reciente.</p>';

        mount.innerHTML =
          '<div class="metrics-bar">' +
            '<button class="btn sm" data-range="7">7 días</button>' +
            '<button class="btn sm" data-range="30">30 días</button>' +
            '<button class="btn sm" data-range="90">90 días</button>' +
            '<button class="btn sm" data-range="all">Todo</button>' +
            '<span class="toolbar-spacer"></span>' +
            '<input type="date" id="dFrom" value="' + range.from + '">' +
            '<span class="muted">→</span>' +
            '<input type="date" id="dTo" value="' + range.to + '">' +
          '</div>' +
          '<div class="grid">' +
            stat(nProd, 'Productos') + stat(nCombo, 'Combos') + stat(cats.length, 'Categorías') +
            stat(nNew, 'Pedidos nuevos') + stat(money(revenue), 'Ingresos (pagados)') + stat(money(ticket), 'Ticket promedio') +
          '</div>' +
          '<div class="dashboard-cols">' +
            '<div class="card"><h3>Pedidos por estado</h3><p class="desc">' + scoped.length + ' pedido(s) en el período.</p>' + bars + '</div>' +
            '<div class="card"><h3>Actividad reciente</h3><p class="desc">Últimos cambios en el panel.</p>' + actHtml + '</div>' +
          '</div>';

        $('#dFrom', mount).addEventListener('change', function () { range.from = this.value; draw(); });
        $('#dTo', mount).addEventListener('change', function () { range.to = this.value; draw(); });
        $all('[data-range]', mount).forEach(function (b) {
          b.addEventListener('click', function () {
            var n = b.dataset.range;
            if (n === 'all') { range.from = ''; range.to = ''; }
            else { range.from = ymd(new Date(Date.now() - (Number(n) - 1) * 864e5)); range.to = ymd(new Date()); }
            draw();
          });
        });
      }
    }).catch(function (e) { mount.innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; });

    function stat(n, l) { return '<div class="stat"><div class="n">' + esc(n) + '</div><div class="l">' + esc(l) + '</div></div>'; }
  }

  function timeAgo(iso) {
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (isNaN(s)) return '';
    if (s < 60) return 'hace un momento';
    if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
    return 'hace ' + Math.floor(s / 86400) + ' d';
  }

  var BACKUP_TABLES = ['settings', 'categories', 'subcategories', 'products', 'combo_items', 'nav_groups', 'nav_items', 'builder_slots', 'builder_parts', 'themes', 'orders'];
  function renderBackup(mount) {
    mount.innerHTML =
      '<div class="card"><h3>Copia de seguridad</h3><p class="desc">Descarga un JSON con todas las tablas del catálogo y la configuración.</p>' +
      '<button class="btn primary" id="dlBackup">Descargar backup (JSON)</button></div>' +
      '<div class="card"><h3>Restaurar desde backup</h3><p class="desc">Sube un archivo JSON. Se combinan los registros (upsert); no borra lo existente.</p>' +
      '<label class="btn" for="impFile">Elegir archivo…</label>' +
      '<input type="file" id="impFile" accept="application/json,.json" hidden>' +
      '<div id="impStatus" class="status-line"></div></div>';

    $('#dlBackup', mount).addEventListener('click', function () {
      Promise.all(BACKUP_TABLES.map(function (t) { return SB.get(t, scope(t, { select: '*' })).then(function (rows) { return [t, rows]; }); }))
        .then(function (pairs) {
          var out = { exported_at: new Date().toISOString(), store_id: sid(), data: {} };
          pairs.forEach(function (p) { out.data[p[0]] = p[1]; });
          downloadBlob('maniaworld-backup-' + Date.now() + '.json', JSON.stringify(out, null, 2), 'application/json');
          toast('Backup descargado', 'ok');
        }).catch(function (e) { toast(e.message, 'err'); });
    });

    $('#impFile', mount).addEventListener('change', function () {
      var file = this.files[0]; if (!file) return;
      var st = $('#impStatus', mount);
      st.className = 'status-line'; st.textContent = 'Leyendo…';
      var reader = new FileReader();
      reader.onload = function () {
        var payload;
        try { payload = JSON.parse(reader.result); } catch (e) { st.textContent = 'JSON inválido.'; return; }
        var data = (payload && payload.data) || payload;
        var tables = BACKUP_TABLES.filter(function (t) { return Array.isArray(data[t]) && data[t].length; });
        if (!tables.length) { st.textContent = 'El archivo no contiene tablas reconocibles.'; return; }
        confirmDialog('Se importarán ' + tables.length + ' tabla(s) en esta tienda. ¿Continuar?', function () {
          st.textContent = 'Importando…';
          var total = 0;
          tables.reduce(function (chain, t) {
            return chain.then(function () {
              var rows = data[t].map(function (r) {
                var c = Object.assign({}, r);
                if (TENANT.indexOf(t) !== -1) c.store_id = sid();
                return c;
              });
              return SB.upsert(t, rows, t === 'settings' ? 'store_id' : 'id').then(function () { total += rows.length; });
            });
          }, Promise.resolve()).then(function () {
            invalidate();
            st.className = 'status-line ok';
            st.textContent = 'Importados ' + total + ' registro(s).';
            toast('Importación completada', 'ok');
            logActivity('Importó backup (' + total + ' registros)');
          }).catch(function (e) { st.textContent = 'Error: ' + e.message; toast(e.message, 'err'); });
        }, { title: 'Importar backup', dangerLabel: 'Importar', dangerClass: 'primary' });
      };
      reader.readAsText(file);
    });
  }

  /* =========================================================
   *  Navegación / tabs
   * ========================================================= */
  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    productos: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    combos: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    categorias: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    subcategorias: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    navegacion: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
    armador: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    temas: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
    apariencia: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    pedidos: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01M18 16h.01"/>',
    usuarios: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    backup: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>'
  };
  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  var TABS = [
    { k: 'dashboard', l: 'Panel', grp: 'General', svg: 'dashboard', render: renderDashboard },
    { k: 'productos', l: 'Productos', grp: 'Catálogo', svg: 'productos', render: renderProducts },
    { k: 'combos', l: 'Combos', grp: 'Catálogo', svg: 'combos', render: renderCombos },
    { k: 'categorias', l: 'Categorías', grp: 'Catálogo', svg: 'categorias', render: function (m) { renderEntityList('categories', m); } },
    { k: 'subcategorias', l: 'Subcategorías', grp: 'Catálogo', svg: 'subcategorias', render: function (m) { renderEntityList('subcategories', m); } },
    { k: 'armador', l: 'Armador', grp: 'Catálogo', svg: 'armador', render: renderBuilderTab },
    { k: 'home', l: 'Home / Contenido', grp: 'Tienda', svg: 'home', render: renderHome },
    { k: 'navegacion', l: 'Navegación', grp: 'Tienda', svg: 'navegacion', render: renderNavTab },
    { k: 'apariencia', l: 'Apariencia', grp: 'Tienda', svg: 'apariencia', render: renderApariencia },
    { k: 'temas', l: 'Temas / Festivos', grp: 'Tienda', svg: 'temas', render: renderThemes },
    { k: 'pedidos', l: 'Pedidos', grp: 'Tienda', svg: 'pedidos', render: renderOrders },
    { k: 'usuarios', l: 'Usuarios', grp: 'Sistema', svg: 'usuarios', render: renderUsers, ownerOnly: true },
    { k: 'backup', l: 'Backup', grp: 'Sistema', svg: 'backup', render: renderBackup }
  ];

  function renderNavTab(mount) {
    mount.innerHTML = '<div class="card" style="padding:0"><h3 style="padding:20px 20px 0">Grupos</h3><div id="navGroups" style="padding:0 20px 20px"></div>' +
      '<div style="border-top:1px solid var(--border)"><h3 style="padding:20px 20px 0">Ítems</h3><div id="navItems" style="padding:0 20px 20px"></div></div></div>';
    renderEntityList('nav_groups', $('#navGroups', mount));
    renderEntityList('nav_items', $('#navItems', mount));
  }
  function renderBuilderTab(mount) {
    mount.innerHTML = '<div class="card" style="padding:0"><h3 style="padding:20px 20px 0">Slots</h3><div id="bSlots" style="padding:0 20px 20px"></div>' +
      '<div style="border-top:1px solid var(--border)"><h3 style="padding:20px 20px 0">Piezas</h3><div id="bParts" style="padding:0 20px 20px"></div></div></div>';
    renderEntityList('builder_slots', $('#bSlots', mount));
    renderEntityList('builder_parts', $('#bParts', mount));
  }

  function buildSidebar() {
    var nav = $('#sideNav');
    nav.innerHTML = '';
    var groups = [];
    TABS.forEach(function (t) {
      if (t.ownerOnly && (!S.me || S.me.role !== 'owner')) return;
      var g = groups.filter(function (x) { return x.name === t.grp; })[0];
      if (!g) { g = { name: t.grp, tabs: [] }; groups.push(g); }
      g.tabs.push(t);
    });
    groups.forEach(function (g) {
      var box = el('div', { class: 'nav-group' });
      box.appendChild(el('div', { class: 'nav-heading' }, esc(g.name)));
      g.tabs.forEach(function (t) {
        var b = el('button', { class: 'nav-item' + (t.k === S.tab ? ' active' : ''), 'data-tab': t.k, type: 'button', 'aria-current': t.k === S.tab ? 'page' : 'false' },
          svgIcon(t.svg) + '<span>' + esc(t.l) + '</span>' + (t.k === 'pedidos' ? '<span class="badge" data-badge="pedidos" hidden>0</span>' : ''));
        b.addEventListener('click', function () { switchTab(t.k); });
        box.appendChild(b);
      });
      nav.appendChild(box);
    });
  }

  function switchTab(key) {
    var tab = TABS.filter(function (t) { return t.k === key; })[0];
    if (!tab) return;
    S.tab = key;
    closeModal();
    $all('#sideNav .nav-item').forEach(function (b) {
      var on = b.dataset.tab === key;
      b.classList.toggle('active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $('#viewTitle').textContent = tab.l;
    $('#viewActions').innerHTML = '';
    if (key === 'home') {
      var save = el('button', { class: 'btn primary', id: 'saveHome' }, 'Guardar cambios');
      $('#viewActions').appendChild(save);
    }
    toggleNav(false);
    tab.render($('#view'));
  }

  function toggleNav(force) {
    var sb = $('#sidebar');
    var open = force != null ? force : !sb.classList.contains('open');
    sb.classList.toggle('open', open);
    document.body.classList.toggle('nav-open', open);
  }

  /* =========================================================
   *  Arranque + Auth
   * ========================================================= */
  function showLogin() {
    $('#loginView').hidden = false;
    $('#appView').hidden = true;
  }
  function loginError(msg) {
    var e = $('#lgError');
    e.style.display = 'block';
    e.textContent = msg || '';
  }
  function showApp() {
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    var who = $('#whoami');
    who.textContent = (S.me.name || S.user.email || '') + (S.me.role === 'owner' ? ' · propietario' : '');
    buildSidebar();
    switchTab('dashboard');
    refreshNavBadge();
  }

  function boot() {
    if (!SB.isConfigured()) {
      showLogin();
      loginError('Configura assets/js/config.js con tu SUPABASE_URL y anon key.');
      return;
    }
    if (SB.isLoggedIn()) {
      resolveMe().then(showApp).catch(function (err) {
        console.error('[login] sesión guardada inválida:', err && err.message);
        SB.signOut().then(function () { showLogin(); loginError(err.message); });
      });
    } else {
      showLogin();
    }
  }

  function resolveMe() {
    S.user = SB.currentUser();
    if (!S.user) return Promise.reject(new Error('sin sesión'));
    return SB.get('admins', { select: '*', id: 'eq.' + S.user.id }).then(function (rows) {
      var me = rows[0];
      if (!me) throw new Error('Tu cuenta no tiene perfil de administrador. Pide al propietario que te agregue.');
      if (!me.active) throw new Error('Tu cuenta está desactivada.');
      S.me = me;
      return me;
    });
  }

  /* =========================================================
   *  Paleta de búsqueda global (Ctrl+K)
   * ========================================================= */
  function openPalette() {
    var root = $('#paletteRoot');
    if (root && !root.hidden) return;
    root.hidden = false;
    root.innerHTML = '<div class="palette-scrim"></div>' +
      '<div class="palette" role="dialog" aria-modal="true" aria-label="Búsqueda global">' +
        '<div class="palette-input">' + SEARCH_ICO + '<input id="palQ" placeholder="Buscar pestañas, productos, pedidos…" autocomplete="off"></div>' +
        '<div class="palette-results" id="palRes"><p class="muted pad">Cargando…</p></div>' +
      '</div>';

    var input = $('#palQ', root), res = $('#palRes', root);
    var items = [], sel = 0;
    var tabsItems = TABS.map(function (t) {
      return { group: 'Ir a', label: t.l, hint: 'Sección', run: function () { switchTab(t.k); } };
    });
    var prodItems = [], orderItems = [];
    Promise.all([
      load('products', { select: 'id,name,type' }),
      load('orders', { select: 'id,order_number,name,status' })
    ]).then(function (r) {
      prodItems = r[0].map(function (p) {
        return { group: 'Producto', label: p.name, hint: p.type === 'combo' ? 'Combo' : 'Producto', run: function () { switchTab(p.type === 'combo' ? 'combos' : 'productos'); } };
      });
      orderItems = r[1].map(function (o) {
        return { group: 'Pedido', label: '#' + (o.order_number || o.id) + ' · ' + (o.name || ''), hint: o.status, run: function () { switchTab('pedidos'); } };
      });
      render('');
    }).catch(function () { render(''); });

    function render(q) {
      var ql = (q || '').trim().toLowerCase();
      var pool = tabsItems.concat(prodItems, orderItems);
      items = (ql ? pool.filter(function (it) { return it.label.toLowerCase().indexOf(ql) !== -1; }) : pool).slice(0, 12);
      sel = 0;
      if (!items.length) { res.innerHTML = '<p class="muted pad">Sin resultados.</p>'; return; }
      res.innerHTML = items.map(function (it, i) {
        return '<button type="button" class="palette-item' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
          '<span class="pi-main">' + esc(it.label) + '</span><span class="pi-hint">' + esc(it.group) + ' · ' + esc(it.hint) + '</span></button>';
      }).join('');
    }
    function move(d) {
      if (!items.length) return;
      sel = (sel + d + items.length) % items.length;
      $all('.palette-item', res).forEach(function (b, i) { b.classList.toggle('sel', i === sel); });
      var s = $('.palette-item.sel', res); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
    }
    function go() { var it = items[sel]; if (it) { closePalette(); it.run(); } }
    function closePalette() {
      document.removeEventListener('keydown', onKey, true);
      root.hidden = true; root.innerHTML = '';
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); go(); }
    }
    $('.palette-scrim', root).addEventListener('click', closePalette);
    input.addEventListener('input', function () { render(this.value); });
    res.addEventListener('click', function (e) {
      var b = e.target.closest('.palette-item');
      if (b) { sel = Number(b.dataset.i); go(); }
    });
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { input.focus(); }, 0);
  }

  function saveCurrent() {
    var s = $('#saveHome');
    if (s) { s.click(); return true; }
    return false;
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('#lgEmail').value.trim(), pass = $('#lgPass').value;
    var btn = $('#lgBtn'); btn.disabled = true; btn.textContent = 'Entrando…';
    $('#lgError').style.display = 'none';
    SB.signIn(email, pass).then(resolveMe).then(showApp).catch(function (err) {
      console.error('[login] fallo:', err && (err.status ? ('HTTP ' + err.status + ' ') : '') + (err && err.message));
      loginError(err.message || 'No se pudo iniciar sesión.');
    }).then(function () { btn.disabled = false; btn.textContent = 'Entrar'; });
  });

  $('#logoutBtn').addEventListener('click', function () {
    SB.signOut().then(function () { S.user = null; S.me = null; invalidate(); showLogin(); });
  });
  $('#menuToggle').addEventListener('click', function () { toggleNav(); });
  $('#sidebarScrim').addEventListener('click', function () { toggleNav(false); });
  $('#sidebarClose').addEventListener('click', function () { toggleNav(false); });
  var searchBtn = $('#searchBtn'); if (searchBtn) searchBtn.addEventListener('click', openPalette);
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); openPalette(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 's') { if (saveCurrent()) e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (!$('#paletteRoot').hidden) return;
      if ($('#modalRoot').children.length) { closeModal(); return; }
      if ($('#sidebar').classList.contains('open')) toggleNav(false);
    }
  });

  boot();
})();
