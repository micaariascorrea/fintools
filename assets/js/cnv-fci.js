(function () {
  "use strict";

  var URL_FCI_HOME = "https://www.cnv.gov.ar/SitioWeb/FondosComunesInversion";
  var URL_FCI_DET = "https://www.cnv.gov.ar/SitioWeb/FondosComunesInversion/DetallesFCI/";
  var URL_FICHA = "https://www.cnv.gov.ar/SitioWeb/Empresas/Empresa/";
  var URL_HECHOS = "https://www.cnv.gov.ar/SitioWeb/HechosRelevantes";
  var URL_REGPUB = "https://www.cnv.gov.ar/SitioWeb/RegistrosPublicos/DetallesRegistrosPublicos/";

  var PALABRAS_GENERICAS = {
    FCI: 1, F: 1, C: 1, I: 1, FONDO: 1, COMUN: 1, DE: 1, DEL: 1, LA: 1, EL: 1, Y: 1,
    INVERSION: 1, INVERSIONES: 1, ABIERTO: 1, CERRADO: 1, EX: 1, S: 1, A: 1
  };
  var MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
  var MAX_POR_CATEGORIA = 1;
  var ANIO_MIN_ESTATUTO = 2005;
  var TRAMO_ESTATUTO = 5;
  var STORAGE_KEY = "allinarg_cnv_fci_fondos_v1";
  var STORAGE_EST = "allinarg_cnv_fci_estatutos_v1";
  var STORAGE_LISTAS = "allinarg_cnv_fci_listas_v1";
  var LISTAS_JSON = "assets/data/cnv-fci-listas.json";
  var LISTAS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 25000;

  var ACCENT = "1F6FEB";
  var GRAFITO = "2B2B2B";
  var GRIS_TXT = "7A7A7A";
  var GRIS_FONDO = "F5F5F5";
  var GRIS_LINEA = "DDDDDD";
  var ACCENT_SUAVE = "E8F1FF";
  var VERDE = "2E7D32";
  var ROJO = "C62828";

  var PENDIENTES = [
    ["FCI", "Formulario W8"],
    ["FCI", "IIPP"],
    ["Gerente", "c) Titularidad del capital social (registro de accionistas)"],
    ["Gerente", "d) Declaración de beneficiarios finales (≥10%)"],
    ["Gerente", "Formulario W8 BEN-E"],
    ["Depositaria", "c) Titularidad del capital social (registro de accionistas)"],
    ["Depositaria", "d) Declaración de beneficiarios finales (≥10%)"]
  ];

  var state = {
    listas: null,
    pendingMatches: null,
    lastWorkbook: null,
    lastFilename: null,
    logoBuffer: null,
    logoExt: null
  };

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    var el = $("resultado");
    el.textContent = msg;
    el.classList.remove("empty", "has-result", "error");
    if (kind === "error") el.classList.add("error");
    else if (kind === "ok") el.classList.add("has-result");
    else el.classList.add("empty");
  }

  function norm(texto) {
    var t = String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return t.replace(/\s+/g, " ").toUpperCase().trim();
  }

  function soloDigitos(cuit) {
    return String(cuit || "").replace(/\D/g, "");
  }

  function cuitFmt(cuit) {
    var d = soloDigitos(cuit);
    return d.length === 11 ? d.slice(0, 2) + "-" + d.slice(2, 10) + "-" + d.slice(10) : cuit || "";
  }

  function tokens(texto) {
    return norm(texto).split(/[^A-Z0-9]+/).filter(Boolean);
  }

  function tokensDistintivos(texto) {
    return tokens(texto).filter(function (t) { return !PALABRAS_GENERICAS[t]; });
  }

  function sequenceRatio(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    var m = a.length, n = b.length;
    var prev = new Array(n + 1);
    var cur = new Array(n + 1);
    var i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    var dist = prev[n];
    return 1 - dist / Math.max(m, n, 1);
  }

  function puntaje(buscado, candidato) {
    var tb = tokensDistintivos(buscado);
    if (!tb.length) tb = tokens(buscado);
    var tc = tokens(candidato);
    if (!tb.length || !tc.length) return 0;
    var porToken = 0;
    for (var i = 0; i < tb.length; i++) {
      var best = 0;
      for (var j = 0; j < tc.length; j++) best = Math.max(best, sequenceRatio(tb[i], tc[j]));
      porToken += best;
    }
    porToken /= tb.length;
    return 0.8 * porToken + 0.2 * sequenceRatio(norm(buscado), norm(candidato));
  }

  function parseFecha(txt) {
    var m = String(txt || "").match(/\s*(\d{1,2})\s+([a-zA-Z]{3})\w*\.?\s+(\d{4})/);
    if (!m) return null;
    var mes = MESES[m[2].toLowerCase()];
    if (!mes) return null;
    return new Date(Number(m[3]), mes - 1, Number(m[1]));
  }

  function fmtDate(d) {
    if (!d) return "";
    var dd = String(d.getDate()).padStart(2, "0");
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    return dd + "/" + mm + "/" + d.getFullYear();
  }

  function fmtDateCN(d) {
    return d.getDate() + "/" + (d.getMonth() + 1) + "/" + d.getFullYear();
  }

  function todayYmd() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + mm + dd;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function proxyTargets(url) {
    var enc = encodeURIComponent(url);
    return [
      "https://api.allorigins.win/raw?url=" + enc,
      "https://api.allorigins.win/get?url=" + enc,
      // Jina keeps the Composición Gerente/Depositaria block even when HTML proxies truncate/fail.
      "https://r.jina.ai/" + url,
      "https://api.codetabs.com/v1/proxy?quest=" + enc
    ];
  }

  function fetchWithTimeout(url, ms) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, ms);
    return fetch(url, { method: "GET", signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        clearTimeout(timer);
        return res;
      })
      .catch(function (err) {
        clearTimeout(timer);
        throw err;
      });
  }

  async function fetchViaProxy(target) {
    var res = await fetchWithTimeout(target, FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error("HTTP " + res.status);
    var text = await res.text();
    if (target.indexOf("allorigins.win/get?") !== -1) {
      var parsed = JSON.parse(text);
      text = parsed.contents || "";
      if (parsed.status && parsed.status.http_code && parsed.status.http_code >= 400) {
        throw new Error("HTTP " + parsed.status.http_code);
      }
    }
    if (!text || text.length < 40) throw new Error("Respuesta vacía");
    if (/error code:\s*50[023]/i.test(text) || /Bad Gateway/i.test(text) || /error code:\s*408/i.test(text)) {
      throw new Error("Proxy timeout/error");
    }
    return text;
  }

  function raceProxies(targets) {
    return new Promise(function (resolve, reject) {
      var pending = targets.length;
      var errors = [];
      if (!pending) {
        reject(new Error("Sin proxies"));
        return;
      }
      targets.forEach(function (t) {
        fetchViaProxy(t).then(resolve, function (err) {
          errors.push(err);
          pending -= 1;
          if (pending === 0) reject(errors[0] || new Error("Proxy falló"));
        });
      });
    });
  }

  async function fetchText(url, attempt) {
    attempt = attempt || 0;
    var targets = proxyTargets(url);
    var lastErr = null;

    try {
      // Race HTML proxies + Jina (Jina preserves Gerente/Depositaria composition text).
      return await raceProxies(targets.slice(0, 3));
    } catch (e) {
      lastErr = e;
    }

    for (var i = 0; i < targets.length; i++) {
      try {
        return await fetchViaProxy(targets[i]);
      } catch (e) {
        lastErr = e;
      }
    }

    if (attempt < 1) {
      await sleep(400);
      return fetchText(url, attempt + 1);
    }
    var msg = lastErr && lastErr.message ? lastErr.message : "No se pudo consultar la CNV";
    if (/408|abort|timeout|Proxy timeout/i.test(msg)) {
      throw new Error("La CNV/proxy tardó demasiado (timeout). Probá de nuevo en unos segundos.");
    }
    throw lastErr || new Error("No se pudo consultar la CNV");
  }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function leerDesplegables(html) {
    var doc = parseDoc(html);
    var selects = Array.prototype.slice.call(doc.querySelectorAll("select"));
    var listas = [];
    selects.forEach(function (sel) {
      var ident = norm((sel.id || "") + " " + (sel.getAttribute("name") || ""));
      var opts = [];
      Array.prototype.forEach.call(sel.options, function (o) {
        var v = String(o.value || "").trim();
        var t = String(o.textContent || "").trim();
        if (v && t && !norm(t).startsWith("SELECCION")) opts.push([v, t]);
      });
      if (opts.length) listas.push([ident, opts]);
    });
    var res = { fondos: [], gerentes: [], depositarias: [] };
    listas.forEach(function (pair) {
      var ident = pair[0];
      var opts = pair[1];
      var textos = opts.map(function (o) { return norm(o[1]); }).join(" | ");
      if (ident.indexOf("DEPOSITARI") !== -1 || textos.indexOf("CAJA DE VALORES") !== -1) {
        if (!res.depositarias.length) res.depositarias = opts;
      } else if (ident.indexOf("GERENTE") !== -1 || (textos.indexOf("SOCIEDAD GERENTE") !== -1 && opts.length < 300)) {
        if (!res.gerentes.length) res.gerentes = opts;
      } else if (ident.indexOf("FONDO") !== -1 || ident.indexOf("FCI") !== -1 || ident === "LFC" || opts.length > 300) {
        if (opts.length > res.fondos.length) res.fondos = opts;
      }
    });
    return res;
  }

  function fillDepositariaSelect(opts) {
    var sel = $("depositaria-select");
    var current = sel.value;
    sel.innerHTML = '<option value="">— Elegir de la lista CNV —</option>';
    opts.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  function entidadEnTexto(texto, opciones, etiqueta) {
    var t = norm(texto);
    var hallados = opciones.filter(function (o) {
      return norm(o[1]).length > 5 && t.indexOf(norm(o[1])) !== -1;
    });
    if (hallados.length) {
      return hallados.reduce(function (best, cur) {
        return norm(cur[1]).length > norm(best[1]).length ? cur : best;
      });
    }
    var re = new RegExp(etiqueta, "g");
    var m;
    var tramos = [];
    while ((m = re.exec(t)) !== null) tramos.push(t.slice(m.index + m[0].length, m.index + m[0].length + 120));
    var mejor = [null, ""];
    var mejorP = 0;
    tramos.forEach(function (tramo) {
      opciones.forEach(function (o) {
        var p = puntaje(o[1], tramo.slice(0, norm(o[1]).length + 10));
        if (p > mejorP) {
          mejorP = p;
          mejor = o;
        }
      });
    });
    return mejorP >= 0.75 ? mejor : [null, ""];
  }

  function linksAif(doc) {
    return Array.prototype.slice.call(doc.querySelectorAll("a[href]"))
      .map(function (a) { return a.getAttribute("href"); })
      .filter(function (h) { return h && h.toLowerCase().indexOf("publicview") !== -1; });
  }

  function extraerDocs(doc) {
    var docs = [];
    var vistos = {};
    Array.prototype.forEach.call(doc.querySelectorAll("a[href]"), function (a) {
      var href = a.getAttribute("href") || "";
      if (href.toLowerCase().indexOf("publicview") === -1) return;
      var tr = a.closest("tr");
      if (!tr) return;
      var celdas = Array.prototype.map.call(tr.querySelectorAll("td"), function (td) {
        return (td.textContent || "").replace(/\s+/g, " ").trim();
      });
      if (celdas.length < 3) return;
      var fecha = parseFecha(celdas[0]);
      var descripcion = celdas.slice(1).reduce(function (best, c) {
        return c.length > best.length ? c : best;
      }, "");
      var documento = "";
      for (var i = 0; i < celdas.length; i++) {
        if (/^\d{6,8}$/.test(celdas[i])) { documento = celdas[i]; break; }
      }
      var clave = documento || href.toLowerCase();
      if (vistos[clave]) return;
      vistos[clave] = 1;
      var seccionTag = null;
      var node = tr;
      while (node && !seccionTag) {
        node = node.previousElementSibling;
        if (node && /^H[34]$/i.test(node.tagName)) seccionTag = node;
      }
      if (!seccionTag) {
        var parent = tr.parentElement;
        while (parent && !seccionTag) {
          var prev = parent.previousElementSibling;
          while (prev) {
            if (/^H[34]$/i.test(prev.tagName)) { seccionTag = prev; break; }
            prev = prev.previousElementSibling;
          }
          parent = parent.parentElement;
        }
      }
      var seccion = seccionTag ? (seccionTag.textContent || "").replace(/\s+/g, " ").trim() : "";
      docs.push({ fecha: fecha, seccion: seccion, descripcion: descripcion, documento: documento, link: href });
    });
    docs.sort(function (a, b) { return ordenReciente(b) - ordenReciente(a); });
    return docs;
  }

  function ordenRecienteKey(d) {
    var t = d.fecha ? d.fecha.getTime() : 0;
    var n = parseInt(d.documento || "0", 10) || 0;
    return t * 1e6 + n;
  }

  function ordenReciente(d) { return ordenRecienteKey(d); }

  function ordenBalanceKey(d) {
    var m = norm(d.descripcion).match(/FECHA CIERRE:?\s*(\d{4})-(\d{2})-(\d{2})/);
    var cierre = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : 0;
    return cierre * 1e6 + ordenRecienteKey(d);
  }

  function esEstatuto(d) {
    return norm(d.descripcion).indexOf("ESTATUTO") !== -1 || norm(d.seccion || "").indexOf("ESTATUTO") !== -1;
  }

  function esEeccPropio(desc) {
    var d = norm(desc);
    return d.indexOf("ESTADOS CONTABLES") !== -1 && d.indexOf("NORMA CONTABLE") !== -1
      && d.indexOf("CONTROLADAS") === -1 && d.indexOf("RELAC.:") === -1;
  }

  async function tituloPresentacion(link) {
    try {
      var html = await fetchText(link);
      var doc = parseDoc(html);
      var titulo = doc.querySelector("title");
      var t = titulo ? (titulo.textContent || "").replace(/\s+/g, " ").trim() : "";
      var m = t.match(/#\s*\d+\s*-\s*(.+?)\s*\|\s*(\d{11})/);
      if (!m) return [null, null];
      return [m[1].trim(), m[2]];
    } catch (e) {
      return [null, null];
    }
  }

  async function cuitPorDocumentos(nombre, links, maximo) {
    maximo = maximo || 4;
    for (var i = 0; i < Math.min(links.length, maximo); i++) {
      var pair = await tituloPresentacion(links[i]);
      var razon = pair[0];
      var cuit = pair[1];
      if (cuit && (!nombre || puntaje(nombre, razon) >= 0.75)) return [razon, cuit];
    }
    return [null, null];
  }

  async function cuitDesdeValor(valor, nombre) {
    if (!valor) return null;
    var digits = soloDigitos(valor);
    if (digits.length === 11) return digits;
    if (!/^\d+$/.test(valor)) return null;
    try {
      var html = await fetchText(URL_REGPUB + valor);
      var doc = parseDoc(html);
      var txt = (doc.body && doc.body.textContent) || "";
      var clave = norm(nombre).slice(0, 15);
      var re = /(\d{2}-?\d{8}-?\d)\s*-\s*([^|\n]{5,80})/g;
      var m;
      while ((m = re.exec(txt)) !== null) {
        if (norm(m[2]).indexOf(clave) === 0) return soloDigitos(m[1]);
      }
      var pair = await cuitPorDocumentos(nombre, linksAif(doc));
      return pair[1];
    } catch (e) {
      return null;
    }
  }

  async function cuitDesdeHechos(nombre) {
    try {
      var html = await fetchText(URL_HECHOS);
      var doc = parseDoc(html);
      var candidatos = [];
      Array.prototype.forEach.call(doc.querySelectorAll("tr"), function (tr) {
        var a = tr.querySelector("a[href*='ublicview'], a[href*='ublicView'], a[href*='publicview']");
        if (!a) return;
        var ok = Array.prototype.some.call(tr.querySelectorAll("td"), function (td) {
          return puntaje(nombre, (td.textContent || "").trim()) >= 0.85;
        });
        if (ok) candidatos.push(a.getAttribute("href"));
      });
      var uniq = [];
      var seen = {};
      candidatos.forEach(function (h) {
        if (!seen[h]) { seen[h] = 1; uniq.push(h); }
      });
      var pair = await cuitPorDocumentos(nombre, uniq);
      return pair[1];
    } catch (e) {
      return null;
    }
  }

  function loadFondosCache() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveFondoCache(fila) {
    var all = loadFondosCache();
    all[fila.numero_cnv] = fila;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function loadEstatutos() {
    try { return JSON.parse(localStorage.getItem(STORAGE_EST) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveEstatuto(cuit, d) {
    var all = loadEstatutos();
    all[cuit] = {
      cuit: cuit,
      consultado: new Date().toISOString().slice(0, 10),
      fecha: d && d.fecha ? d.fecha.toISOString().slice(0, 10) : "",
      descripcion: d ? d.descripcion : "",
      documento: d ? d.documento : "",
      link: d ? d.link : ""
    };
    localStorage.setItem(STORAGE_EST, JSON.stringify(all));
  }

  function rankingFondos(buscado, fondos) {
    return fondos.slice().sort(function (a, b) {
      return puntaje(buscado, b[1]) - puntaje(buscado, a[1]);
    }).slice(0, 6);
  }

  function elegirFondoAuto(buscado, fondos) {
    var ranking = rankingFondos(buscado, fondos);
    if (!ranking.length) return null;
    var p0 = puntaje(buscado, ranking[0][1]);
    var p1 = ranking.length > 1 ? puntaje(buscado, ranking[1][1]) : 0;
    if (p0 >= 0.97 || (p0 >= 0.85 && p0 - p1 >= 0.08)) return ranking[0];
    return { needsPick: true, ranking: ranking };
  }

  function loadListasCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_LISTAS) || "null");
      if (!raw || !raw.fondos || !raw.fondos.length) return null;
      if (raw.savedAt && Date.now() - raw.savedAt > LISTAS_TTL_MS) return null;
      // Prefer bundled file when cache lacks CUIT maps (older cache versions).
      if (!raw.cuitById || !Object.keys(raw.cuitById).length) return null;
      return raw;
    } catch (e) {
      return null;
    }
  }

  function saveListasCache(listas) {
    try {
      localStorage.setItem(STORAGE_LISTAS, JSON.stringify({
        savedAt: Date.now(),
        fondos: listas.fondos,
        gerentes: listas.gerentes,
        depositarias: listas.depositarias,
        cuitById: listas.cuitById || {},
        cuitGerenteById: listas.cuitGerenteById || {}
      }));
    } catch (e) { /* quota */ }
  }

  async function loadBundledListas() {
    var res = await fetch(LISTAS_JSON, { method: "GET" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    if (!data || !data.fondos || !data.fondos.length) throw new Error("Listado local vacío");
    return {
      fondos: data.fondos,
      gerentes: data.gerentes || [],
      depositarias: data.depositarias || [],
      cuitById: data.cuitById || {},
      cuitGerenteById: data.cuitGerenteById || {}
    };
  }

  function cuitFromListas(listas, id, rol) {
    if (!id || !listas) return null;
    if (rol === "gerente" && listas.cuitGerenteById && listas.cuitGerenteById[id]) {
      return soloDigitos(listas.cuitGerenteById[id]);
    }
    if (listas.cuitById && listas.cuitById[id]) return soloDigitos(listas.cuitById[id]);
    return null;
  }

  function matchOpcion(nombre, opciones) {
    if (!nombre || !opciones || !opciones.length) return [null, ""];
    var n = norm(nombre);
    var best = [null, ""];
    var bestP = 0;
    for (var i = 0; i < opciones.length; i++) {
      var cand = opciones[i];
      var cn = norm(cand[1]);
      var p = puntaje(nombre, cand[1]);
      if (cn === n || cn.indexOf(n) !== -1 || n.indexOf(cn) !== -1) p = Math.max(p, 0.96);
      if (p > bestP) {
        bestP = p;
        best = cand;
      }
    }
    return bestP >= 0.8 ? best : [null, ""];
  }

  // CNV "Composición Semanal Cartera" publishes Gerente / Depositaria as plain labels.
  function extraerOrganosDesdeTexto(texto) {
    var flat = String(texto || "").replace(/\s+/g, " ").trim();
    var m = flat.match(
      /Gerente\s+(.+?)\s+Depositaria\s+(.+?)(?:\s+Clasificaci|\s+Moneda\b|\s+Regi[oó]n\b|\s+Horizonte\b)/i
    );
    if (m) {
      return { gerente: m[1].replace(/\s+/g, " ").trim(), depositaria: m[2].replace(/\s+/g, " ").trim() };
    }
    var g = flat.match(/Gerente\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][^|]{3,100}?S\.?\s*A\.?\s*U?\.?)/i);
    var d = flat.match(/Depositaria\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][^|]{3,100}?S\.?\s*A\.?\s*U?\.?)/i);
    return {
      gerente: g ? g[1].replace(/\s+/g, " ").trim() : "",
      depositaria: d ? d[1].replace(/\s+/g, " ").trim() : ""
    };
  }

  function resolverEntidad(nombrePagina, opciones, listas, rol) {
    var pair = matchOpcion(nombrePagina, opciones);
    if (!pair[0] && nombrePagina) {
      // Keep the CNV page name even if dropdown id is unknown.
      pair = [null, nombrePagina];
    }
    var cuit = cuitFromListas(listas, pair[0], rol);
    if (!cuit && nombrePagina) {
      // Name → id → CUIT when id matching used a slightly different reason social.
      var byName = matchOpcion(nombrePagina, opciones);
      cuit = cuitFromListas(listas, byName[0], rol);
      if (byName[0]) pair = byName;
    }
    return { id: pair[0], nombre: pair[1] || nombrePagina || "", cuit: cuit };
  }

  async function ensureListas() {
    if (state.listas && state.listas.fondos.length) return state.listas;

    var cached = loadListasCache();
    if (cached) {
      state.listas = cached;
      fillDepositariaSelect(cached.depositarias || []);
      return state.listas;
    }

    setStatus("Cargando listado de fondos…");
    try {
      var bundled = await loadBundledListas();
      state.listas = bundled;
      saveListasCache(bundled);
      fillDepositariaSelect(bundled.depositarias);
      return bundled;
    } catch (e) {
      // Fallback: scrape CNV home via proxy (slow; avoided when bundled JSON is available).
      setStatus("Cargando listado de fondos de la CNV…");
      var html = await fetchText(URL_FCI_HOME);
      var listas = leerDesplegables(html);
      if (!listas.fondos.length) throw new Error("No pude leer el listado de fondos de la CNV.");
      state.listas = listas;
      saveListasCache(listas);
      fillDepositariaSelect(listas.depositarias);
      return listas;
    }
  }

  async function descubrirFondo(numero, buscado, elegido) {
    var listas = await ensureListas();
    if (!elegido) {
      var pick = elegirFondoAuto(buscado, listas.fondos);
      if (!pick) throw new Error("No se encontró el fondo en la CNV.");
      if (pick.needsPick) {
        state.pendingMatches = { numero: numero, buscado: buscado, ranking: pick.ranking };
        showMatches(pick.ranking);
        throw new Error("Elegí el fondo de la lista de coincidencias.");
      }
      elegido = pick;
    }
    var idFci = elegido[0];
    var nombreCnv = elegido[1];

    var overrideG = soloDigitos($("cuit-gerente").value);
    var overrideD = soloDigitos($("cuit-depositaria").value);
    var depSel = $("depositaria-select").value;
    var depPair = [null, ""];
    if (depSel) {
      var found = listas.depositarias.find(function (o) { return o[0] === depSel; });
      if (found) depPair = found;
    }

    setStatus("Leyendo ficha del fondo: " + nombreCnv + "…");
    var detHtml = await fetchText(URL_FCI_DET + idFci);
    var detDoc = parseDoc(detHtml);
    var texto = ((detDoc.body && detDoc.body.textContent) || "") + "\n" + detHtml;
    var docsFci = extraerDocs(detDoc);

    // Prefer the Composición Semanal labels (public CNV data), then dropdown-name scan.
    var organos = extraerOrganosDesdeTexto(texto);
    if (!organos.depositaria || !organos.gerente) {
      // Jina fallback: reliable for Gerente/Depositaria when HTML proxies drop that block.
      try {
        var jinaTxt = await fetchViaProxy("https://r.jina.ai/" + URL_FCI_DET + idFci);
        var organosJ = extraerOrganosDesdeTexto(jinaTxt);
        if (!organos.gerente && organosJ.gerente) organos.gerente = organosJ.gerente;
        if (!organos.depositaria && organosJ.depositaria) organos.depositaria = organosJ.depositaria;
        texto += "\n" + jinaTxt;
      } catch (e) { /* keep HTML parse result */ }
    }

    var gerPair = entidadEnTexto(texto, listas.gerentes, "GERENTE");
    var depFromPage = entidadEnTexto(texto, listas.depositarias, "DEPOSITARI");
    if (!depPair[0] && depFromPage[0]) depPair = depFromPage;

    setStatus("Obteniendo CUITs…");
    var gerRes = resolverEntidad(organos.gerente || gerPair[1] || "", listas.gerentes, listas, "gerente");
    var depRes = resolverEntidad(
      organos.depositaria || depPair[1] || "",
      listas.depositarias,
      listas,
      "depositaria"
    );
    if (!depPair[0] && depRes.id) depPair = [depRes.id, depRes.nombre];

    var gerente = gerRes.nombre || gerPair[1] || "";
    var depositaria = depRes.nombre || depPair[1] || "";
    var cuitG = overrideG.length === 11 ? overrideG : gerRes.cuit;
    var cuitD = overrideD.length === 11 ? overrideD : depRes.cuit;

    if (!cuitG) cuitG = cuitFromListas(listas, gerPair[0], "gerente");
    if (!cuitD) cuitD = cuitFromListas(listas, depPair[0], "depositaria");

    // One AIF title fetch for gerente if still missing.
    if (!cuitG) {
      var fromDocs = await cuitPorDocumentos(gerente, docsFci.map(function (d) { return d.link; }), 1);
      if (fromDocs[1]) {
        cuitG = fromDocs[1];
        gerente = gerente || fromDocs[0] || "";
      }
    }

    // Depositaria CUIT from AIF title of a matching hechos/doc link on the fund page, if needed.
    if (!cuitD && depositaria) {
      var depLinks = linksAif(detDoc);
      var depCuit = await cuitPorDocumentos(depositaria, depLinks, 2);
      if (depCuit[1]) {
        cuitD = depCuit[1];
        depositaria = depositaria || depCuit[0] || "";
      }
    }

    if (!cuitG || !cuitD) {
      var missing = [];
      if (!cuitG) missing.push("CUIT Gerente");
      if (!cuitD) {
        missing.push(
          "CUIT Depositaria" +
            (depositaria ? " (" + depositaria + ")" : "") +
            " — no se pudo leer de la CNV; elegí Depositaria o cargá el CUIT"
        );
      }
      throw new Error("Falta completar: " + missing.join(" · ") + ". Completá los campos y volvé a generar.");
    }

    return {
      numero_cnv: numero,
      denominacion_fci: nombreCnv,
      gerente: gerente,
      cuit_gerente: cuitG,
      depositaria: depositaria,
      cuit_depositaria: cuitD,
      id_fci_cnv: idFci,
      docs_fci: docsFci
    };
  }

  function showMatches(ranking) {
    var wrap = $("match-wrap");
    var list = $("match-list");
    list.innerHTML = "";
    ranking.forEach(function (item, idx) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary match-btn";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.marginBottom = "0.5rem";
      btn.style.textAlign = "left";
      btn.textContent = (idx + 1) + ") " + item[1];
      btn.addEventListener("click", function () {
        wrap.style.display = "none";
        runWithElegido(item);
      });
      list.appendChild(btn);
    });
    wrap.style.display = "block";
  }

  async function leerFicha(cuit, anios, hasta) {
    hasta = hasta || new Date();
    // Progressive windows: big depositarias (e.g. Banco de Valores) blow proxy limits at 3y.
    var windows = [anios];
    if (anios > 1) windows.push(1);
    if (anios > 0) windows.push(0.5);
    var lastErr = null;
    for (var i = 0; i < windows.length; i++) {
      var years = windows[i];
      var desde = new Date(hasta.getTime());
      if (years < 1) desde.setMonth(desde.getMonth() - Math.round(years * 12));
      else desde.setFullYear(desde.getFullYear() - years);
      var params = "fdesde=" + encodeURIComponent(fmtDateCN(desde)) + "&fhasta=" + encodeURIComponent(fmtDateCN(hasta));
      var url = URL_FICHA + soloDigitos(cuit) + "?" + params;
      try {
        var html = await fetchText(url);
        return parsearFicha(html, url, cuit);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("No se pudo leer la ficha CNV");
  }

  function parsearFicha(html, url, cuit) {
    var doc = parseDoc(html);
    var nombre = "";
    Array.prototype.forEach.call(doc.querySelectorAll("h1, h2"), function (h) {
      var t = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || /CUIT/i.test(t) || norm(t).indexOf("EMPRESAS") !== -1 || t.length <= 5) return;
      if (!nombre) nombre = t.split(/\s{2,}|En Oferta P|Sociedades|Régimen|Regimen/)[0].trim();
    });
    nombre = nombre.replace(/\s*\([^)]*\)\s*$/, "");
    return { nombre: nombre, cuit: cuitFmt(cuit), url: url, docs: extraerDocs(doc) };
  }

  async function mapPool(items, limit, worker) {
    var results = new Array(items.length);
    var i = 0;
    async function run() {
      while (i < items.length) {
        var idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(run());
    await Promise.all(runners);
    return results;
  }

  // Light estatuto fill: only local cache / docs already in the ficha window.
  // Avoids multi-year CNV scans that caused proxy 408 timeouts.
  async function buscarEstatutos(fichas) {
    var memoria = loadEstatutos();
    fichas.forEach(function (pair) {
      var ficha = pair[0];
      var cuit = soloDigitos(pair[1]);
      var recientes = ficha.docs.filter(esEstatuto).sort(function (a, b) {
        return ordenRecienteKey(b) - ordenRecienteKey(a);
      });
      if (recientes.length) {
        saveEstatuto(cuit, recientes[0]);
        return;
      }
      var m = memoria[cuit];
      if (m && m.link) {
        ficha.docs.push({
          fecha: m.fecha ? new Date(m.fecha + "T00:00:00") : null,
          seccion: "Estatutos",
          descripcion: m.descripcion,
          documento: m.documento,
          link: m.link
        });
      }
    });
  }

  function clasificar(ger, dep, fondo, docsFci) {
    var claves = tokensDistintivos(fondo);
    if (!claves.length) claves = tokens(fondo);

    function esDelFondo(d) {
      return claves.every(function (k) {
        return new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(d);
      });
    }

    function filtrar(docs, cond, keyFn) {
      keyFn = keyFn || ordenRecienteKey;
      return docs.filter(function (d) { return cond(norm(d.descripcion)); })
        .sort(function (a, b) { return keyFn(b) - keyFn(a); })
        .slice(0, MAX_POR_CATEGORIA);
    }

    var fci = docsFci || [];
    var salida = [
      ["FCI", "Reglamento de gestión vigente", fondo,
        filtrar(fci, function (d) { return d.indexOf("REGLAMENTO") !== -1; })
          .concat(filtrar(ger.docs, function (d) { return esDelFondo(d) && d.indexOf("REGLAMENTO DE GESTION") !== -1; }))
          .slice(0, MAX_POR_CATEGORIA)],
      ["FCI", "Último balance del FCI", fondo,
        filtrar(fci, function (d) { return d.indexOf("ESTADOS CONTABLES") !== -1 || d.indexOf("EECC") !== -1; }, ordenBalanceKey)
          .concat(filtrar(ger.docs, function (d) {
            return esDelFondo(d) && (d.indexOf("ESTADOS CONTABLES") !== -1 || d.indexOf("EECC") !== -1);
          }, ordenBalanceKey)).slice(0, MAX_POR_CATEGORIA)]
    ];

    [["Gerente", ger], ["Depositaria", dep]].forEach(function (pair) {
      var rol = pair[0];
      var ent = pair[1];
      var nom = ent.nombre || ("Sociedad " + rol);
      salida.push(
        [rol, "a) Estatuto", nom, ent.docs.filter(esEstatuto).sort(function (a, b) {
          return ordenRecienteKey(b) - ordenRecienteKey(a);
        }).slice(0, MAX_POR_CATEGORIA)],
        [rol, "b) Nómina de autoridades", nom, filtrar(ent.docs, function (d) {
          return d.indexOf("NOMINA DE AUTORIDADES") !== -1 && d.indexOf("CONTROLANTES") === -1;
        })],
        [rol, "b) Última acta de asamblea (designación de cargos)", nom, filtrar(ent.docs, function (d) {
          return d.indexOf("ACTA DE ASAMBLEA") !== -1;
        })],
        [rol, "b) Última acta de directorio", nom, filtrar(ent.docs, function (d) {
          return d.indexOf("ORGANO DE ADMINISTRACION") !== -1;
        })],
        [rol, "e) Último balance", nom, filtrar(ent.docs, function (d) {
          return esEeccPropio(d);
        }, ordenBalanceKey)]
      );
    });
    return salida;
  }

  function font(size, bold, color, italic, underline) {
    return {
      name: "Calibri",
      size: size || 10,
      bold: !!bold,
      italic: !!italic,
      underline: underline || undefined,
      color: { argb: "FF" + (color || GRAFITO) }
    };
  }

  function fillSolid(color) {
    return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + color } };
  }

  function thinBorder() {
    return { bottom: { style: "thin", color: { argb: "FF" + GRIS_LINEA } } };
  }

  async function prepararHoja(ws, titulo, subtitulo, anchos, logo) {
    ws.views = [{ showGridLines: false }];
    anchos.forEach(function (w, i) {
      ws.getColumn(i + 1).width = w;
    });
    ws.getRow(1).height = 34;
    ws.getRow(2).height = 22;
    ws.getRow(3).height = 16;
    var pusoLogo = false;
    if (logo && logo.buffer) {
      try {
        var imgId = logo.workbook.addImage({
          buffer: logo.buffer,
          extension: logo.ext || "png"
        });
        ws.addImage(imgId, {
          tl: { col: 0, row: 0 },
          ext: { width: 110, height: 30 }
        });
        pusoLogo = true;
      } catch (e) {
        pusoLogo = false;
      }
    }
    if (!pusoLogo) {
      ws.getCell("A1").value = "ALLINARG";
      ws.getCell("A1").font = font(16, true, ACCENT);
    }
    ws.mergeCells(2, 1, 2, anchos.length);
    ws.getCell("A2").value = titulo;
    ws.getCell("A2").font = font(15, true);
    ws.mergeCells(3, 1, 3, anchos.length);
    ws.getCell("A3").value = subtitulo;
    ws.getCell("A3").font = font(9, false, GRIS_TXT);
    for (var c = 1; c <= anchos.length; c++) {
      ws.getCell(4, c).border = { top: { style: "medium", color: { argb: "FF" + ACCENT } } };
    }
    ws.getRow(4).height = 6;
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.properties.tabColor = { argb: "FF" + ACCENT };
  }

  function encabezado(ws, fila, titulos) {
    ws.getRow(fila).height = 22;
    titulos.forEach(function (t, i) {
      var cell = ws.getCell(fila, i + 1);
      cell.value = t;
      cell.fill = fillSolid(GRAFITO);
      cell.font = font(10, true, "FFFFFF");
      cell.alignment = { vertical: "middle", indent: 1 };
    });
  }

  function celda(ws, fila, col, valor, opts) {
    opts = opts || {};
    var cell = ws.getCell(fila, col);
    cell.value = valor;
    cell.font = opts.font || font();
    cell.alignment = opts.align || { vertical: "middle", wrapText: true, indent: 1 };
    cell.border = thinBorder();
    if (opts.fill) cell.fill = fillSolid(opts.fill);
    return cell;
  }

  function linkCelda(ws, fila, col, url, texto, fill) {
    var cell = celda(ws, fila, col, {
      text: texto || "Abrir ↗",
      hyperlink: url
    }, {
      font: font(10, true, ACCENT, false, true),
      fill: fill,
      align: { horizontal: "center", vertical: "middle" }
    });
    return cell;
  }

  async function generarExcel(fondo, ger, dep, items, logoInfo) {
    var ExcelJS = window.ExcelJS;
    if (!ExcelJS) throw new Error("No se pudo cargar ExcelJS.");
    var wb = new ExcelJS.Workbook();
    wb.creator = "ALLINARG Financial Tools";
    var nombreFci = fondo.denominacion_fci;
    var sub = "N° CNV " + fondo.numero_cnv + "  ·  Fuente: Comisión Nacional de Valores  ·  Generado el " + fmtDate(new Date());
    var logo = logoInfo ? { buffer: logoInfo.buffer, ext: logoInfo.ext, workbook: wb } : null;

    var ws = wb.addWorksheet("Datos del FCI");
    await prepararHoja(ws, "Documentación CNV  |  " + nombreFci, sub, [38, 72, 16], logo);
    var filas = [
      ["Denominación del FCI", nombreFci, ""],
      ["N° CNV del fondo", fondo.numero_cnv, ""],
      ["Denominación Sociedad Depositaria", dep.nombre || fondo.depositaria || "", dep.url],
      ["CUIT/CDI Sociedad Depositaria", dep.cuit, dep.url],
      ["Denominación Sociedad Gerente", ger.nombre || fondo.gerente || "", ger.url],
      ["CUIT/CDI Sociedad Gerente", ger.cuit, ger.url]
    ];
    encabezado(ws, 6, ["Campo", "Dato", "Fuente"]);
    filas.forEach(function (row, idx) {
      var r = 7 + idx;
      ws.getRow(r).height = 20;
      celda(ws, r, 1, row[0], { font: font(10, true, GRIS_TXT) });
      celda(ws, r, 2, row[1], { font: font(11, true) });
      if (row[2]) linkCelda(ws, r, 3, row[2], "Ficha CNV ↗");
      else celda(ws, r, 3, "");
    });

    var ws2 = wb.addWorksheet("Documentación CNV");
    await prepararHoja(ws2, "Documentación pública en la CNV (documento más actual por ítem)", sub, [46, 12, 78, 11, 17, 11], logo);
    var cols = ["Ítem requerido", "Fecha", "Descripción en la CNV", "N° doc", "Estado", "Link"];
    encabezado(ws2, 6, cols);
    var r = 7;
    var bloqueAnt = null;
    items.forEach(function (item) {
      var bloque = item[0];
      var nombreItem = item[1];
      var entidad = item[2];
      var docs = item[3];
      if (bloque !== bloqueAnt) {
        ws2.mergeCells(r, 1, r, cols.length);
        var tituloBloque = { FCI: "Fondo Común de Inversión", Gerente: "Sociedad Gerente", Depositaria: "Sociedad Depositaria" }[bloque] || bloque;
        var c = ws2.getCell(r, 1);
        c.value = tituloBloque.toUpperCase() + "  ·  " + entidad;
        c.font = font(10, true, ACCENT);
        c.fill = fillSolid(GRIS_FONDO);
        c.alignment = { vertical: "middle", indent: 1 };
        ws2.getRow(r).height = 20;
        r += 1;
        bloqueAnt = bloque;
      }
      var d = docs && docs[0] ? docs[0] : null;
      var fill = d ? null : ACCENT_SUAVE;
      celda(ws2, r, 1, nombreItem, { font: font(10, true), fill: fill });
      celda(ws2, r, 2, d && d.fecha ? fmtDate(d.fecha) : "", {
        fill: fill,
        align: { horizontal: "center", vertical: "middle" }
      });
      celda(ws2, r, 3, d ? d.descripcion : "No encontrado en la CNV para el período consultado", {
        font: font(9, false, d ? GRAFITO : ROJO, !d),
        fill: fill
      });
      celda(ws2, r, 4, d ? d.documento : "", {
        fill: fill,
        align: { horizontal: "center", vertical: "middle" }
      });
      celda(ws2, r, 5, d ? "● Encontrado" : "● Pedir al fondo", {
        font: font(9, true, d ? VERDE : ROJO),
        fill: fill,
        align: { horizontal: "center", vertical: "middle" }
      });
      if (d) linkCelda(ws2, r, 6, d.link, "Abrir ↗", fill);
      else celda(ws2, r, 6, "", { fill: fill });
      ws2.getRow(r).height = 32;
      r += 1;
    });
    ws2.views = [{ state: "frozen", ySplit: 6, showGridLines: false }];

    var ws3 = wb.addWorksheet("Pendientes");
    await prepararHoja(ws3, "Documentación a solicitar al fondo", sub, [16, 64, 50, 14], logo);
    encabezado(ws3, 6, ["Bloque", "Ítem", "Motivo", "Recibido"]);
    var lista = PENDIENTES.map(function (p) { return [p[0], p[1], "No se publica en la CNV"]; });
    items.forEach(function (item) {
      if (!item[3] || !item[3].length) {
        lista.push([item[0], item[1], "No se encontró en la CNV para el período consultado"]);
      }
    });
    lista.forEach(function (row, idx) {
      var rr = 7 + idx;
      ws3.getRow(rr).height = 20;
      celda(ws3, rr, 1, row[0], { font: font(9, false, GRIS_TXT) });
      celda(ws3, rr, 2, row[1], { font: font(10, true) });
      celda(ws3, rr, 3, row[2], { font: font(9, false, GRIS_TXT) });
      celda(ws3, rr, 4, "☐", {
        font: font(12, false, ACCENT),
        align: { horizontal: "center", vertical: "middle" }
      });
    });
    ws3.views = [{ state: "frozen", ySplit: 6, showGridLines: false }];

    return wb;
  }

  function renderPreview(fondo, ger, dep, items) {
    var wrap = $("result-table-wrap");
    var encontrados = items.filter(function (it) { return it[3] && it[3].length; }).length;
    var html = "<p><strong>" + escapeHtml(fondo.denominacion_fci) + "</strong> · N° CNV " +
      escapeHtml(String(fondo.numero_cnv)) + "</p>";
    html += "<p>Gerente: " + escapeHtml(ger.nombre || fondo.gerente || "—") +
      " (" + escapeHtml(ger.cuit || "") + ")<br>Depositaria: " +
      escapeHtml(dep.nombre || fondo.depositaria || "—") +
      " (" + escapeHtml(dep.cuit || "") + ")</p>";
    html += "<p>Ítems con link: " + encontrados + "/" + items.length + "</p>";
    html += '<table class="result-table"><thead><tr><th>Bloque</th><th>Ítem</th><th>Estado</th><th>Link</th></tr></thead><tbody>';
    items.forEach(function (it) {
      var d = it[3] && it[3][0];
      html += "<tr>";
      html += "<td>" + escapeHtml(it[0]) + "</td>";
      html += "<td>" + escapeHtml(it[1]) + "</td>";
      html += "<td>" + (d ? "Encontrado" : "Pedir al fondo") + "</td>";
      html += "<td>" + (d ? '<a href="' + escapeHtml(d.link) + '" target="_blank" rel="noopener">Abrir</a>' : "—") + "</td>";
      html += "</tr>";
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;
    wrap.style.display = "block";
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function slugNombre(nombre) {
    return norm(nombre).replace(/[^\w]+/g, "_").replace(/^_|_$/g, "");
  }

  async function readLogoFile(file) {
    if (!file) return null;
    var buf = await file.arrayBuffer();
    var name = (file.name || "").toLowerCase();
    var ext = "png";
    if (name.indexOf(".jpg") !== -1 || name.indexOf(".jpeg") !== -1) ext = "jpeg";
    else if (name.indexOf(".gif") !== -1) ext = "gif";
    else if (name.indexOf(".webp") !== -1) ext = "png";
    return { buffer: buf, ext: ext };
  }

  async function pipeline(fondo) {
    var anios = parseInt($("anios").value, 10) || 3;
    var docsFci = fondo.docs_fci || [];
    if (!docsFci.length && fondo.id_fci_cnv) {
      setStatus("Leyendo documentación del fondo en la CNV…");
      docsFci = extraerDocs(parseDoc(await fetchText(URL_FCI_DET + fondo.id_fci_cnv)));
    }
    setStatus("Leyendo fichas CNV (Gerente y Depositaria)…");
    var pair = await Promise.all([
      leerFicha(fondo.cuit_gerente, anios),
      leerFicha(fondo.cuit_depositaria, anios)
    ]);
    var ger = pair[0];
    var dep = pair[1];
    await buscarEstatutos([[ger, fondo.cuit_gerente], [dep, fondo.cuit_depositaria]]);
    ger.nombre = ger.nombre || fondo.gerente || "";
    dep.nombre = dep.nombre || fondo.depositaria || "";
    var items = clasificar(ger, dep, fondo.denominacion_fci, docsFci);
    setStatus("Armando Excel…");
    var logoInfo = state.logoBuffer ? { buffer: state.logoBuffer, ext: state.logoExt } : null;
    var fileInput = $("logo-empresa").files[0];
    if (!logoInfo && fileInput) {
      logoInfo = await readLogoFile(fileInput);
      if (logoInfo) {
        state.logoBuffer = logoInfo.buffer;
        state.logoExt = logoInfo.ext;
      }
    }
    var wb = await generarExcel(fondo, ger, dep, items, logoInfo);
    state.lastWorkbook = wb;
    state.lastFilename = "Docs_CNV_" + fondo.numero_cnv + "_" + slugNombre(fondo.denominacion_fci) + "_" + todayYmd() + ".xlsx";
    renderPreview(fondo, ger, dep, items);
    $("btn-descargar-excel").disabled = false;
    var encontrados = items.filter(function (it) { return it[3] && it[3].length; }).length;
    setStatus("Listo: " + encontrados + "/" + items.length + " ítems con link. Descargá el Excel.", "ok");
  }

  async function runWithElegido(elegido) {
    $("btn-buscar").disabled = true;
    $("btn-descargar-excel").disabled = true;
    $("result-table-wrap").style.display = "none";
    try {
      var numero = soloDigitos($("numero-cnv").value);
      if (!numero) throw new Error("Ingresá el N° CNV del fondo.");
      var nombre = ($("nombre-fci").value || "").trim();
      var cache = loadFondosCache()[numero];
      var fondo;
      var overrideG = soloDigitos($("cuit-gerente").value);
      var overrideD = soloDigitos($("cuit-depositaria").value);
      if (!elegido && cache && cache.cuit_gerente && cache.cuit_depositaria && !overrideG && !overrideD) {
        fondo = cache;
        setStatus("Usando datos guardados de " + fondo.denominacion_fci + "…");
      } else {
        if (!nombre && !elegido) throw new Error("Ingresá la denominación aproximada del FCI.");
        fondo = await descubrirFondo(numero, nombre, elegido || null);
        saveFondoCache(fondo);
      }
      if (overrideG.length === 11) fondo.cuit_gerente = overrideG;
      if (overrideD.length === 11) fondo.cuit_depositaria = overrideD;
      await pipeline(fondo);
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      if (msg.indexOf("Elegí el fondo") === -1) setStatus("Error: " + msg, "error");
      else setStatus(msg);
    } finally {
      $("btn-buscar").disabled = false;
    }
  }

  $("btn-buscar").addEventListener("click", function () {
    $("match-wrap").style.display = "none";
    state.pendingMatches = null;
    runWithElegido(null);
  });

  $("form-cnv-fci").addEventListener("submit", function (e) {
    e.preventDefault();
    $("btn-buscar").click();
  });

  $("logo-empresa").addEventListener("change", async function () {
    var file = this.files && this.files[0];
    if (!file) {
      state.logoBuffer = null;
      state.logoExt = null;
      return;
    }
    var info = await readLogoFile(file);
    state.logoBuffer = info.buffer;
    state.logoExt = info.ext;
  });

  $("btn-descargar-excel").addEventListener("click", async function () {
    if (!state.lastWorkbook) return;
    var buf = await state.lastWorkbook.xlsx.writeBuffer();
    var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = state.lastFilename || "Docs_CNV.xlsx";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  });

  // Populate depositaria select from bundled/cached list (no CNV round-trip).
  ensureListas().catch(function () { /* ignore until user runs */ });
})();
