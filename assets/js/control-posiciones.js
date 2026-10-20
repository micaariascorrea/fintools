/**
 * Control de posiciones BYMA (SENEBI + pantalla) vs A3.
 * Port of Control_Posiciones_BYMA_A3 dashboard / Detalle_* sheets.
 * Everything runs in memory; nothing is persisted.
 */
(function (root) {
  "use strict";

  var BYMA_FIELDS = [
    { key: "id", header: "ID" },
    { key: "instrumento", header: "Instrumento" },
    { key: "plazo", header: "Tipo de vencimiento" },
    { key: "cantidad", header: "Cantidad" },
    { key: "monto", header: "Monto" },
    { key: "estado", header: "Estado operacion" },
    { key: "vendedor", header: "Vendedor" },
    { key: "carteraVendedor", header: "Cartera vendedor" },
    { key: "comprador", header: "Comprador" },
    { key: "carteraComprador", header: "Cartera comprador" }
  ];

  var A3_FIELDS = [
    { key: "secuencia", header: "Número de secuencia" },
    { key: "propia", header: "Propia" },
    { key: "posicion", header: "Posicion" },
    { key: "tipo", header: "Tipo" },
    { key: "cantidad", header: "Cantidad" },
    { key: "total", header: "Total" },
    { key: "plazo", header: "Plazo" },
    { key: "estado", header: "Estado" }
  ];

  var PANTALLA_FIELDS = [
    { key: "tradeId", header: "Numeric Trade ID" },
    { key: "clientId", header: "Client ID" },
    { key: "symbol", header: "Symbol" },
    { key: "side", header: "Side" },
    { key: "executedSize", header: "Executed Size" },
    { key: "turnover", header: "Turnover" },
    { key: "execType", header: "Exec Type" }
  ];

  var HEADER_ALIASES = {
    "Estado operacion": ["Estado operación", "Estado Operacion"],
    "Número de secuencia": ["Numero de secuencia", "Nro de secuencia", "N° de secuencia"],
    "Posicion": ["Posición"],
    "Numeric Trade ID": ["NumericTradeID", "Trade ID"]
  };

  function defaultConfig() {
    return {
      agent: "",
      bymaEstado: "Operada",
      a3Estado: "Activa",
      a3SoloPropia: true,
      tolerancia: 0,
      pantallaExecType: "Trade",
      caucionSegmento: "U",
      ownAccounts: [],
      equivalencias: { TXS7X: "TZXS7", S2N6X: "S13N6" }
    };
  }

  function stripAccents(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function normHeader(s) {
    return stripAccents(String(s || "").replace(/\s+/g, " ").trim()).toLowerCase();
  }

  function findCol(headers, name) {
    var wanted = String(name);
    var i;
    for (i = 0; i < headers.length; i++) {
      if (String(headers[i]).trim() === wanted) return headers[i];
    }
    var aliases = HEADER_ALIASES[wanted] || [];
    for (i = 0; i < aliases.length; i++) {
      for (var j = 0; j < headers.length; j++) {
        if (String(headers[j]).trim() === aliases[i]) return headers[j];
      }
    }
    var target = normHeader(wanted);
    for (i = 0; i < headers.length; i++) {
      if (normHeader(headers[i]) === target) return headers[i];
    }
    for (i = 0; i < aliases.length; i++) {
      var alt = normHeader(aliases[i]);
      for (var k = 0; k < headers.length; k++) {
        if (normHeader(headers[k]) === alt) return headers[k];
      }
    }
    return null;
  }

  function mapCols(headers, fields) {
    var map = {};
    var missing = [];
    for (var i = 0; i < fields.length; i++) {
      var found = findCol(headers, fields[i].header);
      map[fields[i].key] = found;
      if (!found) missing.push(fields[i].header);
    }
    return { map: map, missing: missing };
  }

  function txt(val) {
    if (val === null || val === undefined) return "";
    return String(val).trim();
  }

  function parseNumber(val) {
    if (val === null || val === undefined || val === "") return 0;
    if (typeof val === "number") return isFinite(val) ? val : 0;
    if (typeof val === "boolean") return val ? 1 : 0;
    var s = String(val).trim();
    if (!s) return 0;
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      var n = parseFloat(s);
      return isFinite(n) ? n : 0;
    }
    var es = s.replace(/\./g, "").replace(",", ".");
    var n2 = parseFloat(es);
    return isFinite(n2) ? n2 : 0;
  }

  function unifyTicker(code, equivalencias) {
    var c = txt(code);
    if (!c) return "";
    if (equivalencias && Object.prototype.hasOwnProperty.call(equivalencias, c)) {
      return txt(equivalencias[c]) || c;
    }
    return c;
  }

  function ownSet(list) {
    var set = {};
    (list || []).forEach(function (id) {
      var k = txt(id);
      if (k) set[k] = true;
    });
    return set;
  }

  function classifyBymaPlazo(raw) {
    var u = txt(raw).toUpperCase();
    if (u === "CI") return "CI";
    if (u === "24HS") return "24HS";
    return "OTRO";
  }

  function classifyA3Plazo(raw) {
    var n = parseNumber(raw);
    if (n === 0) return "CI";
    if (n === 1) return "24HS";
    return "OTRO";
  }

  function parsePantallaSymbol(symbol) {
    var parts = txt(symbol).split("-");
    var tickerRaw = parts[0] || "";
    var tok2 = parts.length > 1 ? parts[1] : "";
    var v2 = tok2 === "" ? NaN : Number(tok2);
    if (!isFinite(v2) && tok2) v2 = parseNumber(tok2);
    var plazo = v2 === 1 ? "CI" : v2 === 2 ? "24HS" : "OTRO";
    return {
      tickerRaw: tickerRaw,
      plazo: plazo,
      segmento: parts.length > 2 ? parts[2] : "",
      moneda: parts.length > 4 ? parts[4] : ""
    };
  }

  function a3Instrument(posicion) {
    var p = txt(posicion);
    if (!p) return "";
    var sp = p.indexOf(" ");
    return sp === -1 ? p : p.slice(0, sp);
  }

  function processByma(rows, headers, config) {
    var cols = mapCols(headers || [], BYMA_FIELDS);
    var details = [];
    var agent = txt(config.agent);
    var estadoOk = txt(config.bymaEstado).toUpperCase();
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      var inst = txt(cols.map.instrumento ? row[cols.map.instrumento] : "");
      if (!inst) continue;
      var estado = txt(cols.map.estado ? row[cols.map.estado] : "");
      var plazo = classifyBymaPlazo(cols.map.plazo ? row[cols.map.plazo] : "");
      var qty = parseNumber(cols.map.cantidad ? row[cols.map.cantidad] : 0);
      var monto = parseNumber(cols.map.monto ? row[cols.map.monto] : 0);
      var vendedor = txt(cols.map.vendedor ? row[cols.map.vendedor] : "");
      var carteraV = txt(cols.map.carteraVendedor ? row[cols.map.carteraVendedor] : "");
      var comprador = txt(cols.map.comprador ? row[cols.map.comprador] : "");
      var carteraC = txt(cols.map.carteraComprador ? row[cols.map.carteraComprador] : "");
      var compra = comprador === agent && carteraC !== "" && carteraC !== "-" ? 1 : 0;
      var venta = vendedor === agent && carteraV !== "" && carteraV !== "-" ? 1 : 0;
      var incluida = estado.toUpperCase() === estadoOk && compra + venta > 0 ? 1 : 0;
      var ticker = unifyTicker(inst, config.equivalencias);
      var motivo;
      if (estado.toUpperCase() !== estadoOk) motivo = "Excluida: estado " + estado;
      else if (compra + venta === 0) motivo = "Excluida: sin cartera propia";
      else motivo = "Incluida";
      details.push({
        origen: "SENEBI",
        id: txt(cols.map.id ? row[cols.map.id] : ""),
        instrumento: inst,
        ticker: ticker,
        plazo: plazo,
        estado: estado,
        cantidad: qty,
        monto: monto,
        compra: compra,
        venta: venta,
        incluida: incluida,
        vnCompra: incluida * compra * qty,
        vnVenta: incluida * venta * qty,
        flujoCompra: incluida * compra * monto,
        flujoVenta: incluida * venta * monto,
        motivo: motivo,
        xSinEquiv: incluida && inst.slice(-1) === "X" && ticker === inst ? 1 : 0
      });
    }
    return { details: details, missing: cols.missing };
  }

  function processA3(rows, headers, config) {
    var cols = mapCols(headers || [], A3_FIELDS);
    var details = [];
    var estadoOk = txt(config.a3Estado).toUpperCase();
    var soloPropia = config.a3SoloPropia !== false;
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      var pos = txt(cols.map.posicion ? row[cols.map.posicion] : "");
      if (!pos) continue;
      var inst = a3Instrument(pos);
      var ticker = unifyTicker(inst, config.equivalencias);
      var plazo = classifyA3Plazo(cols.map.plazo ? row[cols.map.plazo] : "");
      var tipo = txt(cols.map.tipo ? row[cols.map.tipo] : "");
      var estado = txt(cols.map.estado ? row[cols.map.estado] : "");
      var propia = txt(cols.map.propia ? row[cols.map.propia] : "");
      var qty = parseNumber(cols.map.cantidad ? row[cols.map.cantidad] : 0);
      var total = parseNumber(cols.map.total ? row[cols.map.total] : 0);
      var tipoU = tipo.toUpperCase();
      var tipoOk = tipoU === "COMPRA" || tipoU === "VENTA";
      var estadoOkRow = estado.toUpperCase() === estadoOk;
      var propiaOk = !soloPropia || propia.toUpperCase() === "SI";
      var incluida = tipoOk && estadoOkRow && propiaOk ? 1 : 0;
      var motivo;
      if (!tipoOk) motivo = "Excluida: " + tipo + " (no es compra/venta)";
      else if (!estadoOkRow) motivo = "Excluida: estado " + estado;
      else if (!incluida) motivo = "Excluida: no es propia";
      else motivo = "Incluida";
      details.push({
        origen: "A3",
        id: txt(cols.map.secuencia ? row[cols.map.secuencia] : ""),
        instrumento: inst,
        posicion: pos,
        ticker: ticker,
        plazo: plazo,
        tipo: tipo,
        estado: estado,
        propia: propia,
        cantidad: qty,
        monto: total,
        incluida: incluida,
        vnCompra: tipoU === "COMPRA" ? incluida * qty : 0,
        vnVenta: tipoU === "VENTA" ? incluida * qty : 0,
        flujoCompra: tipoU === "COMPRA" ? incluida * total : 0,
        flujoVenta: tipoU === "VENTA" ? incluida * total : 0,
        motivo: motivo
      });
    }
    return { details: details, missing: cols.missing };
  }

  function processPantalla(rows, headers, config) {
    var cols = mapCols(headers || [], PANTALLA_FIELDS);
    var details = [];
    var execOk = txt(config.pantallaExecType).toUpperCase();
    var segExcl = txt(config.caucionSegmento).toUpperCase();
    var own = ownSet(config.ownAccounts);
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      var symbol = txt(cols.map.symbol ? row[cols.map.symbol] : "");
      if (!symbol) continue;
      var parsed = parsePantallaSymbol(symbol);
      var ticker = unifyTicker(parsed.tickerRaw, config.equivalencias);
      var side = txt(cols.map.side ? row[cols.map.side] : "").toUpperCase();
      var execType = txt(cols.map.execType ? row[cols.map.execType] : "");
      var client = txt(cols.map.clientId ? row[cols.map.clientId] : "");
      var size = parseNumber(cols.map.executedSize ? row[cols.map.executedSize] : 0);
      var turnover = parseNumber(cols.map.turnover ? row[cols.map.turnover] : 0);
      var sideOk = side === "BUY" || side === "SELL";
      var execOkRow = execType.toUpperCase() === execOk;
      var notCaucion = parsed.segmento.toUpperCase() !== segExcl;
      var propia = !!own[client];
      var incluida = sideOk && execOkRow && notCaucion && propia ? 1 : 0;
      var motivo;
      if (!notCaucion) motivo = "Excluida: caución";
      else if (!propia) motivo = "Excluida: comitente " + client + " no es propia";
      else if (!execOkRow) motivo = "Excluida: exec type " + execType;
      else if (!incluida) motivo = "Excluida: side " + side;
      else motivo = "Incluida";
      var ars = parsed.moneda.toUpperCase() === "ARS";
      details.push({
        origen: "PANTALLA",
        id: txt(cols.map.tradeId ? row[cols.map.tradeId] : ""),
        instrumento: parsed.tickerRaw,
        symbol: symbol,
        ticker: ticker,
        plazo: parsed.plazo,
        segmento: parsed.segmento,
        moneda: parsed.moneda,
        side: side,
        execType: execType,
        clientId: client,
        cantidad: size,
        monto: turnover,
        incluida: incluida,
        vnCompra: side === "BUY" ? incluida * size : 0,
        vnVenta: side === "SELL" ? incluida * size : 0,
        flujoCompra: side === "BUY" && ars ? incluida * turnover : 0,
        flujoVenta: side === "SELL" && ars ? incluida * turnover : 0,
        motivo: motivo
      });
    }
    return { details: details, missing: cols.missing };
  }

  function firstSeenTickers(byma, a3, pant) {
    var seen = {};
    var out = [];
    function add(list) {
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        if (!d.incluida || !d.ticker || seen[d.ticker]) continue;
        seen[d.ticker] = true;
        out.push(d.ticker);
      }
    }
    add(byma);
    add(a3);
    add(pant);
    return out;
  }

  function sumPair(details, ticker, plazo) {
    var c = 0;
    var v = 0;
    var fc = 0;
    var fv = 0;
    for (var i = 0; i < details.length; i++) {
      var d = details[i];
      if (d.ticker !== ticker || d.plazo !== plazo) continue;
      c += d.vnCompra;
      v += d.vnVenta;
      fc += d.flujoCompra;
      fv += d.flujoVenta;
    }
    return { compra: c, venta: v, flujoCompra: fc, flujoVenta: fv };
  }

  function classifyEstado(netoCi, neto24, netoOtros, tolerancia) {
    var tol = isFinite(tolerancia) ? Math.abs(tolerancia) : 0;
    var netoTotal = netoCi + neto24 + netoOtros;
    if (Math.abs(netoCi) <= tol && Math.abs(neto24) <= tol && Math.abs(netoOtros) <= tol) return "OK";
    if (Math.abs(netoTotal) <= tol) return "REVISAR PLAZOS";
    return "DESCALCE";
  }

  function buildDashboard(byma, a3, pant, config) {
    var tickers = firstSeenTickers(byma, a3, pant);
    var rows = [];
    var descalces = 0;
    var revisar = 0;
    var i;
    for (i = 0; i < tickers.length; i++) {
      var t = tickers[i];
      var sCi = sumPair(byma, t, "CI");
      var s24 = sumPair(byma, t, "24HS");
      var pCi = sumPair(pant, t, "CI");
      var p24 = sumPair(pant, t, "24HS");
      var aCi = sumPair(a3, t, "CI");
      var a24 = sumPair(a3, t, "24HS");
      var sO = sumPair(byma, t, "OTRO");
      var pO = sumPair(pant, t, "OTRO");
      var aO = sumPair(a3, t, "OTRO");
      var netoCi = sCi.compra - sCi.venta + pCi.compra - pCi.venta + aCi.compra - aCi.venta;
      var neto24 = s24.compra - s24.venta + p24.compra - p24.venta + a24.compra - a24.venta;
      var netoOtros = sO.compra - sO.venta + pO.compra - pO.venta + aO.compra - aO.venta;
      var netoTotal = netoCi + neto24 + netoOtros;
      var flujoCi =
        sCi.flujoVenta - sCi.flujoCompra + pCi.flujoVenta - pCi.flujoCompra + aCi.flujoVenta - aCi.flujoCompra;
      var flujo24 =
        s24.flujoVenta - s24.flujoCompra + p24.flujoVenta - p24.flujoCompra + a24.flujoVenta - a24.flujoCompra;
      var estado = classifyEstado(netoCi, neto24, netoOtros, config.tolerancia);
      if (estado === "DESCALCE") descalces++;
      if (estado === "REVISAR PLAZOS") revisar++;
      rows.push({
        ticker: t,
        senebiCiCompra: sCi.compra,
        senebiCiVenta: sCi.venta,
        senebi24Compra: s24.compra,
        senebi24Venta: s24.venta,
        pantCiCompra: pCi.compra,
        pantCiVenta: pCi.venta,
        pant24Compra: p24.compra,
        pant24Venta: p24.venta,
        a3CiCompra: aCi.compra,
        a3CiVenta: aCi.venta,
        a3_24Compra: a24.compra,
        a3_24Venta: a24.venta,
        netoCi: netoCi,
        neto24: neto24,
        netoOtros: netoOtros,
        netoTotal: netoTotal,
        flujoCi: flujoCi,
        flujo24: flujo24,
        estado: estado
      });
    }
    function included(list) {
      var n = 0;
      for (var j = 0; j < list.length; j++) if (list[j].incluida) n++;
      return n;
    }
    return {
      rows: rows,
      kpis: {
        tickers: rows.length,
        descalces: descalces,
        revisar: revisar,
        opsSenebi: included(byma),
        opsPantalla: included(pant),
        opsA3: included(a3)
      }
    };
  }

  function parseCSVLine(line, delim) {
    var out = [];
    var i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        var cell = "";
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          cell += line[i++];
        }
        out.push(cell);
        if (line[i] === delim) i++;
      } else {
        var next = line.indexOf(delim, i);
        if (next === -1) {
          out.push(line.slice(i).trim());
          break;
        }
        out.push(line.slice(i, next).trim());
        i = next + 1;
      }
    }
    return out;
  }

  function parseCSV(text) {
    text = String(text || "").replace(/^\uFEFF/, "");
    var lines = text.split(/\r?\n/).filter(function (l) {
      return l.length > 0;
    });
    if (!lines.length) return { headers: [], rows: [], mode: "VACIO" };
    var first = lines[0];
    var delim = first.indexOf(";") >= 0 && first.split(";").length > first.split(",").length ? ";" : ",";
    var headers = parseCSVLine(first, delim).map(function (h) {
      return String(h).trim();
    });
    var rows = [];
    for (var r = 1; r < lines.length; r++) {
      var cells = parseCSVLine(lines[r], delim);
      var obj = {};
      var empty = true;
      for (var c = 0; c < headers.length; c++) {
        var val = cells[c] !== undefined ? String(cells[c]).trim() : "";
        obj[headers[c]] = val;
        if (val) empty = false;
      }
      if (!empty) rows.push(obj);
    }
    return { headers: headers, rows: rows, mode: "COL" };
  }

  function aoaToTable(aoa) {
    if (!aoa || !aoa.length) return { headers: [], rows: [], mode: "VACIO" };
    var headerRow = aoa[0] || [];
    var headers = [];
    var i;
    for (i = 0; i < headerRow.length; i++) {
      headers.push(txt(headerRow[i]));
    }
    while (headers.length && headers[headers.length - 1] === "") headers.pop();
    var rows = [];
    for (var r = 1; r < aoa.length; r++) {
      var line = aoa[r] || [];
      var obj = {};
      var empty = true;
      for (i = 0; i < headers.length; i++) {
        if (!headers[i]) continue;
        var val = line[i];
        if (val !== null && val !== undefined && String(val).trim() !== "") empty = false;
        obj[headers[i]] = val;
      }
      if (!empty) rows.push(obj);
    }
    return { headers: headers, rows: rows, mode: "COL" };
  }

  function isRawPantallaAoa(aoa) {
    if (!aoa || !aoa.length) return false;
    var row0 = aoa[0] || [];
    var filled = 0;
    for (var i = 0; i < row0.length; i++) {
      if (txt(row0[i])) filled++;
    }
    if (filled >= 3 && findCol(row0.map(txt), "Symbol")) return false;
    var a = txt(row0[0]);
    return /Symbol/i.test(a) && /Client ID/i.test(a);
  }

  function tableFromAoa(aoa, kind) {
    if (kind === "pantalla" && isRawPantallaAoa(aoa)) {
      var text = (aoa || [])
        .map(function (row) {
          return txt(row && row[0]);
        })
        .filter(Boolean)
        .join("\n");
      var parsed = parseCSV(text);
      parsed.mode = "RAW";
      return parsed;
    }
    return aoaToTable(aoa);
  }

  function runControl(inputs, config) {
    config = config || defaultConfig();
    var bymaIn = inputs.byma || { headers: [], rows: [] };
    var a3In = inputs.a3 || { headers: [], rows: [] };
    var pantIn = inputs.pantalla || { headers: [], rows: [] };
    var byma = processByma(bymaIn.rows, bymaIn.headers, config);
    var a3 = processA3(a3In.rows, a3In.headers, config);
    var pant = processPantalla(pantIn.rows, pantIn.headers, config);
    var dash = buildDashboard(byma.details, a3.details, pant.details, config);
    return {
      config: config,
      headerCheck: {
        byma: byma.missing,
        a3: a3.missing,
        pantalla: pant.missing,
        pantallaMode: pantIn.mode || "VACIO"
      },
      byma: byma.details,
      a3: a3.details,
      pantalla: pant.details,
      dashboard: dash.rows,
      kpis: dash.kpis
    };
  }

  var api = {
    BYMA_FIELDS: BYMA_FIELDS,
    A3_FIELDS: A3_FIELDS,
    PANTALLA_FIELDS: PANTALLA_FIELDS,
    defaultConfig: defaultConfig,
    parseNumber: parseNumber,
    findCol: findCol,
    unifyTicker: unifyTicker,
    parsePantallaSymbol: parsePantallaSymbol,
    parseCSV: parseCSV,
    tableFromAoa: tableFromAoa,
    processByma: processByma,
    processA3: processA3,
    processPantalla: processPantalla,
    buildDashboard: buildDashboard,
    runControl: runControl
  };

  root.ControlPosiciones = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this);

