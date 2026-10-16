/*
 * sb.js  -  Cliente minimo de Supabase (REST + Auth) sin dependencias.
 * Uso:  window.GigaSB.get('products', 'select=*&order=position.asc')
 *
 * Lee credenciales de assets/js/config.js (window.GIGA_CONFIG).
 * Guarda la sesion del panel en localStorage (clave gh_admin_session).
 */
(function () {
  'use strict';

  var cfg = window.GIGA_CONFIG || {};
  var BASE = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');
  var KEY = String(cfg.SUPABASE_ANON_KEY || '');
  var BUCKET = cfg.STORAGE_BUCKET || 'images';
  var SESSION_KEY = 'gh_admin_session';

  function isConfigured() {
    return BASE.indexOf('http') === 0 && KEY && KEY.indexOf('TU_') !== 0;
  }

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  }
  function token() {
    var s = getSession();
    return s && s.access_token ? s.access_token : KEY;
  }
  function authHeaders() {
    return {
      apikey: KEY,
      Authorization: 'Bearer ' + token()
    };
  }

  // Renueva el access_token antes de que caduque (sesion de 1h).
  // Si falla, se devuelve la sesion tal cual: el 401 lo reportara el request.
  function refreshSession() {
    var s = getSession();
    if (!s || !s.refresh_token) return Promise.resolve(s);
    return fetch(BASE + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    }).then(function (res) {
      if (!res.ok) return s;
      return res.json().then(function (data) {
        var ns = {
          access_token: data.access_token || s.access_token,
          refresh_token: data.refresh_token || s.refresh_token,
          expires_at: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000),
          user: data.user || s.user
        };
        setSession(ns);
        return ns;
      });
    }).catch(function () { return s; });
  }

  function ensureFresh() {
    var s = getSession();
    if (!s || !s.access_token) return Promise.resolve(s);
    if (!s.expires_at || s.expires_at - Date.now() > 60000) return Promise.resolve(s);
    return refreshSession();
  }

  // ---- REST ----
  function qs(params) {
    if (!params) return '';
    if (typeof params === 'string') return params ? (params.charAt(0) === '?' ? params : '?' + params) : '';
    var p = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) p.append(k, params[k]);
    });
    var s = p.toString();
    return s ? '?' + s : '';
  }

  function request(method, path, body, extraHeaders) {
    if (!isConfigured()) {
      return Promise.reject(new Error('Supabase no configurado: edita assets/js/config.js'));
    }
    return ensureFresh().then(function () {
      var headers = Object.assign({ 'Content-Type': 'application/json' }, authHeaders(), extraHeaders || {});
      return fetch(BASE + path, {
        method: method,
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (res) {
        if (res.status === 204) return null;
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
          if (!res.ok) {
            var msg = (data && (data.message || data.error_description || data.error || data.hint)) || res.statusText;
            var err = new Error(msg || ('HTTP ' + res.status));
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
      });
    });
  }

  function get(table, params) {
    return request('GET', '/rest/v1/' + table + qs(params));
  }
  function insert(table, rows) {
    return request('POST', '/rest/v1/' + table, rows, { Prefer: 'return=representation' });
  }
  function update(table, match, patch) {
    return request('PATCH', '/rest/v1/' + table + qs(match), patch, { Prefer: 'return=representation' });
  }
  function remove(table, match) {
    return request('DELETE', '/rest/v1/' + table + qs(match), undefined, { Prefer: 'return=representation' });
  }
  // insert-or-update por columna unica (merge-duplicates)
  function upsert(table, rows, onConflict) {
    var extra = { Prefer: 'resolution=merge-duplicates,return=representation' };
    var path = '/rest/v1/' + table + (onConflict ? ('?on_conflict=' + onConflict) : '');
    return request('POST', path, rows, extra);
  }
  // llama una funcion RPC de Postgres (p.ej. create_order)
  function rpc(fn, args) {
    return request('POST', '/rest/v1/rpc/' + fn, args || {});
  }

  // ---- Auth ----
  function signIn(email, password) {
    if (!isConfigured()) return Promise.reject(new Error('Supabase no configurado: edita assets/js/config.js'));
    return fetch(BASE + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error(data.error_description || data.msg || data.error || 'No se pudo iniciar sesion');
        }
        var session = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600000),
          user: data.user
        };
        setSession(session);
        return session;
      });
    });
  }

  // Crea una cuenta nueva (registro) SIN reemplazar la sesión actual del panel.
  function adminSignUp(email, password) {
    if (!isConfigured()) return Promise.reject(new Error('Supabase no configurado: edita assets/js/config.js'));
    return fetch(BASE + '/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error_description || data.msg || data.error || 'No se pudo crear el usuario');
        return data;
      });
    });
  }

  function signOut() {
    var s = getSession();
    setSession(null);
    if (s && s.access_token) {
      return fetch(BASE + '/auth/v1/logout', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token }
      }).catch(function () {});
    }
    return Promise.resolve();
  }

  function currentUser() {
    var s = getSession();
    return s ? s.user : null;
  }
  function isLoggedIn() {
    var s = getSession();
    if (!s || !s.access_token) return false;
    if (!s.expires_at || s.expires_at > Date.now()) return true;
    // Caduco pero hay refresh_token: se renueva solo en el primer request.
    return !!s.refresh_token;
  }

  // ---- Storage ----
  var MAXW = Number(cfg.IMAGE_MAX_WIDTH) || 1600;
  var WEBP_Q = Number(cfg.IMAGE_WEBP_QUALITY) || 0.82;

  // Convertibles a WebP: cualquier imagen salvo SVG y GIF (perderian animacion).
  function canWebp(file) {
    return /^image\//i.test(file.type) && !/svg|gif/i.test(file.type);
  }

  // Redimensiona (max maxW de ancho) y recodifica a WebP con canvas.
  // Resuelve el Blob WebP, o null si el navegador no soporta el formato.
  function toWebp(file, maxW, quality) {
    return new Promise(function (resolve) {
      if (typeof document === 'undefined' || !window.URL || !URL.createObjectURL) { resolve(null); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          var scale = Math.min(1, (maxW || 1600) / w);
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            resolve(blob && /webp/i.test(blob.type) ? blob : null);
          }, 'image/webp', quality || 0.82);
        } catch (e) { URL.revokeObjectURL(url); resolve(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function putObject(name, body, type) {
    return ensureFresh().then(function () {
      return fetch(BASE + '/storage/v1/object/' + BUCKET + '/' + name, {
        method: 'POST',
        headers: {
          apikey: KEY,
          Authorization: 'Bearer ' + token(),
          'Content-Type': type || 'application/octet-stream',
          'x-upsert': 'true'
        },
        body: body
      });
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('Subida fallida: ' + t); });
      return publicUrl(name);
    });
  }

  // Extensiones permitidas y tope de tamano (misma regla que el servidor
  // de OX1WhatShop). El nombre ya es aleatorio: ts-random.ext
  var OK_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;
  var MAX_UPLOAD = 15 * 1024 * 1024;

  // Sube a Storage. Si es imagen convertible, la pasa a WebP primero.
  // Las rutas nuevas van bajo s{STORE_ID}/ para que RLS las aisle por tienda.
  function upload(path, file) {
    if (!file) return Promise.reject(new Error('No se recibio ninguna imagen'));
    if (!OK_EXT.test(file.name || '')) {
      return Promise.reject(new Error('Formato no permitido: usa PNG, JPG, WEBP, GIF o SVG'));
    }
    if (file.size && file.size > MAX_UPLOAD) {
      return Promise.reject(new Error('Imagen muy grande: maximo 15 MB'));
    }
    var pref = 's' + (Number(cfg.STORE_ID) || 1) + '/';
    var clean = String(path || '').replace(/^\/+|\/+$/g, '');
    var base = pref + (clean ? clean + '/' : '') + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    var conv = canWebp(file) ? toWebp(file, MAXW, WEBP_Q) : Promise.resolve(null);
    return conv.then(function (blob) {
      if (blob) return putObject(base + '.webp', blob, 'image/webp');
      var ext = (file.name.split('.').pop() || 'png').toLowerCase();
      return putObject(base + '.' + ext, file, file.type || 'application/octet-stream');
    });
  }
  function publicUrl(path) {
    if (!path) return '';
    if (/^https?:/i.test(path)) return path;
    return BASE + '/storage/v1/object/public/' + BUCKET + '/' + path.replace(/^\/+/, '');
  }

  // Resuelve cualquier valor de imagen a una URL usable:
  //   http(s) | data:  -> tal cual (externa)
  //   assets/ | ./ | / -> relativo a la pagina (archivo local)
  //   resto            -> objeto del bucket en Storage
  // Si IMAGE_CDN esta configurado (Fase G), las imagenes del bucket se
  // piden al Worker (capa de cache en el borde, gratis).
  var CDN = String(cfg.IMAGE_CDN || '').replace(/\/+$/, '');

  function cdnUrl(path) {
    var obj = String(path || '').replace(/^\/+/, '');
    var enc = obj.split('/').map(encodeURIComponent).join('/');
    return CDN + '/' + enc;
  }

  function resolveImage(path) {
    if (!path) return '';
    if (/^(https?:|data:)/i.test(path)) return path;
    if (/^(assets\/|\.\/|\/)/i.test(path)) return path.replace(/^\.\//, '');
    if (CDN) return cdnUrl(path);
    return publicUrl(path);
  }

  window.GigaSB = {
    URL: BASE,
    BUCKET: BUCKET,
    isConfigured: isConfigured,
    get: get,
    insert: insert,
    update: update,
    remove: remove,
    upsert: upsert,
    rpc: rpc,
    signIn: signIn,
    adminSignUp: adminSignUp,
    signOut: signOut,
    currentUser: currentUser,
    isLoggedIn: isLoggedIn,
    getSession: getSession,
    refresh: refreshSession,
    upload: upload,
    publicUrl: publicUrl,
    resolveImage: resolveImage,
    cdnUrl: cdnUrl
  };
})();
