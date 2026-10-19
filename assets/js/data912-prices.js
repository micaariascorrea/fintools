/**
 * Precios Data912 (https://data912.com).
 *
 * Paneles /live/*: `c` es el último operado, `px_bid`/`px_ask` las puntas,
 * `pct_change` la variación contra el cierre anterior. No traen fecha ni cierre.
 * Hay caché de unas 2 horas y un tope de 120 consultas por minuto.
 *
 * El cierre del día hábil anterior sale de /historical/{bonds|stocks|cedears}/{ticker}:
 * la última vela con date anterior a hoy (hora Argentina). Se guarda en el
 * navegador y no se vuelve a pedir hasta el día siguiente.
 */
(function (global) {
  "use strict";

  var BASE = "https://data912.com";
  var CACHE_KEY = "allinarg.data912.priorClose.v1";
  var HIST_KINDS = ["bonds", "stocks", "cedears"];
  var memory = null;
  var inflight = {};

  function todayYmd() {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    var y, m, d;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "year") y = parts[i].value;
      if (parts[i].type === "month") m = parts[i].value;
      if (parts[i].type === "day") d = parts[i].value;
    }
    return y + "-" + m + "-" + d;
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  /** status: "ok" con body, "miss" (404 o sin vela) o "error" (red / 5xx, no se cachea). */
  function fetchHistory(kind, symbol) {
    return fetch(BASE + "/historical/" + kind + "/" + encodeURIComponent(symbol)).then(function (r) {
      if (r.status === 404) return { status: "miss", body: null };
      if (!r.ok) return { status: "error", body: null };
      return r.json().then(function (body) {
        return { status: "ok", body: body };
      }).catch(function () { return { status: "error", body: null }; });
    }).catch(function () { return { status: "error", body: null }; });
  }

  function emptyCache(day) {
    return { day: day, symbols: {}, fx: null };
  }

  function getCache() {
    var day = todayYmd();
    if (memory && memory.day === day) return memory;
    var bucket = emptyCache(day);
    try {
      if (typeof localStorage !== "undefined") {
        var raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && parsed.day === day) {
            parsed.symbols = parsed.symbols || {};
            bucket = parsed;
          }
        }
      }
    } catch (e) { /* caché ilegible: se vuelve a consultar */ }
    memory = bucket;
    return memory;
  }

  function saveCache() {
    if (!memory) return;
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_KEY, JSON.stringify(memory));
    } catch (e) { /* modo privado: queda la copia en memoria */ }
  }

  function priorBar(rows, today) {
    if (!Array.isArray(rows)) return null;
    var best = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.date || row.date >= today || row.c == null || isNaN(row.c)) continue;
      if (!best || row.date > best.date) best = { date: row.date, c: Number(row.c) };
    }
    return best;
  }

  function barsByDate(rows, today) {
    var map = {};
    if (!Array.isArray(rows)) return map;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.date || row.date >= today || row.c == null || isNaN(row.c)) continue;
      map[row.date] = Number(row.c);
    }
    return map;
  }

  function latestShared(numMap, denMap) {
    var best = null;
    var num = null;
    var den = null;
    for (var date in numMap) {
      if (!Object.prototype.hasOwnProperty.call(numMap, date)) continue;
      if (denMap[date] == null || denMap[date] === 0) continue;
      if (best == null || date > best) {
        best = date;
        num = numMap[date];
        den = denMap[date];
      }
    }
    if (!best) return null;
    return { date: best, close: num / den };
  }

  function finiteOrNull(v) {
    var n = Number(v);
    return v != null && isFinite(n) && n !== 0 ? n : null;
  }

  function cross(ars, usd) {
    if (!ars || !usd) return null;
    var bidN = finiteOrNull(ars.px_bid);
    var bidD = finiteOrNull(usd.px_ask);
    var askN = finiteOrNull(ars.px_ask);
    var askD = finiteOrNull(usd.px_bid);
    var lastN = finiteOrNull(ars.c);
    var lastD = finiteOrNull(usd.c);
    return {
      bid: bidN != null && bidD != null ? bidN / bidD : null,
      ask: askN != null && askD != null ? askN / askD : null,
      last: lastN != null && lastD != null ? lastN / lastD : null
    };
  }

  function normalizeSymbol(symbol) {
    return String(symbol || "").trim().toUpperCase();
  }

  function loadOnePrior(symbol, kinds) {
    var key = normalizeSymbol(symbol);
    if (!key) return Promise.resolve(null);
    if (inflight[key]) return inflight[key];
    var cache = getCache();
    var hit = cache.symbols[key];
    if (hit && hit.resolved) {
      return Promise.resolve(hit.miss ? null : { date: hit.date, c: hit.c });
    }
    var order = kinds && kinds.length ? kinds : HIST_KINDS;
    var i = 0;
    var sawError = false;
    function step() {
      if (i >= order.length) {
        if (!sawError) {
          cache.symbols[key] = { resolved: true, miss: true };
          saveCache();
        }
        return Promise.resolve(null);
      }
      var kind = order[i++];
      return fetchHistory(kind, key).then(function (res) {
        if (res.status === "error") {
          sawError = true;
          return step();
        }
        var bar = priorBar(res.body, cache.day);
        if (!bar) return step();
        cache.symbols[key] = { resolved: true, miss: false, date: bar.date, c: bar.c };
        saveCache();
        return { date: bar.date, c: bar.c };
      });
    }
    inflight[key] = step().then(function (bar) {
      delete inflight[key];
      return bar;
    }, function (err) {
      delete inflight[key];
      throw err;
    });
    return inflight[key];
  }

  function pool(items, limit, fn) {
    var next = 0;
    var active = 0;
    var out = new Array(items.length);
    return new Promise(function (resolve, reject) {
      function kick() {
        if (next >= items.length && active === 0) {
          resolve(out);
          return;
        }
        while (active < limit && next < items.length) {
          (function (idx) {
            active++;
            Promise.resolve(fn(items[idx], idx)).then(function (val) {
              out[idx] = val;
              active--;
              kick();
            }, reject);
          })(next);
          next++;
        }
      }
      if (!items.length) resolve(out);
      else kick();
    });
  }

  /**
   * Cierres del día hábil anterior para los símbolos pedidos.
   * Cada ítem: { symbol, kinds? } o un string.
   * @returns {Promise<{ prices: Object, dates: Object }>}
   */
  function loadPriorCloses(items) {
    var list = [];
    var seen = {};
    (items || []).forEach(function (item) {
      var symbol = normalizeSymbol(item && item.symbol != null ? item.symbol : item);
      if (!symbol || seen[symbol]) return;
      seen[symbol] = true;
      var kinds = item && item.kinds && item.kinds.length ? item.kinds : HIST_KINDS;
      list.push({ symbol: symbol, kinds: kinds });
    });
    return pool(list, 5, function (item) {
      return loadOnePrior(item.symbol, item.kinds).then(function (bar) {
        return { symbol: item.symbol, bar: bar };
      });
    }).then(function (rows) {
      var prices = {};
      var dates = {};
      rows.forEach(function (row) {
        if (!row || !row.bar) return;
        prices[row.symbol] = row.bar.c;
        dates[row.symbol] = row.bar.date;
      });
      return { prices: prices, dates: dates };
    });
  }

  function fxUseful(fx) {
    if (!fx) return false;
    return !!((fx.mep && fx.mep.date && fx.mep.close != null) || (fx.ccl && fx.ccl.date && fx.ccl.close != null));
  }

  function quoteOrNull(q) {
    if (!q) return null;
    if (q.bid == null && q.ask == null && q.last == null) return null;
    return q;
  }

  function asList(data) {
    return Array.isArray(data) ? data : [];
  }

  /** Panel /live/mep: la fila AL30 ya trae bid, ask y el último (campo close). */
  function mepFromPanel(rows) {
    var row = null;
    for (var i = 0; i < rows.length; i++) {
      if (normalizeSymbol(rows[i] && rows[i].ticker) === "AL30") {
        row = rows[i];
        break;
      }
    }
    if (!row) return null;
    var last = finiteOrNull(row.close);
    if (last == null) last = finiteOrNull(row.mark);
    return quoteOrNull({
      bid: finiteOrNull(row.bid),
      ask: finiteOrNull(row.ask),
      last: last
    });
  }

  function loadFxCloses() {
    var cache = getCache();
    if (fxUseful(cache.fx)) return Promise.resolve(cache.fx);
    return Promise.all(["AL30", "AL30D", "AL30C"].map(function (symbol) {
      return fetchHistory("bonds", symbol);
    })).then(function (series) {
      if (series.some(function (res) { return !res || res.status === "error"; })) {
        return { resolved: false, mep: null, ccl: null };
      }
      var today = getCache().day;
      var al30 = barsByDate(series[0].body, today);
      var al30d = barsByDate(series[1].body, today);
      var al30c = barsByDate(series[2].body, today);
      var fx = {
        resolved: true,
        mep: latestShared(al30, al30d),
        ccl: latestShared(al30, al30c)
      };
      if (fxUseful(fx)) {
        getCache().fx = fx;
        saveCache();
      }
      return fx;
    }).catch(function () {
      return { resolved: false, mep: null, ccl: null };
    });
  }

  /**
   * MEP y CCL de referencia AL30.
   * live: último y puntas de hoy (con demora). close: histórico, una vez por día.
   */
  function indexBySymbol(rows) {
    var by = {};
    rows.forEach(function (row) {
      var symbol = normalizeSymbol(row && row.symbol);
      if (symbol && by[symbol] == null) by[symbol] = row;
    });
    return by;
  }

  function loadExchangeRatesOnce() {
    return Promise.all([
      fetchJson(BASE + "/live/arg_bonds").then(asList),
      fetchJson(BASE + "/live/mep").then(asList),
      loadFxCloses()
    ]).then(function (pair) {
      var by = indexBySymbol(pair[0]);
      var fx = pair[2] || {};
      return {
        mepLive: quoteOrNull(cross(by.AL30, by.AL30D)) || mepFromPanel(pair[1]),
        cclLive: quoteOrNull(cross(by.AL30, by.AL30C)),
        mepClose: fx.mep || null,
        cclClose: fx.ccl || null
      };
    });
  }

  function ratesHaveData(fx) {
    if (!fx) return false;
    function live(q) { return q && (q.bid != null || q.ask != null || q.last != null); }
    return live(fx.mepLive) || live(fx.cclLive) || (fx.mepClose && fx.mepClose.close != null) || (fx.cclClose && fx.cclClose.close != null);
  }

  function loadExchangeRates() {
    return loadExchangeRatesOnce().then(function (fx) {
      if (ratesHaveData(fx)) return fx;
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(loadExchangeRatesOnce()); }, 800);
      });
    });
  }

  function lookupPrice(priceMap, ticker) {
    if (!ticker || !priceMap) return null;
    var key = normalizeSymbol(ticker);
    if (!key || priceMap[key] == null || isNaN(priceMap[key])) return null;
    return priceMap[key];
  }

  global.Data912Prices = {
    BASE: BASE,
    todayYmd: todayYmd,
    priorBar: priorBar,
    latestShared: latestShared,
    cross: cross,
    loadPriorCloses: loadPriorCloses,
    loadExchangeRates: loadExchangeRates,
    lookupPrice: lookupPrice
  };
})(typeof window !== "undefined" ? window : this);