(function () {
  "use strict";
  if (typeof document === "undefined") return;
  if (!document.getElementById("form-control-posiciones")) return;

  var CP = window.ControlPosiciones;
  var lastResult = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatVn(num) {
    if (!isFinite(num) || num === 0) return "-";
    return Math.round(num).toLocaleString("es-AR");
  }

  function formatMoney(num) {
    if (!isFinite(num) || num === 0) return "-";
    return Number(num).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function setStatus(msg, kind) {
    var el = $("resultado");
    if (!el) return;
    el.style.display = msg ? "block" : "none";
    el.textContent = msg;
    el.classList.remove("empty", "error", "warning", "has-result");
    if (kind === "error") el.classList.add("error");
    else if (kind === "warning") el.classList.add("warning");
    else if (kind === "ok") el.classList.add("has-result");
    else if (!msg) el.classList.add("empty");
  }

  function parseOwnAccounts(text) {
    return String(text || "")
      .split(/[\s,;]+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function readEquivalencias() {
    var map = {};
    var tbody = $("equiv-body");
    if (!tbody) return map;
    var rows = tbody.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var inputs = rows[i].querySelectorAll("input");
      var from = inputs[0] ? inputs[0].value.trim() : "";
      var to = inputs[1] ? inputs[1].value.trim() : "";
      if (from && to) map[from] = to;
    }
    return map;
  }

  function addEquivRow(from, to) {
    var tbody = $("equiv-body");
    if (!tbody) return;
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><input type="text" value="' +
      escapeHtml(from || "") +
      '" placeholder="TXS7X" autocomplete="off"></td>' +
      '<td><input type="text" value="' +
      escapeHtml(to || "") +
      '" placeholder="TZXS7" autocomplete="off"></td>' +
      '<td><button type="button" class="btn-row-remove" aria-label="Quitar">×</button></td>';
    tr.querySelector(".btn-row-remove").addEventListener("click", function () {
      tr.remove();
    });
    tbody.appendChild(tr);
  }

  function readConfig() {
    var cfg = CP.defaultConfig();
    cfg.agent = ($("nro-agente") && $("nro-agente").value.trim()) || "";
    cfg.ownAccounts = parseOwnAccounts($("comitentes") ? $("comitentes").value : "");
    cfg.tolerancia = 0;
    cfg.a3SoloPropia = true;
    cfg.equivalencias = readEquivalencias();
    return cfg;
  }

  function readWorkbookAoa(buffer) {
    var XLSX = window.XLSX;
    if (!XLSX) throw new Error("No se pudo cargar la librería de Excel.");
    var wb = XLSX.read(buffer, { type: "array", raw: false });
    var name = wb.SheetNames && wb.SheetNames[0];
    if (!name) return [];
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
  }

  function readFileAsTable(file, kind) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        resolve({ headers: [], rows: [], mode: "VACIO" });
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("No se pudo leer " + file.name));
      };
      reader.onload = function () {
        try {
          var buf = new Uint8Array(reader.result);
          var name = (file.name || "").toLowerCase();
          if (name.endsWith(".csv") || name.endsWith(".txt")) {
            var text = new TextDecoder("utf-8").decode(buf);
            if (text.indexOf("\uFFFD") !== -1) {
              text = new TextDecoder("latin1").decode(buf);
            }
            var parsed = CP.parseCSV(text);
            if (kind === "pantalla") parsed.mode = parsed.headers.length ? "COL" : "VACIO";
            resolve(parsed);
            return;
          }
          var aoa = readWorkbookAoa(buf);
          resolve(CP.tableFromAoa(aoa, kind));
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function headerBadges(missing, loaded) {
    if (!loaded) return "sin archivo";
    if (!missing.length) return "OK";
    return "FALTA: " + missing.join(", ");
  }

  function estadoClass(estado) {
    if (estado === "OK") return "estado-ok";
    if (estado === "REVISAR PLAZOS") return "estado-rev";
    if (estado === "DESCALCE") return "estado-des";
    return "";
  }

  function vnCell(n) {
    var cls = Math.abs(n) > 0 ? ' class="neto-off"' : "";
    return "<td" + cls + ">" + formatVn(n) + "</td>";
  }

  function flujoCell(n) {
    var cls = n > 0 ? "flujo-pos" : n < 0 ? "flujo-neg" : "";
    return '<td class="' + cls + '">' + formatMoney(n) + "</td>";
  }

  function kpiCard(label, value, extraClass) {
    return (
      '<div class="dash-kpi' +
      (extraClass ? " " + extraClass : "") +
      '"><span class="dash-kpi-label">' +
      escapeHtml(label) +
      '</span><span class="dash-kpi-value">' +
      escapeHtml(String(value)) +
      "</span></div>"
    );
  }

  function renderDashboard(rows, kpis) {
    var wrap = $("result-table-wrap");
    var html =
      '<div class="dash">' +
      '<h3 class="dash-title">Control de posiciones en títulos</h3>' +
      '<div class="dash-kpis">' +
      kpiCard("Tickers controlados", kpis.tickers) +
      kpiCard("Descalces", kpis.descalces, kpis.descalces > 0 ? "alert-red" : "") +
      kpiCard("Revisar plazos", kpis.revisar, kpis.revisar > 0 ? "alert-amber" : "") +
      kpiCard("Ops SENEBI incluidas", kpis.opsSenebi) +
      kpiCard("Ops pantalla incluidas", kpis.opsPantalla) +
      kpiCard("Ops A3 incluidas", kpis.opsA3) +
      "</div>" +
      '<div class="dash-table-wrap">' +
      '<table class="dash-table" aria-label="Dashboard de posiciones">' +
      "<thead>" +
      "<tr>" +
      '<th class="g-plain col-num" rowspan="2">#</th>' +
      '<th class="g-plain col-ticker txt" rowspan="2">Ticker</th>' +
      '<th class="g-senebi" colspan="4">BYMA · SENEBI</th>' +
      '<th class="g-pant" colspan="4">BYMA · PANTALLA</th>' +
      '<th class="g-a3" colspan="4">A3</th>' +
      '<th class="g-neto" colspan="4">NETO VN</th>' +
      '<th class="g-flujo" colspan="2">FLUJO $</th>' +
      '<th class="g-plain" rowspan="2">Estado</th>' +
      "</tr>" +
      "<tr>" +
      '<th class="h-senebi">CI<br>Compra</th><th class="h-senebi">CI<br>Venta</th><th class="h-senebi">24HS<br>Compra</th><th class="h-senebi">24HS<br>Venta</th>' +
      '<th class="h-pant">CI<br>Compra</th><th class="h-pant">CI<br>Venta</th><th class="h-pant">24HS<br>Compra</th><th class="h-pant">24HS<br>Venta</th>' +
      '<th class="h-a3">CI<br>Compra</th><th class="h-a3">CI<br>Venta</th><th class="h-a3">24HS<br>Compra</th><th class="h-a3">24HS<br>Venta</th>' +
      '<th class="h-neto">Neto<br>CI</th><th class="h-neto">Neto<br>24HS</th><th class="h-neto">Neto<br>otros plazos</th><th class="h-neto">Neto<br>total</th>' +
      '<th class="h-flujo">Flujo<br>CI</th><th class="h-flujo">Flujo<br>24HS</th>' +
      "</tr></thead><tbody>";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      html +=
        "<tr>" +
        '<td class="col-num">' +
        (i + 1) +
        "</td>" +
        '<td class="col-ticker txt"><strong>' +
        escapeHtml(r.ticker) +
        "</strong></td>" +
        "<td>" + formatVn(r.senebiCiCompra) + "</td>" +
        "<td>" + formatVn(r.senebiCiVenta) + "</td>" +
        "<td>" + formatVn(r.senebi24Compra) + "</td>" +
        "<td>" + formatVn(r.senebi24Venta) + "</td>" +
        "<td>" + formatVn(r.pantCiCompra) + "</td>" +
        "<td>" + formatVn(r.pantCiVenta) + "</td>" +
        "<td>" + formatVn(r.pant24Compra) + "</td>" +
        "<td>" + formatVn(r.pant24Venta) + "</td>" +
        "<td>" + formatVn(r.a3CiCompra) + "</td>" +
        "<td>" + formatVn(r.a3CiVenta) + "</td>" +
        "<td>" + formatVn(r.a3_24Compra) + "</td>" +
        "<td>" + formatVn(r.a3_24Venta) + "</td>" +
        vnCell(r.netoCi) +
        vnCell(r.neto24) +
        vnCell(r.netoOtros) +
        vnCell(r.netoTotal) +
        flujoCell(r.flujoCi) +
        flujoCell(r.flujo24) +
        '<td class="' +
        estadoClass(r.estado) +
        '">' +
        escapeHtml(r.estado) +
        "</td>" +
        "</tr>";
    }
    html += "</tbody></table></div></div>";
    wrap.innerHTML = html;
    wrap.style.display = "";
  }

  function xmlEsc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ssCell(opts) {
    var attrs = ' ss:StyleID="' + (opts.style || "sBase") + '"';
    if (opts.mergeAcross) attrs += ' ss:MergeAcross="' + opts.mergeAcross + '"';
    if (opts.mergeDown) attrs += ' ss:MergeDown="' + opts.mergeDown + '"';
    if (opts.index) attrs += ' ss:Index="' + opts.index + '"';
    if (opts.value === null || opts.value === undefined || opts.value === "") {
      return "<Cell" + attrs + "/>";
    }
    var type = opts.type || "String";
    var val = type === "Number" ? String(opts.value) : xmlEsc(opts.value);
    return "<Cell" + attrs + '><Data ss:Type="' + type + '">' + val + "</Data></Cell>";
  }

  function ssRow(height, cells) {
    var h = height ? ' ss:Height="' + height + '"' : "";
    return "<Row" + h + ">" + cells.join("") + "</Row>";
  }

  function vnStyle(n) {
    return Math.abs(n) > 0 ? "sNetoOff" : "sVn";
  }

  function flujoStyle(n) {
    if (n > 0) return "sFlujoPos";
    if (n < 0) return "sFlujoNeg";
    return "sMoney";
  }

  function estadoStyle(estado) {
    if (estado === "OK") return "sOk";
    if (estado === "REVISAR PLAZOS") return "sRev";
    if (estado === "DESCALCE") return "sDes";
    return "sBase";
  }

  function exportExcel() {
    if (!lastResult || !lastResult.dashboard.length) {
      setStatus("No hay resultado para exportar. Procesá los archivos primero.", "error");
      return;
    }
    var k = lastResult.kpis;
    var rows = lastResult.dashboard;
    var styles =
      '<Styles>' +
      '<Style ss:ID="sBase"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#E6EDF3"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Right"/></Style>' +
      '<Style ss:ID="sTitle"><Font ss:FontName="Segoe UI" ss:Size="16" ss:Color="#E6EDF3" ss:Bold="1"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Left"/></Style>' +
      '<Style ss:ID="sKpiL"><Font ss:FontName="Segoe UI" ss:Size="8" ss:Color="#8B949E" ss:Bold="1"/><Interior ss:Color="#161B22" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Left"/></Style>' +
      '<Style ss:ID="sKpiV"><Font ss:FontName="Segoe UI" ss:Size="18" ss:Color="#E6EDF3" ss:Bold="1"/><Interior ss:Color="#161B22" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Left"/></Style>' +
      '<Style ss:ID="sKpiRed"><Font ss:FontName="Segoe UI" ss:Size="18" ss:Color="#F85149" ss:Bold="1"/><Interior ss:Color="#161B22" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Left"/></Style>' +
      '<Style ss:ID="sKpiAmb"><Font ss:FontName="Segoe UI" ss:Size="18" ss:Color="#D29922" ss:Bold="1"/><Interior ss:Color="#161B22" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Left"/></Style>' +
      '<Style ss:ID="sHead"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#8B949E" ss:Bold="1"/><Interior ss:Color="#161B22" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/></Style>' +
      '<Style ss:ID="sSen"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#58A6FF" ss:Bold="1"/><Interior ss:Color="#0F2440" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/></Style>' +
      '<Style ss:ID="sPan"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#74ACDF" ss:Bold="1"/><Interior ss:Color="#13263A" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/></Style>' +
      '<Style ss:ID="sA3"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#F6B40E" ss:Bold="1"/><Interior ss:Color="#2E2408" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/></Style>' +
      '<Style ss:ID="sNeto"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#E6EDF3" ss:Bold="1"/><Interior ss:Color="#1C2333" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/></Style>' +
      '<Style ss:ID="sFlujo"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#8B949E" ss:Bold="1"/><Interior ss:Color="#1B1F26" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/></Style>' +
      '<Style ss:ID="sTxt"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#E6EDF3" ss:Bold="1"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Left"/></Style>' +
      '<Style ss:ID="sVn"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#E6EDF3"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0;-#,##0;&quot;-&quot;"/><Alignment ss:Vertical="Center" ss:Horizontal="Right"/></Style>' +
      '<Style ss:ID="sNetoOff"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#F85149" ss:Bold="1"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0;-#,##0;&quot;-&quot;"/><Alignment ss:Vertical="Center" ss:Horizontal="Right"/></Style>' +
      '<Style ss:ID="sMoney"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#E6EDF3"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00;-#,##0.00;&quot;-&quot;"/><Alignment ss:Vertical="Center" ss:Horizontal="Right"/></Style>' +
      '<Style ss:ID="sFlujoPos"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#3FB950"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00;-#,##0.00;&quot;-&quot;"/><Alignment ss:Vertical="Center" ss:Horizontal="Right"/></Style>' +
      '<Style ss:ID="sFlujoNeg"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#F85149"/><Interior ss:Color="#0D1117" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00;-#,##0.00;&quot;-&quot;"/><Alignment ss:Vertical="Center" ss:Horizontal="Right"/></Style>' +
      '<Style ss:ID="sOk"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#3FB950" ss:Bold="1"/><Interior ss:Color="#12321D" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center"/></Style>' +
      '<Style ss:ID="sRev"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#D29922" ss:Bold="1"/><Interior ss:Color="#3A2D0B" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center"/></Style>' +
      '<Style ss:ID="sDes"><Font ss:FontName="Segoe UI" ss:Size="9" ss:Color="#F85149" ss:Bold="1"/><Interior ss:Color="#3D1418" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:Horizontal="Center"/></Style>' +
      "</Styles>";

    var cols = "";
    var widths = [18, 55, 52, 52, 52, 52, 52, 52, 52, 52, 52, 52, 52, 52, 52, 52, 58, 52, 58, 58, 78];
    for (var w = 0; w < widths.length; w++) {
      cols += '<Column ss:Index="' + (w + 1) + '" ss:Width="' + widths[w] + '"/>';
    }

    var xmlRows = [];
    xmlRows.push(
      ssRow(24, [ssCell({ value: "Control de posiciones en títulos", style: "sTitle", mergeAcross: 20 })])
    );
    xmlRows.push(ssRow(8, []));
    xmlRows.push(
      ssRow(
        16,
        [
          ssCell({ value: "TICKERS CONTROLADOS", style: "sKpiL", mergeAcross: 1, index: 2 }),
          ssCell({ value: "DESCALCES", style: "sKpiL", mergeAcross: 1 }),
          ssCell({ value: "REVISAR PLAZOS", style: "sKpiL", mergeAcross: 1 }),
          ssCell({ value: "OPS SENEBI INCLUIDAS", style: "sKpiL", mergeAcross: 1 }),
          ssCell({ value: "OPS PANTALLA INCLUIDAS", style: "sKpiL", mergeAcross: 1 }),
          ssCell({ value: "OPS A3 INCLUIDAS", style: "sKpiL", mergeAcross: 1 })
        ]
      )
    );
    xmlRows.push(
      ssRow(
        28,
        [
          ssCell({ value: k.tickers, type: "Number", style: "sKpiV", mergeAcross: 1, index: 2 }),
          ssCell({ value: k.descalces, type: "Number", style: k.descalces > 0 ? "sKpiRed" : "sKpiV", mergeAcross: 1 }),
          ssCell({ value: k.revisar, type: "Number", style: k.revisar > 0 ? "sKpiAmb" : "sKpiV", mergeAcross: 1 }),
          ssCell({ value: k.opsSenebi, type: "Number", style: "sKpiV", mergeAcross: 1 }),
          ssCell({ value: k.opsPantalla, type: "Number", style: "sKpiV", mergeAcross: 1 }),
          ssCell({ value: k.opsA3, type: "Number", style: "sKpiV", mergeAcross: 1 })
        ]
      )
    );
    xmlRows.push(ssRow(10, []));
    xmlRows.push(
      ssRow(
        20,
        [
          ssCell({ value: "#", style: "sHead", mergeDown: 1 }),
          ssCell({ value: "Ticker", style: "sHead", mergeDown: 1 }),
          ssCell({ value: "BYMA · SENEBI", style: "sSen", mergeAcross: 3 }),
          ssCell({ value: "BYMA · PANTALLA", style: "sPan", mergeAcross: 3 }),
          ssCell({ value: "A3", style: "sA3", mergeAcross: 3 }),
          ssCell({ value: "NETO VN", style: "sNeto", mergeAcross: 3 }),
          ssCell({ value: "FLUJO $", style: "sFlujo", mergeAcross: 1 }),
          ssCell({ value: "Estado", style: "sHead", mergeDown: 1 })])
        ]
      )
    );
    xmlRows.push(
      ssRow(
        28,
        [
          ssCell({ value: "CI Compra", style: "sSen", index: 3 }),
          ssCell({ value: "CI Venta", style: "sSen" }),
          ssCell({ value: "24HS Compra", style: "sSen" }),
          ssCell({ value: "24HS Venta", style: "sSen" }),
          ssCell({ value: "CI Compra", style: "sPan" }),
          ssCell({ value: "CI Venta", style: "sPan" }),
          ssCell({ value: "24HS Compra", style: "sPan" }),
          ssCell({ value: "24HS Venta", style: "sPan" }),
          ssCell({ value: "CI Compra", style: "sA3" }),
          ssCell({ value: "CI Venta", style: "sA3" }),
          ssCell({ value: "24HS Compra", style: "sA3" }),
          ssCell({ value: "24HS Venta", style: "sA3" }),
          ssCell({ value: "Neto CI", style: "sNeto" }),
          ssCell({ value: "Neto 24HS", style: "sNeto" }),
          ssCell({ value: "Neto otros plazos", style: "sNeto" }),
          ssCell({ value: "Neto total", style: "sNeto" }),
          ssCell({ value: "Flujo CI", style: "sFlujo" }),
          ssCell({ value: "Flujo 24HS", style: "sFlujo" })
        ]
      )
    );

    function numCell(n, style) {
      return ssCell({ value: n, type: "Number", style: style });
    }

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      xmlRows.push(
        ssRow(18, [
          ssCell({ value: i + 1, type: "Number", style: "sBase" }),
          ssCell({ value: r.ticker, style: "sTxt" }),
          numCell(r.senebiCiCompra, "sVn"),
          numCell(r.senebiCiVenta, "sVn"),
          numCell(r.senebi24Compra, "sVn"),
          numCell(r.senebi24Venta, "sVn"),
          numCell(r.pantCiCompra, "sVn"),
          numCell(r.pantCiVenta, "sVn"),
          numCell(r.pant24Compra, "sVn"),
          numCell(r.pant24Venta, "sVn"),
          numCell(r.a3CiCompra, "sVn"),
          numCell(r.a3CiVenta, "sVn"),
          numCell(r.a3_24Compra, "sVn"),
          numCell(r.a3_24Venta, "sVn"),
          numCell(r.netoCi, vnStyle(r.netoCi)),
          numCell(r.neto24, vnStyle(r.neto24)),
          numCell(r.netoOtros, vnStyle(r.netoOtros)),
          numCell(r.netoTotal, vnStyle(r.netoTotal)),
          numCell(r.flujoCi, flujoStyle(r.flujoCi)),
          numCell(r.flujo24, flujoStyle(r.flujo24)),
          ssCell({ value: r.estado, style: estadoStyle(r.estado) })
        ])
      );
    }

    var xml =
      '<?xml version="1.0"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
      styles +
      '<Worksheet ss:Name="Dashboard"><Table ss:ExpandedColumnCount="21" ss:ExpandedRowCount="' +
      (7 + rows.length) +
      '">' +
      cols +
      xmlRows.join("") +
      "</Table></Worksheet></Workbook>";

    var stamp = new Date();
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    var name =
      "control_posiciones_" +
      stamp.getFullYear() +
      pad(stamp.getMonth() + 1) +
      pad(stamp.getDate()) +
      ".xls";
    var blob = new Blob([xml], { type: "application/vnd.ms-excel" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function copyTable() {
    if (!lastResult || !lastResult.dashboard.length) {
      setStatus("No hay resultado para copiar. Procesá los archivos primero.", "error");
      return;
    }
    var lines = [
      [
        "#",
        "Ticker",
        "SENEBI CI C",
        "SENEBI CI V",
        "SENEBI 24 C",
        "SENEBI 24 V",
        "PANT CI C",
        "PANT CI V",
        "PANT 24 C",
        "PANT 24 V",
        "A3 CI C",
        "A3 CI V",
        "A3 24 C",
        "A3 24 V",
        "Neto CI",
        "Neto 24",
        "Neto otros plazos",
        "Neto total",
        "Flujo CI",
        "Flujo 24HS",
        "Estado"
      ].join("\t")
    ];
    lastResult.dashboard.forEach(function (r, idx) {
      lines.push(
        [
          idx + 1,
          r.ticker,
          r.senebiCiCompra,
          r.senebiCiVenta,
          r.senebi24Compra,
          r.senebi24Venta,
          r.pantCiCompra,
          r.pantCiVenta,
          r.pant24Compra,
          r.pant24Venta,
          r.a3CiCompra,
          r.a3CiVenta,
          r.a3_24Compra,
          r.a3_24Venta,
          r.netoCi,
          r.neto24,
          r.netoOtros,
          r.netoTotal,
          r.flujoCi,
          r.flujo24,
          r.estado
        ].join("\t")
      );
    });
    navigator.clipboard.writeText(lines.join("\n")).then(function () {
      var btn = $("btn-copiar");
      if (!btn) return;
      var orig = btn.innerHTML;
      btn.innerHTML = "✓";
      setTimeout(function () {
        btn.innerHTML = orig;
      }, 1500);
    });
  }

  function run() {
    var cfg = readConfig();
    if (!cfg.agent) {
      setStatus("Indicá el nro. de agente propio (BYMA).", "error");
      return;
    }
    if (!cfg.ownAccounts.length) {
      setStatus("Indicá los comitentes de cartera propia.", "error");
      return;
    }
    var fByma = $("file-byma") && $("file-byma").files[0];
    var fPant = $("file-pantalla") && $("file-pantalla").files[0];
    var fA3 = $("file-a3") && $("file-a3").files[0];
    if (!fByma && !fPant && !fA3) {
      setStatus("Cargá al menos un archivo: SENEBI, pantalla o A3.", "error");
      return;
    }
    setStatus("Procesando en el navegador…");
    Promise.all([
      readFileAsTable(fByma, "byma"),
      readFileAsTable(fPant, "pantalla"),
      readFileAsTable(fA3, "a3")
    ])
      .then(function (tables) {
        var result = CP.runControl(
          { byma: tables[0], pantalla: tables[1], a3: tables[2] },
          cfg
        );
        lastResult = result;
        renderDashboard(result.dashboard, result.kpis);
        $("result-actions").style.display = result.dashboard.length ? "" : "none";
        var checks = [];
        checks.push("SENEBI " + headerBadges(result.headerCheck.byma, !!fByma));
        checks.push("Pantalla " + headerBadges(result.headerCheck.pantalla, !!fPant));
        checks.push("A3 " + headerBadges(result.headerCheck.a3, !!fA3));
        var missingAny =
          (fByma && result.headerCheck.byma.length) ||
          (fPant && result.headerCheck.pantalla.length) ||
          (fA3 && result.headerCheck.a3.length);
        if (missingAny) {
          setStatus("Encabezados: " + checks.join(" · "), "warning");
        } else if (!result.dashboard.length) {
          setStatus("No quedó ningún ticker incluido. Revisá agente, comitentes y encabezados.", "warning");
        } else {
          var el = $("resultado");
          if (el) {
            el.textContent = "";
            el.classList.add("empty");
            el.classList.remove("error", "warning", "has-result");
            el.style.display = "none";
          }
        }
      })
      .catch(function (err) {
        lastResult = null;
        var wrap = $("result-table-wrap");
        if (wrap) {
          wrap.style.display = "none";
          wrap.innerHTML = "";
        }
        var actions = $("result-actions");
        if (actions) actions.style.display = "none";
        setStatus(err.message || String(err), "error");
      });
  }

  function initEquiv() {
    var def = CP.defaultConfig().equivalencias;
    Object.keys(def).forEach(function (k) {
      addEquivRow(k, def[k]);
    });
    var addBtn = $("btn-add-equiv");
    if (addBtn) addBtn.addEventListener("click", function () {
      addEquivRow("", "");
    });
  }

  function init() {
    initEquiv();
    var btn = $("btn-procesar");
    if (btn) btn.addEventListener("click", run);
    var form = $("form-control-posiciones");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        run();
      });
    }
    var btnCopy = $("btn-copiar");
    if (btnCopy) btnCopy.addEventListener("click", copyTable);
    var btnExcel = $("btn-exportar-excel");
    if (btnExcel) btnExcel.addEventListener("click", exportExcel);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

