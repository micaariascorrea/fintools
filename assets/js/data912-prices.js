/**
 * Precios Data912 — misma fuente que el ticker/banner (assets/ticker.js).
 * Base: https://data912.com
 * Live: /live/arg_bonds, /live/arg_stocks (+ notes/cedears/corp para cobertura).
 * El campo `c` del live es el cierre de la última sesión disponible (API no real-time),
 * que coincide con el cierre del último día hábil anterior a hoy.
 */
(function (global) {
  "use strict";

  var BASE = "https://data912.com";

  /** Endpoints live usados por el banner (bonds/stocks) más el resto AR de la misma API. */
  var LIVE_PATHS = [
    "/live/arg_bonds",
    "/live/arg_stocks",
    "/live/arg_notes",
    "/live/arg_cedears",
    "/live/arg_corp"
  ];

  /** Referencia líquida solo para etiquetar la fecha del último día hábil. */
  var CLOSE_DATE_PROBE = "/historical/bonds/AL30";

  function todayYmd() {
    var now = new Date();
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);
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

  /**
   * Último cierre hábil: última barra histórica con date < hoy (AR).
   * Solo para la etiqueta de fecha; los precios salen del live.
   */
  function resolvePriorBusinessDayCloseDate() {
    var today = todayYmd();
    return fetchJson(BASE + CLOSE_DATE_PROBE).then(function (arr) {
      if (!Array.isArray(arr) || !arr.length) return null;
      var best = null;
      for (var i = 0; i < arr.length; i++) {
        var row = arr[i];
        if (!row || !row.date) continue;
        if (row.date < today && (best == null || row.date > best)) best = row.date;
      }
      return best;
    });
  }

  /**
   * Mapa symbol → { price, pctChange } desde los mismos /live/ que el banner.
   * price = campo `c` (cierre última sesión = último día hábil con dato).
   */
  function fetchLivePriceMap() {
    return Promise.all(
      LIVE_PATHS.map(function (path) {
        return fetchJson(BASE + path).then(function (data) {
          return Array.isArray(data) ? data : [];
        });
      })
    ).then(function (lists) {
      var map = {};
      for (var li = 0; li < lists.length; li++) {
        var list = lists[li];
        for (var i = 0; i < list.length; i++) {
          var row = list[i];
          if (!row) continue;
          var symbol = String(row.symbol || row.ticker || "").trim().toUpperCase();
          if (!symbol) continue;
          var price = row.c != null ? row.c : row.px_bid;
          if (price == null || isNaN(price)) continue;
          if (map[symbol] == null) {
            map[symbol] = {
              price: Number(price),
              pctChange: row.pct_change != null && !isNaN(row.pct_change) ? Number(row.pct_change) : null
            };
          }
        }
      }
      return map;
    });
  }

  /**
   * Carga precios live + fecha del último día hábil (etiqueta).
   * @returns {Promise<{ prices: Object, closeDate: string|null, source: string }>}
   */
  function loadPriorBusinessDayCloses() {
    return Promise.all([fetchLivePriceMap(), resolvePriorBusinessDayCloseDate()]).then(function (pair) {
      return {
        prices: pair[0],
        closeDate: pair[1],
        source: BASE + " /live (mismo origen que el ticker)"
      };
    });
  }

  function lookupPrice(priceMap, ticker) {
    if (!ticker || !priceMap) return null;
    var key = String(ticker).trim().toUpperCase();
    if (!key) return null;
    var hit = priceMap[key];
    return hit && hit.price != null && !isNaN(hit.price) ? hit.price : null;
  }

  global.Data912Prices = {
    BASE: BASE,
    LIVE_PATHS: LIVE_PATHS,
    todayYmd: todayYmd,
    fetchLivePriceMap: fetchLivePriceMap,
    resolvePriorBusinessDayCloseDate: resolvePriorBusinessDayCloseDate,
    loadPriorBusinessDayCloses: loadPriorBusinessDayCloses,
    lookupPrice: lookupPrice
  };
})(typeof window !== "undefined" ? window : this);
