/**
 * Control de operaciones — pivote Client ID × Symbol con alerta por umbral ARS.
 * Port del script caucho (bymacaucho): sin Slack ni branding externo.
 */
(function () {
  "use strict";

  var DEFAULT_THRESHOLD = 200000000;
  var REQUIRED_COLS = ["Client ID", "Symbol", "Side", "Executed Size", "Turnover"];

  var lastRawRows = null;
  var lastPivotRows = null;
  var lastThreshold = DEFAULT_THRESHOLD;

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
    if (!lines.length) return { headers: [], rows: [] };
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
    return { headers: headers, rows: rows };
  }

  function findCol(headers, name) {
    var target = name.toLowerCase().replace(/\s+/g, " ").trim();
    for (var i = 0; i < headers.length; i++) {
      if (String(headers[i]).toLowerCase().replace(/\s+/g, " ").trim() === target) {
        return headers[i];
      }
    }
    return null;
  }

  function cleanNumeric(val) {
    if (val === null || val === undefined || val === "") return NaN;
    if (typeof val === "number") return isFinite(val) ? val : NaN;
    var s = String(val).trim();
    if (!s) return NaN;
    s = s.replace(/\./g, "").replace(",", ".");
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  function parseThreshold(str) {
    var n = cleanNumeric(str);
    if (!isFinite(n) || n < 0) return NaN;
    return n;
  }

  function formatInputMonto(num) {
    if (!isFinite(num)) return "";
    var fixed = String(Math.round(num));
    return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function formatMonto(num) {
    if (!isFinite(num)) return "—";
    return Math.round(num).toLocaleString("es-AR");
  }

  function extractCurrency(symbol) {
    if (typeof symbol === "string" && (symbol.match(/-/g) || []).length >= 4) {
      var parts = symbol.split("-");
      return parts[parts.length - 1] || "SIN_MONEDA";
    }
    return "SIN_MONEDA";
  }

  function getSymbolOrder(symbol) {
    var u = String(symbol || "").toUpperCase();
    if (/^PESOS/.test(u)) return 1;
    if (/^DOLAR/.test(u)) return 2;
    return 3;
  }

  function processTrades(rawRows, headers, threshold) {
    var colMap = {};
    for (var i = 0; i < REQUIRED_COLS.length; i++) {
      var key = REQUIRED_COLS[i];
      var found = findCol(headers, key);
      if (!found) {
        throw new Error('Falta la columna "' + key + '" en el CSV.');
      }
      colMap[key] = found;
    }

    var groups = {};
    var used = 0;

    for (var r = 0; r < rawRows.length; r++) {
      var row = rawRows[r];
      var clientId = String(row[colMap["Client ID"]] || "").trim();
      var symbol = String(row[colMap["Symbol"]] || "").trim();
      var side = String(row[colMap["Side"]] || "").trim().toUpperCase();
      var executed = cleanNumeric(row[colMap["Executed Size"]]);
      var turnover = cleanNumeric(row[colMap["Turnover"]]);

      if (!clientId || !symbol) continue;
      if (side !== "BUY" && side !== "SELL") continue;

      var isCurrency = /^(PESOS|DOLAR)/i.test(symbol);
      var monto = isCurrency ? executed : turnover;
      if (!isFinite(monto)) continue;

      var key = clientId + "\0" + symbol;
      if (!groups[key]) {
        groups[key] = {
          clientId: clientId,
          symbol: symbol,
          moneda: extractCurrency(symbol),
          buy: 0,
          sell: 0,
          execBuy: 0,
          execSell: 0
        };
      }
      var g = groups[key];
      if (side === "BUY") {
        g.buy += monto;
        if (isFinite(executed)) g.execBuy += executed;
      } else {
        g.sell += monto;
        if (isFinite(executed)) g.execSell += executed;
      }
      used++;
    }

    if (!used) {
      throw new Error("No hay filas válidas (Client ID, Symbol, Side BUY/SELL y montos numéricos).");
    }

    var rows = [];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      var execTotal = g.execBuy + g.execSell;
      var total = g.buy + g.sell;
      rows.push({
        clientId: g.clientId,
        symbol: g.symbol,
        moneda: g.moneda,
        executedSizeTotal: execTotal,
        buy: g.buy,
        sell: g.sell,
        totalGeneral: total,
        alerta: total >= threshold
      });
    });

    rows.sort(function (a, b) {
      if (a.clientId < b.clientId) return -1;
      if (a.clientId > b.clientId) return 1;
      var oa = getSymbolOrder(a.symbol);
      var ob = getSymbolOrder(b.symbol);
      if (oa !== ob) return oa - ob;
      if (a.symbol < b.symbol) return -1;
      if (a.symbol > b.symbol) return 1;
      return b.totalGeneral - a.totalGeneral;
    });

    return rows;
  }

  function setStatus(msg, kind) {
    var el = document.getElementById("resultado");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("empty", "error", "warning");
    if (kind === "error") el.classList.add("error");
    else if (kind === "warning") el.classList.add("warning");
    else if (!msg) el.classList.add("empty");
  }

  function renderTable(rows, threshold) {
    var wrap = document.getElementById("result-table-wrap");
    if (!wrap) return;

    var alerts = rows.filter(function (r) {
      return r.alerta;
    }).length;

    var html =
      '<table class="result-table" aria-label="Tabla dinámica de operaciones">' +
      "<thead><tr>" +
      "<th>Client ID</th><th>Symbol</th><th>Executed Size Total</th>" +
      "<th>BUY</th><th>SELL</th><th>Total general</th><th>ALERTA</th>" +
      "</tr></thead><tbody>";

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cls = row.alerta ? ' class="result-row-excedido"' : "";
      html +=
        "<tr" +
        cls +
        ">" +
        "<td>" +
        escapeHtml(row.clientId) +
        "</td>" +
        "<td>" +
        escapeHtml(row.symbol) +
        "</td>" +
        "<td>" +
        formatMonto(row.executedSizeTotal) +
        "</td>" +
        "<td>" +
        formatMonto(row.buy) +
        "</td>" +
        "<td>" +
        formatMonto(row.sell) +
        "</td>" +
        "<td>" +
        formatMonto(row.totalGeneral) +
        "</td>" +
        "<td>" +
        (row.alerta ? "ALERTA" : "") +
        "</td>" +
        "</tr>";
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;
    wrap.style.display = "";

    var msg =
      rows.length +
      " filas · " +
      alerts +
      " alerta" +
      (alerts === 1 ? "" : "s") +
      " (umbral " +
      formatMonto(threshold) +
      ")";
    setStatus(msg, alerts ? "warning" : "");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function exportExcel() {
    if (!lastPivotRows || !lastPivotRows.length) {
      setStatus("No hay resultado para exportar. Procesá el CSV primero.", "error");
      return;
    }
    var XLSX = window.XLSX;
    if (!XLSX) {
      setStatus("No se pudo cargar la librería de exportación.", "error");
      return;
    }

    var pivotAoa = [
      [
        "Client ID",
        "Symbol",
        "Executed Size Total",
        "BUY",
        "SELL",
        "Total general",
        "ALERTA"
      ]
    ];
    for (var i = 0; i < lastPivotRows.length; i++) {
      var r = lastPivotRows[i];
      pivotAoa.push([
        r.clientId,
        r.symbol,
        r.executedSizeTotal,
        r.buy,
        r.sell,
        r.totalGeneral,
        r.alerta ? "ALERTA" : ""
      ]);
    }

    var wb = XLSX.utils.book_new();
    var wsPivot = XLSX.utils.aoa_to_sheet(pivotAoa);
    XLSX.utils.book_append_sheet(wb, wsPivot, "Tabla Dinamica Final");

    if (lastRawRows && lastRawRows.length) {
      var wsRaw = XLSX.utils.json_to_sheet(lastRawRows);
      XLSX.utils.book_append_sheet(wb, wsRaw, "Datos Crudos CSV");
    }

    var stamp = new Date();
    var pad = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    var name =
      "Reporte_control_ops_" +
      stamp.getFullYear() +
      pad(stamp.getMonth() + 1) +
      pad(stamp.getDate()) +
      "_" +
      pad(stamp.getHours()) +
      pad(stamp.getMinutes()) +
      pad(stamp.getSeconds()) +
      ".xlsx";
    XLSX.writeFile(wb, name);

    var btn = document.getElementById("btn-exportar-excel");
    if (btn) {
      var orig = btn.innerHTML;
      btn.innerHTML = "✓";
      setTimeout(function () {
        btn.innerHTML = orig;
      }, 1500);
    }
  }

  function copyTable() {
    if (!lastPivotRows || !lastPivotRows.length) {
      setStatus("No hay resultado para copiar. Procesá el CSV primero.", "error");
      return;
    }
    var lines = [
      [
        "Client ID",
        "Symbol",
        "Executed Size Total",
        "BUY",
        "SELL",
        "Total general",
        "ALERTA"
      ].join("\t")
    ];
    for (var i = 0; i < lastPivotRows.length; i++) {
      var r = lastPivotRows[i];
      lines.push(
        [
          r.clientId,
          r.symbol,
          Math.round(r.executedSizeTotal),
          Math.round(r.buy),
          Math.round(r.sell),
          Math.round(r.totalGeneral),
          r.alerta ? "ALERTA" : ""
        ].join("\t")
      );
    }
    navigator.clipboard.writeText(lines.join("\n")).then(function () {
      var btn = document.getElementById("btn-copiar");
      if (!btn) return;
      var orig = btn.innerHTML;
      btn.innerHTML = "✓";
      setTimeout(function () {
        btn.innerHTML = orig;
      }, 1500);
    });
  }

  function run() {
    var fileInput = document.getElementById("file-ops");
    var thresholdInput = document.getElementById("umbral-alerta");
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) {
      setStatus("Seleccioná un archivo CSV de operaciones.", "error");
      return;
    }

    var threshold = parseThreshold(thresholdInput ? thresholdInput.value : "");
    if (!isFinite(threshold)) {
      setStatus("Umbral de alerta inválido.", "error");
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = parseCSV(reader.result);
        var pivot = processTrades(parsed.rows, parsed.headers, threshold);
        lastRawRows = parsed.rows;
        lastPivotRows = pivot;
        lastThreshold = threshold;
        renderTable(pivot, threshold);
      } catch (err) {
        lastRawRows = null;
        lastPivotRows = null;
        var wrap = document.getElementById("result-table-wrap");
        if (wrap) {
          wrap.style.display = "none";
          wrap.innerHTML = "";
        }
        setStatus(err.message || String(err), "error");
      }
    };
    reader.onerror = function () {
      setStatus("No se pudo leer el archivo.", "error");
    };
    reader.readAsText(file, "UTF-8");
  }

  function init() {
    var thresholdInput = document.getElementById("umbral-alerta");
    if (thresholdInput && !thresholdInput.value) {
      thresholdInput.value = formatInputMonto(DEFAULT_THRESHOLD);
    }

    var btn = document.getElementById("btn-procesar");
    if (btn) btn.addEventListener("click", run);

    var form = document.getElementById("form-control-ops");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        run();
      });
    }

    var btnCopy = document.getElementById("btn-copiar");
    if (btnCopy) btnCopy.addEventListener("click", copyTable);

    var btnExcel = document.getElementById("btn-exportar-excel");
    if (btnExcel) btnExcel.addEventListener("click", exportExcel);

    if (thresholdInput) {
      thresholdInput.addEventListener("blur", function () {
        var n = parseThreshold(thresholdInput.value);
        if (isFinite(n)) thresholdInput.value = formatInputMonto(n);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
