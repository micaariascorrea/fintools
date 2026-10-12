(function () {
  "use strict";

  var URL_FCI_DET = "https://www.cnv.gov.ar/SitioWeb/FondosComunesInversion/DetallesFCI/";
  var URL_FICHA = "https://www.cnv.gov.ar/SitioWeb/Empresas/Empresa/";

  var PALABRAS_GENERICAS = {
    FCI: 1, F: 1, C: 1, I: 1, FONDO: 1, COMUN: 1, DE: 1, DEL: 1, LA: 1, EL: 1, Y: 1,
    INVERSION: 1, INVERSIONES: 1, ABIERTO: 1, CERRADO: 1, EX: 1, S: 1, A: 1
  };
  var MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
  var MAX_POR_CATEGORIA = 1;
  var ANIO_MIN_ESTATUTO = 2005;
  var TRAMO_ESTATUTO = 5;
  // v3: planilla-first discovery (Gerente/Depositaria from local planilla, not CNV list scrape).
  var STORAGE_KEY = "allinarg_cnv_fci_fondos_v3";
  var STORAGE_EST = "allinarg_cnv_fci_estatutos_v1";
  var PLANILLA_JSON = "assets/data/planilla-fci.json";
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
    ["Depositaria", "d) Declaración de beneficiarios finales (≥10%)"],
    ["Nota", "Casilla de mail para CVSA"],
    ["Nota", "Firmas de apoderados"]
  ];

  var state = {
    planilla: null,
    pendingMatches: null,
    pendingFondo: null,
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

  function proxyTargetsHtml(url) {
    var enc = encodeURIComponent(url);
    return [
      "https://api.allorigins.win/raw?url=" + enc,
      "https://api.allorigins.win/get?url=" + enc,
      "https://api.codetabs.com/v1/proxy?quest=" + enc
    ];
  }

  function proxyTargets(url) {
    // Jina last for generic fetch; fund-detail organ text uses it explicitly.
    return proxyTargetsHtml(url).concat(["https://r.jina.ai/" + url]);
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

  async function fetchTextFromTargets(url, targets, attempt) {
    attempt = attempt || 0;
    var lastErr = null;
    try {
      return await raceProxies(targets.slice(0, Math.min(2, targets.length)));
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
      return fetchTextFromTargets(url, targets, attempt + 1);
    }
    var msg = lastErr && lastErr.message ? lastErr.message : "No se pudo consultar la CNV";
    if (/408|abort|timeout|Proxy timeout/i.test(msg)) {
      throw new Error("La CNV/proxy tardó demasiado (timeout). Probá de nuevo en unos segundos.");
    }
    throw lastErr || new Error("No se pudo consultar la CNV");
  }

  async function fetchText(url, attempt) {
    return fetchTextFromTargets(url, proxyTargets(url), attempt);
  }

  // HTML-only: required for empresa fichas so table rows parse into docs (Jina markdown skips <tr>).
  async function fetchTextHtml(url, attempt) {
    return fetchTextFromTargets(url, proxyTargetsHtml(url), attempt);
  }

  function parseDoc(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function pushDoc(docs, vistos, fecha, descripcion, documento, link, seccion) {
    if (!link || link.toLowerCase().indexOf("publicview") === -1) return;
    var clave = documento || link.toLowerCase();
    if (vistos[clave]) return;
    vistos[clave] = 1;
    docs.push({
      fecha: fecha || null,
      seccion: seccion || "",
      descripcion: descripcion || "",
      documento: documento || "",
      link: link
    });
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
      pushDoc(docs, vistos, fecha, descripcion, documento, href, seccion);
    });
    docs.sort(function (a, b) { return ordenReciente(b) - ordenReciente(a); });
    return docs;
  }

  // Parse Jina / markdown tables: | fecha | hora | descripción | doc | [link](publicview...) |
  function extraerDocsMarkdown(text) {
    var docs = [];
    var vistos = {};
    var re = /\|\s*(\d{1,2}\s+[a-zA-Z]{3}\w*\.?\s+\d{4})\s*\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*publicview[^|\n]*)\|/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      var fecha = parseFecha(m[1]);
      var cells = [m[2], m[3], m[4]].map(function (c) {
        return String(c || "").replace(/\\_/g, "_").replace(/\s+/g, " ").trim();
      });
      var descripcion = cells.reduce(function (best, c) { return c.length > best.length ? c : best; }, "");
      var documento = "";
      cells.forEach(function (c) {
        if (/^\d{6,8}$/.test(c)) documento = c;
      });
      var linkMatch = m[5].match(/https?:\/\/[^\s\)\]]+publicview[^\s\)\]]+/i);
      if (!linkMatch) continue;
      var link = linkMatch[0].replace(/\\/g, "");
      pushDoc(docs, vistos, fecha, descripcion, documento, link, "");
    }
    // Looser: any publicview URL near a fecha + descripción keywords
    if (!docs.length) {
      var loose = /((?:\d{1,2}\s+[a-zA-Z]{3}\w*\.?\s+\d{4})[\s\S]{0,240}?https?:\/\/[^\s\)\]]+publicview[^\s\)\]]+)/gi;
      var lm;
      while ((lm = loose.exec(text)) !== null) {
        var chunk = lm[1];
        var f = parseFecha(chunk);
        var hrefM = chunk.match(/https?:\/\/[^\s\)\]]+publicview[^\s\)\]]+/i);
        var docM = chunk.match(/\b(\d{6,8})\b/);
        if (!hrefM) continue;
        pushDoc(docs, vistos, f, chunk.replace(hrefM[0], "").replace(/\s+/g, " ").trim().slice(0, 220),
          docM ? docM[1] : "", hrefM[0].replace(/\\/g, ""), "");
      }
    }
    docs.sort(function (a, b) { return ordenReciente(b) - ordenReciente(a); });
    return docs;
  }

  function docsFromContent(content, url, cuit) {
    var doc = parseDoc(content);
    var htmlDocs = extraerDocs(doc);
    var mdDocs = extraerDocsMarkdown(content);
    var merged = [];
    var vistos = {};
    htmlDocs.concat(mdDocs).forEach(function (d) {
      pushDoc(merged, vistos, d.fecha, d.descripcion, d.documento, d.link, d.seccion);
    });
    var dig = soloDigitos(cuit);
    if (dig) {
      // Drop rows that explicitly belong to another CUIT (Jina pages sometimes mix feeds).
      merged = merged.filter(function (d) {
        var found = String(d.descripcion || "").match(/\d{11}/g) || [];
        if (!found.length) return true;
        return found.indexOf(dig) !== -1;
      });
    }
    merged.sort(function (a, b) { return ordenReciente(b) - ordenReciente(a); });
    var nombre = "";
    Array.prototype.forEach.call(doc.querySelectorAll("h1, h2"), function (h) {
      var t = (h.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || /CUIT/i.test(t) || norm(t).indexOf("EMPRESAS") !== -1 || t.length <= 5) return;
      if (!nombre) nombre = t.split(/\s{2,}|En Oferta P|Sociedades|Régimen|Regimen/)[0].trim();
    });
    if (!nombre) {
      var nm = String(content).match(/Title:\s*([^\n]+)/i);
      if (nm) nombre = nm[1].replace(/\s+/g, " ").trim();
    }
    nombre = nombre.replace(/\s*\([^)]*\)\s*$/, "");
    return { nombre: nombre, cuit: cuitFmt(cuit), url: url, docs: merged };
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
    // Covers SG/FCI NCP filings and bank NIIF balances published on CNV.
    var esBalance = d.indexOf("ESTADOS CONTABLES") !== -1
      && (d.indexOf("NORMA CONTABLE") !== -1 || d.indexOf("NIIF") !== -1 || d.indexOf("NCP") !== -1);
    return esBalance && d.indexOf("CONTROLADAS") === -1 && d.indexOf("RELAC.:") === -1;
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

  function fillDatalist(id, names) {
    var dl = $(id);
    if (!dl) return;
    dl.innerHTML = "";
    (names || []).forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = n;
      dl.appendChild(opt);
    });
  }

  async function loadPlanilla() {
    if (state.planilla && state.planilla.byCnv) return state.planilla;
    setStatus("Cargando planilla diaria FCI…");
    var res = await fetch(PLANILLA_JSON, { method: "GET" });
    if (!res.ok) throw new Error("No pude cargar la planilla FCI local (assets/data/planilla-fci.json).");
    var data = await res.json();
    if (!data || !data.byCnv) throw new Error("La planilla FCI local está vacía o inválida.");
    state.planilla = data;
    fillDatalist("lista-gerentes", data.gerentes || []);
    fillDatalist("lista-depositarias", data.depositarias || []);
    return data;
  }

  function cuitByOrganName(planilla, nombre, rol) {
    if (!nombre || !planilla) return null;
    var n = norm(nombre);
    var map = rol === "gerente" ? (planilla.cuitByGerenteName || {}) : (planilla.cuitByDepName || {});
    if (map[n]) return soloDigitos(map[n]);
    var bestK = "";
    var bestP = 0;
    Object.keys(map).forEach(function (k) {
      var p = puntaje(nombre, k);
      if (n.indexOf(k) !== -1 || k.indexOf(n) !== -1) p = Math.max(p, 0.95);
      if (p > bestP) { bestP = p; bestK = k; }
    });
    return bestP >= 0.85 ? soloDigitos(map[bestK]) : null;
  }

  function resolveFromPlanilla(numero, nombreHint) {
    var planilla = state.planilla;
    var entry = planilla.byCnv[numero];
    if (!entry) return null;
    return {
      numero_cnv: numero,
      denominacion_fci: entry.denominacion || nombreHint || "",
      gerente: entry.gerente || "",
      depositaria: entry.depositaria || "",
      cuit_gerente: soloDigitos(entry.cuit_gerente || "") || cuitByOrganName(planilla, entry.gerente, "gerente"),
      cuit_depositaria: soloDigitos(entry.cuit_depositaria || "") || cuitByOrganName(planilla, entry.depositaria, "depositaria"),
      from_planilla: true
    };
  }

  // Optional: map planilla denom → CNV website DetallesFCI id (for reglamento links only).
  function matchIdFciWeb(buscado, elegido) {
    var fondos = (state.planilla && state.planilla.fondosCnvWeb) || [];
    if (!fondos.length) return elegido || null;
    if (elegido) return elegido;
    if (!buscado) return null;
    var pick = elegirFondoAuto(buscado, fondos);
    if (!pick) return null;
    if (pick.needsPick) return pick;
    return pick;
  }

  async function fetchDocsFci(idFci) {
    if (!idFci) return [];
    try {
      var detHtml = await fetchText(URL_FCI_DET + idFci);
      return docsFromContent(detHtml, URL_FCI_DET + idFci, "").docs;
    } catch (e) {
      return [];
    }
  }

  async function descubrirFondo(numero, buscado, elegido) {
    var planilla = await loadPlanilla();
    var overrideG = soloDigitos($("cuit-gerente").value);
    var overrideD = soloDigitos($("cuit-depositaria").value);
    var manualGer = ($("nombre-gerente").value || "").trim();
    var manualDep = ($("nombre-depositaria").value || "").trim();

    var fondo = resolveFromPlanilla(numero, buscado);
    if (!fondo) {
      if (!manualGer || !manualDep) {
        throw new Error(
          "El N° CNV " + numero + " no está en la planilla diaria. Completá la denominación de Sociedad Gerente y Sociedad Depositaria para continuar."
        );
      }
      if (!buscado) {
        throw new Error("Ingresá también la denominación aproximada del FCI.");
      }
      fondo = {
        numero_cnv: numero,
        denominacion_fci: buscado,
        gerente: manualGer,
        depositaria: manualDep,
        cuit_gerente: cuitByOrganName(planilla, manualGer, "gerente"),
        cuit_depositaria: cuitByOrganName(planilla, manualDep, "depositaria"),
        from_planilla: false
      };
      setStatus("Fondo nuevo (fuera de planilla). Usando Gerente/Depositaria ingresados…");
    } else {
      setStatus("Planilla: " + fondo.denominacion_fci + " · Gerente " + fondo.gerente + " · Depositaria " + fondo.depositaria);
      if (manualGer) fondo.gerente = manualGer;
      if (manualDep) fondo.depositaria = manualDep;
      if (buscado && !fondo.denominacion_fci) fondo.denominacion_fci = buscado;
    }

    if (overrideG.length === 11) fondo.cuit_gerente = overrideG;
    if (overrideD.length === 11) fondo.cuit_depositaria = overrideD;
    if (!fondo.cuit_gerente) fondo.cuit_gerente = cuitByOrganName(planilla, fondo.gerente, "gerente");
    if (!fondo.cuit_depositaria) fondo.cuit_depositaria = cuitByOrganName(planilla, fondo.depositaria, "depositaria");

    // Resolve CNV web fund id only to pull reglamento / balances del FCI.
    var idPick = matchIdFciWeb(fondo.denominacion_fci || buscado, elegido || null);
    if (idPick && idPick.needsPick) {
      state.pendingMatches = { numero: numero, buscado: fondo.denominacion_fci || buscado, ranking: idPick.ranking };
      state.pendingFondo = fondo;
      showMatches(idPick.ranking);
      throw new Error("Elegí el fondo de la lista de coincidencias.");
    }
    if (idPick) {
      fondo.id_fci_cnv = idPick[0];
      if (!fondo.denominacion_fci) fondo.denominacion_fci = idPick[1];
      setStatus("Buscando documentación del fondo en la CNV…");
      fondo.docs_fci = await fetchDocsFci(fondo.id_fci_cnv);
    } else {
      fondo.docs_fci = [];
    }

    // CUIT Gerente from AIF title on fund docs if still missing.
    if (!fondo.cuit_gerente && fondo.docs_fci && fondo.docs_fci.length) {
      var fromDocs = await cuitPorDocumentos(fondo.gerente, fondo.docs_fci.map(function (d) { return d.link; }), 1);
      if (fromDocs[1]) {
        fondo.cuit_gerente = fromDocs[1];
        fondo.gerente = fondo.gerente || fromDocs[0] || "";
      }
    }

    if (!fondo.cuit_gerente || !fondo.cuit_depositaria) {
      var missing = [];
      if (!fondo.cuit_gerente) missing.push("CUIT Gerente (" + (fondo.gerente || "sin nombre") + ")");
      if (!fondo.cuit_depositaria) missing.push("CUIT Depositaria (" + (fondo.depositaria || "sin nombre") + ")");
      throw new Error(
        "Falta completar: " + missing.join(" · ") +
        ". Cargá el/los CUIT en los campos opcionales (o revisá las denominaciones) y volvé a generar."
      );
    }

    return fondo;
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

  async function leerFichaWindow(cuit, desde, hasta) {
    var params = "fdesde=" + encodeURIComponent(fmtDateCN(desde)) + "&fhasta=" + encodeURIComponent(fmtDateCN(hasta));
    var url = URL_FICHA + soloDigitos(cuit) + "?" + params;
    var htmlFicha = null;
    var mdFicha = null;
    await Promise.all([
      fetchTextHtml(url).then(function (t) { htmlFicha = docsFromContent(t, url, cuit); }).catch(function () {}),
      fetchViaProxy("https://r.jina.ai/" + url).then(function (t) { mdFicha = docsFromContent(t, url, cuit); }).catch(function () {})
    ]);
    if (htmlFicha && htmlFicha.docs.length) {
      if (mdFicha && mdFicha.docs.length) {
        var vistos = {};
        var merged = [];
        htmlFicha.docs.concat(mdFicha.docs).forEach(function (d) {
          pushDoc(merged, vistos, d.fecha, d.descripcion, d.documento, d.link, d.seccion);
        });
        merged.sort(function (a, b) { return ordenReciente(b) - ordenReciente(a); });
        htmlFicha.docs = merged;
        if (!htmlFicha.nombre && mdFicha.nombre) htmlFicha.nombre = mdFicha.nombre;
      }
      return htmlFicha;
    }
    if (mdFicha && mdFicha.docs.length) return mdFicha;
    if (htmlFicha) return htmlFicha;
    throw new Error("No se pudo leer la ficha CNV de " + cuitFmt(cuit));
  }

  async function leerFicha(cuit, anios, hasta) {
    hasta = hasta || new Date();
    // Prefer full window; shrink only if proxies choke on huge depositaria filings.
    var windows = [anios];
    if (anios > 2) windows.push(2);
    if (anios > 1) windows.push(1);
    var lastErr = null;
    for (var i = 0; i < windows.length; i++) {
      var desde = new Date(hasta.getTime());
      desde.setFullYear(desde.getFullYear() - windows[i]);
      try {
        var ficha = await leerFichaWindow(cuit, desde, hasta);
        if (ficha.docs.length) return ficha;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("No se pudo leer la ficha CNV");
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

  // Estatuto often sits outside the 3y window (e.g. 2022). One wider fetch per society if missing.
  async function buscarEstatutos(fichas) {
    var memoria = loadEstatutos();
    var pending = [];
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
        return;
      }
      pending.push(pair);
    });
    if (!pending.length) return;

    await mapPool(pending, 2, async function (pair) {
      var ficha = pair[0];
      var cuit = soloDigitos(pair[1]);
      var hasta = new Date();
      var desde = new Date(hasta.getTime());
      desde.setFullYear(ANIO_MIN_ESTATUTO);
      try {
        var wide = await leerFichaWindow(cuit, desde, hasta);
        var est = wide.docs.filter(esEstatuto).sort(function (a, b) {
          return ordenRecienteKey(b) - ordenRecienteKey(a);
        });
        if (est.length) {
          ficha.docs.push(est[0]);
          saveEstatuto(cuit, est[0]);
        } else {
          saveEstatuto(cuit, null);
        }
      } catch (e) {
        saveEstatuto(cuit, null);
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

    // Sheet shape matches the CNV docs Excel template (structure only; sample fund data cleared).
    var ws = wb.addWorksheet("Datos nota");
    await prepararHoja(ws, "Apertura de cuenta FCI  |  " + nombreFci, sub, [38, 72, 16], logo);
    var filas = [
      ["Denominación del FCI", nombreFci, ""],
      ["N° CNV del fondo", fondo.numero_cnv, ""],
      ["Denominación Sociedad Depositaria", dep.nombre || fondo.depositaria || "", dep.url],
      ["CUIT/CDI Sociedad Depositaria", dep.cuit, dep.url],
      ["Denominación Sociedad Gerente", ger.nombre || fondo.gerente || "", ger.url],
      ["CUIT/CDI Sociedad Gerente", ger.cuit, ger.url],
      ["Casilla de mail (se vincula en CVSA)", "PENDIENTE", ""]
    ];
    encabezado(ws, 6, ["Campo de la nota", "Dato", "Fuente"]);
    filas.forEach(function (row, idx) {
      var r = 7 + idx;
      ws.getRow(r).height = 20;
      var pend = row[1] === "PENDIENTE";
      celda(ws, r, 1, row[0], { font: font(10, true, GRIS_TXT) });
      celda(ws, r, 2, row[1], {
        font: font(11, true, pend ? ROJO : GRAFITO),
        fill: pend ? ACCENT_SUAVE : null
      });
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
      var manualGer = ($("nombre-gerente").value || "").trim();
      var manualDep = ($("nombre-depositaria").value || "").trim();
      var overrideG = soloDigitos($("cuit-gerente").value);
      var overrideD = soloDigitos($("cuit-depositaria").value);
      var cache = loadFondosCache()[numero];
      var fondo;
      // Reuse cache only when user isn't overriding organs / CUITs and we aren't picking a CNV match.
      var canUseCache = !elegido && cache && cache.cuit_gerente && cache.cuit_depositaria
        && !overrideG && !overrideD && !manualGer && !manualDep;
      if (canUseCache) {
        fondo = cache;
        setStatus("Usando datos guardados de " + fondo.denominacion_fci + "…");
      } else {
        // Nombre is optional when the N° is in the planilla; descubrirFondo asks only if needed.
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

  // Warm planilla + Gerente/Depositaria datalists (no CNV list scrape).
  loadPlanilla().catch(function () { /* ignore until user runs */ });
})();
