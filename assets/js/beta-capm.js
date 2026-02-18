/**
 * beta-capm.js — Beta & CAPM en términos REALES (ALLINARG)
 * Solo acciones argentinas (BYMA).
 * Retornos deflactados por IPC (API oficial Series de Tiempo). Sin retornos nominales.
 * API stocks: data912.com/historical/stocks/{TICKER}.
 * API IPC: apis.datos.gob.ar/series/api (search + series).
 */
(function () {
  'use strict';

  var API_BASE = 'https://data912.com';
  var API_HISTORICAL = API_BASE + '/historical';
  var API_IPC_SEARCH = 'https://apis.datos.gob.ar/series/api/search';
  var API_IPC_SERIES = 'https://apis.datos.gob.ar/series/api/series';
  var VAR_RM_EPS = 1e-12;
  var MIN_OBS_WARNING = 30;
  var MIN_OBS_RED = 12;
  var PERIODS_DAILY = 252;
  var PERIODS_WEEKLY = 52;
  var PERIODS_MONTHLY = 12;
  var MIN_OBS_DAILY = 252;
  var MIN_OBS_WEEKLY = 52;
  var MIN_OBS_MONTHLY = 24;
  var MERVAL_MIN_COMPONENTS = 8;
  var ANTI_SPLIT_RATIO_HI = 3;
  var ANTI_SPLIT_RATIO_LO = 1 / 3;
  var ANTI_SPLIT_MAX_EVENTS = 3;
  var CORR_LOW_THRESHOLD = 0.2;
  var IPC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  var DEFAULT_IPC_SERIE_ID = '101.1_I2NG_2016_M_22'; // IPC-GBA Nivel General base dic-2016 mensual (INDEC)

  /** Basket MERVAL sintético (equal-weight). Editable; solo acciones AR líquidas. */
  var MERVAL_BASKET = ['GGAL', 'YPFD', 'PAM', 'TGSU2', 'TXAR', 'BYMA', 'ALUA', 'CEPU', 'PAMP', 'SUPV', 'BMA', 'CRES', 'TECO2', 'MIRG', 'COME', 'BIOX', 'VIST'];

  /** Listado CER (solo ticker; se envía tal cual a la API). */
  var CER_TICKERS = ['TZX26', 'X31L6', 'TZX06', 'TX26', 'X30N6', 'TZXD6', 'TZXM7', 'TZXA7', 'TZXY7', 'TZX27', 'TZXD7', 'TZX28', 'TX28', 'TX31', 'DICP', 'PARP'];

  /** Ventana en meses: 6M, 1Y, 3Y, 5Y, 10Y, MAX=null. */
  function windowMonths(option) {
    if (!option || option === 'MAX') return null;
    if (option === '6M') return 6;
    if (option === '1Y') return 12;
    if (option === '3Y') return 36;
    if (option === '5Y') return 60;
    if (option === '10Y') return 120;
    return null;
  }

  /** Períodos por año según frecuencia: 252 daily, 52 weekly, 12 monthly. */
  function periodsPerYear(freq) {
    if (freq === 'daily') return PERIODS_DAILY;
    if (freq === 'weekly') return PERIODS_WEEKLY;
    return PERIODS_MONTHLY;
  }

  /** Mínimo de observaciones para warning por frecuencia. */
  function minObsWarningByFreq(freq) {
    if (freq === 'daily') return MIN_OBS_DAILY;
    if (freq === 'weekly') return MIN_OBS_WEEKLY;
    return MIN_OBS_MONTHLY;
  }

  /** Rf en periodicidad del dato: Rf anual / períodos por año (252/52/12). */
  function rfPeriodic(rfAnnual, freq) {
    var p = periodsPerYear(freq);
    return p > 0 ? rfAnnual / p : 0;
  }

  // --- IPC desde API oficial (Series de Tiempo) ---
  var _ipcCache = null;
  var _ipcCacheTs = 0;
  var IPC_STORAGE_KEY = 'fintools_ipc_map';
  var IPC_STORAGE_TS_KEY = 'fintools_ipc_ts';

  /**
   * Busca la serie IPC nivel general en la API (mejor match: índice, nivel general, mensual).
   * Retorna serie_id o DEFAULT_IPC_SERIE_ID.
   */
  function findIpcSerieId(searchData) {
    var data = (searchData && searchData.data) || [];
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < data.length; i++) {
      var item = data[i];
      var field = item.field || {};
      var dataset = item.dataset || {};
      var desc = (field.description || '').toLowerCase();
      var title = (dataset.title || '').toLowerCase();
      var units = (field.units || '').toLowerCase();
      var freq = (field.frequency || '');
      if (freq !== 'R/P1M') continue;
      if (desc.indexOf('variaci') >= 0 || units.indexOf('porcentaje') >= 0) continue;
      if (title.indexOf('discontinuada') >= 0 && title.indexOf('2016') < 0) continue;
      var score = 0;
      if (desc.indexOf('nivel general') >= 0 || title.indexOf('nivel general') >= 0) score += 2;
      if (desc.indexOf('índice') >= 0 || title.indexOf('índice') >= 0 || units.indexOf('índice') >= 0) score += 2;
      if (title.indexOf('nacional') >= 0) score += 1;
      if (title.indexOf('consumidor') >= 0) score += 1;
      if (score > bestScore) { bestScore = score; best = field.id; }
    }
    return best || DEFAULT_IPC_SERIE_ID;
  }

  /**
   * Obtiene IPC mensual desde API oficial. Cache en memoria y localStorage (TTL 24h).
   * Retorna Promise<{ ipcMap: { "YYYY-MM": number }, ipcInterpolated?: boolean }>.
   */
  function fetchIPCSeries() {
    var now = Date.now();
    if (_ipcCache && (now - _ipcCacheTs) < IPC_CACHE_TTL_MS) {
      return Promise.resolve(_ipcCache);
    }
    try {
      var stored = typeof localStorage !== 'undefined' && localStorage.getItem(IPC_STORAGE_KEY);
      var storedTs = typeof localStorage !== 'undefined' && localStorage.getItem(IPC_STORAGE_TS_KEY);
      if (stored && storedTs && (now - parseInt(storedTs, 10)) < IPC_CACHE_TTL_MS) {
        var parsed = JSON.parse(stored);
        _ipcCache = parsed;
        _ipcCacheTs = now;
        return Promise.resolve(parsed);
      }
    } catch (e) { /* ignore */ }

    var searchUrl = API_IPC_SEARCH + '?q=ipc%20nivel%20general&limit=30';
    if (typeof console !== 'undefined' && console.log) console.log('[BetaCAPM] IPC search:', searchUrl);

    return fetch(searchUrl).then(function (r) {
      if (!r.ok) throw new Error('No se pudo cargar IPC desde API oficial.');
      return r.json();
    }).then(function (searchRes) {
      var serieId = findIpcSerieId(searchRes);
      var seriesUrl = API_IPC_SERIES + '?ids=' + encodeURIComponent(serieId) + '&collapse=month&collapse_aggregation=end_of_period&format=json&metadata=none&limit=5000';
      if (typeof console !== 'undefined' && console.log) console.log('[BetaCAPM] IPC series:', seriesUrl);
      return fetch(seriesUrl).then(function (r2) {
        if (!r2.ok) throw new Error('No se pudo cargar IPC desde API oficial.');
        return r2.json();
      }).then(function (seriesRes) {
        var data = (seriesRes && seriesRes.data) || [];
        var ipcMap = {};
        for (var j = 0; j < data.length; j++) {
          var row = data[j];
          var dateStr = Array.isArray(row) ? row[0] : (row && row.indice_tiempo);
          var val = Array.isArray(row) ? row[1] : (row && (row.valor != null ? row.valor : row[Object.keys(row)[1]]));
          if (dateStr && val != null && !isNaN(Number(val))) {
            var ym = String(dateStr).slice(0, 7);
            ipcMap[ym] = Number(val);
          }
        }
        if (Object.keys(ipcMap).length < 12) throw new Error('No se pudo cargar IPC desde API oficial.');
        var result = { ipcMap: ipcMap };
        _ipcCache = result;
        _ipcCacheTs = Date.now();
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(IPC_STORAGE_KEY, JSON.stringify(result));
            localStorage.setItem(IPC_STORAGE_TS_KEY, String(_ipcCacheTs));
          }
        } catch (e2) { /* ignore */ }
        return result;
      });
    }).catch(function (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[BetaCAPM] IPC fetch error:', err);
      throw new Error('No se pudo cargar IPC desde API oficial.');
    });
  }

  /** Compat: loadIpc() ahora devuelve Promise<{ ipcMap }>; getIpcMap(that) devuelve ipcMap. */
  function loadIpc() {
    return fetchIPCSeries();
  }

  function getIpcMap(ipcResult) {
    if (ipcResult && ipcResult.ipcMap) return ipcResult.ipcMap;
    var map = {};
    if (Array.isArray(ipcResult)) {
      for (var i = 0; i < ipcResult.length; i++) {
        var row = ipcResult[i];
        var ym = (row && (row.ym || row.date)) || '';
        if (ym && row.index != null) map[ym] = Number(row.index);
      }
    }
    return map;
  }

  /**
   * Dado un ipcMap, devuelve el valor IPC para un mes; si falta, último disponible anterior.
   * Marca ipcInterpolated si se usó interpolación.
   */
  function getIpcForMonth(ipcMap, ym) {
    if (ipcMap[ym] != null && ipcMap[ym] > 0) return { value: ipcMap[ym], interpolated: false };
    var keys = Object.keys(ipcMap).filter(function (k) { return ipcMap[k] > 0; }).sort();
    for (var i = keys.length - 1; i >= 0; i--) {
      if (keys[i] <= ym) return { value: ipcMap[keys[i]], interpolated: true };
    }
    return null;
  }

  /**
   * GET histórico solo stocks (Acciones AR). Errores específicos: CORS/red, 429, 404/vacío.
   * Nunca llamar con ticker "MERVAL".
   */
  function fetchSeries(ticker) {
    var t = (ticker || '').toUpperCase();
    if (t === 'MERVAL') return Promise.reject(new Error('MERVAL no es un ticker: usá el índice sintético (benchmark = MERVAL).'));
    var url = API_HISTORICAL + '/stocks/' + encodeURIComponent(t);
    if (typeof console !== 'undefined' && console.log) console.log('[BetaCAPM] Data912:', url);
    return fetch(url).then(function (r) {
      if (r.status === 429) throw new Error('Rate limit: esperá y reintentá.');
      if (r.status === 404 || !r.ok) throw new Error('Ticker sin histórico en Data912.');
      return r.json();
    }).then(function (data) {
      if (!Array.isArray(data) || data.length === 0) throw new Error('Ticker sin histórico en Data912.');
      return data.slice().sort(function (a, b) { return a.date > b.date ? 1 : -1; });
    }).catch(function (err) {
      if (err.message && (err.message.indexOf('Rate limit') >= 0 || err.message.indexOf('Ticker') >= 0)) throw err;
      throw new Error('No se pudo conectar con Data912 (network/CORS). Probá recargar o usar https.');
    });
  }

  /** Inner join por fecha. Retorna [{ date, pA, pB }]. Para mensual usar date YYYY-MM. */
  function alignPrices(assetSeries, benchSeries) {
    var benchMap = {};
    for (var i = 0; i < benchSeries.length; i++) {
      var c = benchSeries[i].c;
      if (c != null && c > 0) benchMap[benchSeries[i].date] = c;
    }
    var out = [];
    for (var j = 0; j < assetSeries.length; j++) {
      var d = assetSeries[j].date;
      var pA = assetSeries[j].c;
      var pB = benchMap[d];
      if (pA != null && pA > 0 && pB != null) out.push({ date: d, pA: pA, pB: pB });
    }
    return out;
  }

  function alignByMonth(a, b) { return alignPrices(a, b); }

  /** Ventana: end = última fecha; start = end - months; MAX sin filtro. */
  function windowFilterPrices(aligned, months) {
    if (!aligned.length) return [];
    if (months == null) return aligned;
    var endDate = new Date(aligned[aligned.length - 1].date);
    var start = new Date(endDate);
    start.setMonth(start.getMonth() - months);
    var startStr = start.toISOString().slice(0, 10);
    return aligned.filter(function (x) { return x.date >= startStr; });
  }

  /**
   * Resample una sola serie a mensual (último c de cada mes). Retorna [{ date: "YYYY-MM", c }].
   */
  function resampleSeriesToMonthly(series) {
    if (!series.length) return [];
    var byKey = {};
    for (var i = 0; i < series.length; i++) {
      var d = new Date(series[i].date);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      byKey[key] = series[i];
    }
    var keys = Object.keys(byKey).sort();
    return keys.map(function (k) { return { date: k, c: byKey[k].c }; });
  }

  function toMonthlySeries(series) { return resampleSeriesToMonthly(series); }

  /**
   * Resample alineado (pA, pB) a mensual: último de cada mes. Clave YYYY-MM.
   * Retorna [{ date: "YYYY-MM", dateLast, pA, pB }].
   */
  function resampleToMonthly(aligned) {
    if (!aligned.length) return [];
    var byKey = {};
    for (var i = 0; i < aligned.length; i++) {
      var d = new Date(aligned[i].date);
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      byKey[key] = aligned[i];
    }
    var keys = Object.keys(byKey).sort();
    return keys.map(function (k) {
      var row = byKey[k];
      return { date: k, dateLast: row.date, pA: row.pA, pB: row.pB };
    });
  }

  /**
   * Resample alineado a semanal: último precio de cada semana (ISO week).
   * Retorna [{ date: "YYYY-MM-DD", pA, pB }] con date = último día de la semana en los datos.
   */
  function resampleToWeekly(aligned) {
    if (!aligned.length) return [];
    var byKey = {};
    for (var i = 0; i < aligned.length; i++) {
      var d = new Date(aligned[i].date);
      var jan1 = new Date(d.getFullYear(), 0, 1);
      var weekNum = Math.ceil((((d - jan1) / 86400000) + jan1.getDay() + 1) / 7);
      var key = d.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
      byKey[key] = aligned[i];
    }
    var keys = Object.keys(byKey).sort();
    return keys.map(function (k) {
      var row = byKey[k];
      return { date: row.date, pA: row.pA, pB: row.pB };
    });
  }

  /** Filtra serie mensual [{ date, c }] por ventana (end = último mes; start = end - months). */
  function windowFilterMonthly(monthlyRows, months) {
    if (!monthlyRows.length) return [];
    if (months == null) return monthlyRows;
    var endKey = monthlyRows[monthlyRows.length - 1].date;
    var end = new Date(endKey + '-01');
    var start = new Date(end);
    start.setMonth(start.getMonth() - months);
    var startKey = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0');
    return monthlyRows.filter(function (r) { return r.date >= startKey && r.date <= endKey; });
  }

  /**
   * Recorta la serie mensual al rango donde hay IPC disponible (o interpolado con último anterior).
   * Si falta IPC para un mes se usa getIpcForMonth (último disponible); si no hay ninguno se recorta.
   */
  function clipToIpcRange(monthlyRows, ipcMap) {
    var out = [];
    var anyInterpolated = false;
    for (var i = 0; i < monthlyRows.length; i++) {
      var key = monthlyRows[i].date;
      var ipcInfo = getIpcForMonth(ipcMap, key);
      if (ipcInfo && ipcInfo.value > 0) {
        out.push(monthlyRows[i]);
        if (ipcInfo.interpolated) anyInterpolated = true;
      }
    }
    var firstMonth = out.length ? out[0].date : null;
    var lastMonth = out.length ? out[out.length - 1].date : null;
    return { series: out, clipped: out.length < monthlyRows.length, firstMonth: firstMonth, lastMonth: lastMonth, ipcInterpolated: anyInterpolated };
  }

  /**
   * Convierte precios nominales mensuales a reales: P_real = P_nom / (IPC_t / IPC_base).
   * IPC_base = IPC del primer mes de la ventana (para normalizar).
   * monthlyRows: [{ date, pA, pB }] o [{ date, c }]. Retorna mismo formato con precios deflactados.
   */
  function deflateToReal(monthlyRows, ipcMap) {
    if (!monthlyRows.length) return [];
    var firstKey = monthlyRows[0].date;
    var ipcBaseInfo = getIpcForMonth(ipcMap, firstKey);
    var ipcBase = ipcBaseInfo ? ipcBaseInfo.value : (ipcMap[firstKey] || 0);
    if (ipcBase == null || ipcBase <= 0) return [];
    var out = [];
    for (var i = 0; i < monthlyRows.length; i++) {
      var key = monthlyRows[i].date;
      var ipcInfo = getIpcForMonth(ipcMap, key);
      var ipc = ipcInfo ? ipcInfo.value : (ipcMap[key] || 0);
      if (ipc == null || ipc <= 0) continue;
      var ratio = ipc / ipcBase;
      if (monthlyRows[i].pA != null && monthlyRows[i].pB != null) {
        out.push({ date: key, pA: monthlyRows[i].pA / ratio, pB: monthlyRows[i].pB / ratio });
      } else {
        out.push({ date: key, c: monthlyRows[i].c / ratio });
      }
    }
    return out;
  }

  /**
   * IPC mensual aplicado por escalones (LOCF): para cada fecha YYYY-MM-DD se usa el IPC del mes YYYY-MM.
   * Para series diarias o semanales. Retorna [{ date, pA, pB }] con precios deflactados.
   */
  function deflateToRealWithIpcLocf(rows, ipcMap) {
    if (!rows.length) return [];
    var firstDate = rows[0].date;
    var firstYm = String(firstDate).slice(0, 7);
    var ipcBaseInfo = getIpcForMonth(ipcMap, firstYm);
    var ipcBase = ipcBaseInfo ? ipcBaseInfo.value : (ipcMap[firstYm] || 0);
    if (ipcBase == null || ipcBase <= 0) return [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var ym = String(rows[i].date).slice(0, 7);
      var ipcInfo = getIpcForMonth(ipcMap, ym);
      var ipc = ipcInfo ? ipcInfo.value : (ipcMap[ym] || 0);
      if (ipc == null || ipc <= 0) continue;
      var ratio = ipc / ipcBase;
      out.push({ date: rows[i].date, pA: rows[i].pA / ratio, pB: rows[i].pB / ratio });
    }
    return out;
  }

  /** Deflacta una serie mensual [{ date, c }] a real. Retorna [{ date, c }]. */
  function deflateSeriesToReal(monthlySeries, ipcMap) {
    return deflateToReal(monthlySeries, ipcMap);
  }

  function deflateMonthly(monthlyRows, ipcMap) { return deflateToReal(monthlyRows, ipcMap); }

  /**
   * Retornos reales log mensuales: r_t = ln(P_real_t / P_real_{t-1}).
   * Anti-split: si P_t/P_{t-1} > 3 o < 1/3 se omite ese retorno; si hay >3 eventos se marca para abortar.
   * Retorna { ri, rm, n, first, last, antiSplitEvents, antiSplitApplied }.
   */
  function realLogReturns(realMonthly) {
    var ri = [], rm = [];
    var first = null, last = null;
    var antiSplitEvents = 0;
    var antiSplitApplied = false;
    for (var i = 1; i < realMonthly.length; i++) {
      var prev = realMonthly[i - 1];
      var curr = realMonthly[i];
      if (prev.pA <= 0 || prev.pB <= 0 || curr.pA <= 0 || curr.pB <= 0) continue;
      var ratioA = curr.pA / prev.pA;
      var ratioB = curr.pB / prev.pB;
      if (ratioA > ANTI_SPLIT_RATIO_HI || ratioA < ANTI_SPLIT_RATIO_LO || ratioB > ANTI_SPLIT_RATIO_HI || ratioB < ANTI_SPLIT_RATIO_LO) {
        antiSplitEvents++;
        antiSplitApplied = true;
        if (antiSplitEvents > ANTI_SPLIT_MAX_EVENTS) break;
        continue;
      }
      ri.push(Math.log(ratioA));
      rm.push(Math.log(ratioB));
      if (first == null) first = { pA: prev.pA, pB: prev.pB };
      last = { pA: curr.pA, pB: curr.pB };
    }
    if (first == null && realMonthly.length) first = { pA: realMonthly[0].pA, pB: realMonthly[0].pB };
    if (last == null && realMonthly.length) last = realMonthly[realMonthly.length - 1];
    return { ri: ri, rm: rm, n: ri.length, first: first, last: last, antiSplitEvents: antiSplitEvents, antiSplitApplied: antiSplitApplied };
  }

  function computeLogReturns(realMonthly) { return realLogReturns(realMonthly); }

  function mean(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  /** Retorno real anual equivalente: exp(periodsPerYear * mean(log returns)) - 1. */
  function realAnnualFromLogReturns(logReturns, periods) {
    if (!logReturns.length || periods <= 0) return null;
    var m = mean(logReturns);
    return Math.exp(periods * m) - 1;
  }

  function realAnnualFromMonthlyLogReturns(logReturns) {
    return realAnnualFromLogReturns(logReturns, PERIODS_MONTHLY);
  }

  /** Beta = Cov(ri, rm) / Var(rm) con n-1. Retorna también correlación para validación. */
  function computeBeta(ri, rm) {
    var n = ri.length;
    if (n < 2) return { beta: 0, varRm: 0, correlation: 0 };
    var meanRi = mean(ri);
    var meanRm = mean(rm);
    var sumRm2 = 0, sumRi2 = 0, sumRiRm = 0;
    for (var i = 0; i < n; i++) {
      var dRi = ri[i] - meanRi;
      var dRm = rm[i] - meanRm;
      sumRm2 += dRm * dRm;
      sumRi2 += dRi * dRi;
      sumRiRm += dRi * dRm;
    }
    var varRm = sumRm2 / (n - 1);
    var varRi = sumRi2 / (n - 1);
    if (varRm <= VAR_RM_EPS) return { beta: 0, varRm: 0, correlation: 0 };
    var beta = sumRiRm / (n - 1) / varRm;
    var sigmaRi = Math.sqrt(varRi);
    var sigmaRm = Math.sqrt(varRm);
    var correlation = (sigmaRi > 0 && sigmaRm > 0) ? (sumRiRm / (n - 1)) / (sigmaRi * sigmaRm) : 0;
    return { beta: beta, varRm: varRm, correlation: correlation };
  }

  /**
   * Semáforo calidad: 'green' | 'yellow' | 'red'.
   * RED: n < 12 o Var(rm) ~ 0 o IPC insuficiente -> bloquear cálculo.
   * YELLOW: n < 36 o recorte por IPC > 20% de la ventana.
   * GREEN: n >= 36 y sin recorte fuerte.
   */
  function dataQualitySemaphore(n, clipPct, varRm, ipcOk) {
    if (n < MIN_OBS_RED || (varRm != null && varRm <= VAR_RM_EPS) || ipcOk === false) return 'red';
    if (n < MIN_OBS_WARNING || (clipPct != null && clipPct > 0.2)) return 'yellow';
    return 'green';
  }

  /**
   * MERVAL sintético REAL: equal-weight dinámico (solo componentes disponibles ese mes).
   * Nunca hace fetch a "MERVAL". Retorna { series: [{ date, c }], avgComponentsPerMonth }.
   */
  function buildMervalSynthetic(months, ipcMap) {
    var ipcKeys = Object.keys(ipcMap).filter(function (k) { return ipcMap[k] > 0; }).sort();
    if (ipcKeys.length < 2) return Promise.reject(new Error('IPC insuficiente para MERVAL sintético.'));
    var endKey = ipcKeys[ipcKeys.length - 1];
    var end = new Date(endKey + '-01');
    var start = new Date(end);
    start.setMonth(start.getMonth() - (months || 120));
    var startKey = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0');

    return Promise.all(MERVAL_BASKET.map(function (t) { return fetchSeries(t).catch(function () { return []; }); })).then(function (results) {
      var validTickers = results.filter(function (arr) { return arr.length >= 2; });
      if (validTickers.length < MERVAL_MIN_COMPONENTS) {
        return Promise.reject(new Error('MERVAL sintético sin cobertura suficiente en la ventana (mín. ' + MERVAL_MIN_COMPONENTS + ' acciones con datos).'));
      }
      var ipcBase = ipcMap[endKey] || 1;
      var byMonth = {};

      for (var j = 0; j < results.length; j++) {
        if (results[j].length < 2) continue;
        var monthly = resampleSeriesToMonthly(results[j]);
        var filtered = windowFilterMonthly(monthly, months);
        var clip = clipToIpcRange(filtered, ipcMap);
        if (!clip.series.length) continue;
        var real = deflateSeriesToReal(clip.series, ipcMap);
        for (var i = 0; i < real.length; i++) {
          var key = real[i].date;
          if (key < startKey || key > endKey) continue;
          if (!byMonth[key]) byMonth[key] = {};
          if (real[i].c != null && real[i].c > 0) byMonth[key][j] = real[i].c;
        }
      }

      var monthKeys = Object.keys(byMonth).sort();
      if (monthKeys.length < 2) return Promise.reject(new Error('MERVAL sintético: pocos meses con datos en el basket.'));

      var out = [];
      var base = 100;
      out.push({ date: monthKeys[0], c: base });
      var sumComponents = 0;

      for (var t = 1; t < monthKeys.length; t++) {
        var prevKey = monthKeys[t - 1];
        var currKey = monthKeys[t];
        var prevRow = byMonth[prevKey];
        var currRow = byMonth[currKey];
        var sumRet = 0;
        var count = 0;
        for (var tickerIdx in currRow) {
          if (currRow[tickerIdx] > 0 && prevRow[tickerIdx] > 0) {
            sumRet += Math.log(currRow[tickerIdx] / prevRow[tickerIdx]);
            count++;
          }
        }
        sumComponents += count;
        var avgLogRet = count ? sumRet / count : 0;
        base = base * Math.exp(avgLogRet);
        out.push({ date: currKey, c: base });
      }

      var avgComponentsPerMonth = monthKeys.length > 1 ? sumComponents / (monthKeys.length - 1) : 0;
      return { series: out, avgComponentsPerMonth: avgComponentsPerMonth };
    });
  }

  /** Compat: mismo formato que antes (solo serie) usando buildMervalSynthetic. */
  function fetchMervalSyntheticReal(assetSeries, months, ipcMap) {
    return buildMervalSynthetic(months, ipcMap).then(function (o) { return o.series; });
  }

  // --- CER (bonos) para Rf real local. Listado fijo; solo ticker (se envía tal cual a la API). ---
  function isInCerWhitelist(ticker) {
    var t = (ticker || '').toUpperCase();
    return CER_TICKERS.indexOf(t) >= 0;
  }

  /** Listado de bonos CER: solo tickers (sin detalle) para que la API los encuentre. */
  function fetchCerUniverse() {
    var options = CER_TICKERS.map(function (t) { return { value: t, ticker: t, label: t, verified: true }; });
    return Promise.resolve({ options: options, isFallback: false });
  }

  /** Mantiene opciones; ventana solo para compatibilidad. */
  function filterCerByWindow(options, ventana) {
    return (options || []).map(function (o) {
      var t = (o.ticker || o.value || '').toUpperCase();
      return { value: o.value, ticker: o.ticker, label: o.label || t, verified: o.verified !== false };
    });
  }

  /** Listado de acciones argentinas (Data912 /live/arg_stocks). Solo tickers para el select Activo. */
  function fetchArgStocks() {
    var url = API_BASE + '/live/arg_stocks';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('No se pudo listar acciones.');
      return r.json();
    }).then(function (data) {
      var list = (Array.isArray(data) ? data : (data && data.stocks) || (data && data.data) || []).slice();
      var seen = {};
      var options = [];
      for (var i = 0; i < list.length; i++) {
        var t = (list[i].symbol || list[i].ticker || list[i].id || '').toUpperCase();
        if (!t || seen[t]) continue;
        seen[t] = true;
        options.push({ value: t, label: t });
      }
      options.sort(function (a, b) { return a.value.localeCompare(b.value); });
      return options;
    }).catch(function () {
      return [];
    });
  }

  /** Histórico de precios de bono (Data912). Formato igual que stocks: [{ date, c }]. */
  function fetchBondSeries(ticker) {
    var t = (ticker || '').toUpperCase();
    var url = API_HISTORICAL + '/bonds/' + encodeURIComponent(t);
    return fetch(url).then(function (r) {
      if (r.status === 429) throw new Error('Rate limit: esperá y reintentá.');
      if (r.status === 404 || !r.ok) throw new Error('Bono sin histórico en Data912.');
      return r.json();
    }).then(function (data) {
      var arr = Array.isArray(data) ? data : (data && data.data) || (data && data.prices) || [];
      if (arr.length === 0) throw new Error('Bono sin histórico en Data912.');
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].c == null && arr[i].close != null) arr[i].c = arr[i].close;
      }
      return arr.slice().sort(function (a, b) { return (a.date || '') > (b.date || '') ? 1 : -1; });
    }).catch(function (err) {
      if (err.message && err.message.indexOf('Rate limit') >= 0) throw err;
      if (err.message && err.message.indexOf('Bono') >= 0) throw err;
      throw new Error('No se pudo conectar con Data912 (network/CORS).');
    });
  }

  /**
   * Rf real anual desde bono CER: prioridad 1 yield/TIR real de API; prioridad 2 aproximación desde precios deflactados.
   * bondSeries: [{ date, c }] o con .yield; ipcMap; months para ventana.
   * Retorna número (decimal) o rechaza con mensaje claro.
   */
  function getCerYieldFromPrices(bondSeries, ipcMap, months) {
    if (!bondSeries || bondSeries.length < 2) throw new Error('No hay rendimiento CER disponible para este bono en la API.');
    var arr = bondSeries.slice();
    for (var i = 0; i < arr.length; i++) {
      var row = arr[i];
      if (row.yield != null && !isNaN(parseFloat(row.yield))) return parseFloat(row.yield) / 100;
      if (row.ytm != null && !isNaN(parseFloat(row.ytm))) return parseFloat(row.ytm) / 100;
      if (row.tea != null && !isNaN(parseFloat(row.tea))) return parseFloat(row.tea) / 100;
    }
    var monthly = resampleSeriesToMonthly(arr);
    var filtered = windowFilterMonthly(monthly, months);
    var clip = clipToIpcRange(filtered, ipcMap);
    if (!clip.series.length) throw new Error('No hay rendimiento CER disponible para este bono en la API.');
    var real = deflateSeriesToReal(clip.series, ipcMap);
    if (real.length < 2) throw new Error('No hay rendimiento CER disponible para este bono en la API.');
    var logReturns = [];
    for (var j = 1; j < real.length; j++) {
      if (real[j].c > 0 && real[j - 1].c > 0) logReturns.push(Math.log(real[j].c / real[j - 1].c));
    }
    if (logReturns.length < 2) throw new Error('No hay rendimiento CER disponible para este bono en la API.');
    return realAnnualFromMonthlyLogReturns(logReturns);
  }

  /** Obtiene Rf real del bono CER seleccionado (API o precios). */
  function fetchCerYield(ticker, ipcMap, months) {
    return fetchBondSeries(ticker).then(function (series) {
      return getCerYieldFromPrices(series, ipcMap, months);
    });
  }

  /**
   * SML en términos reales: X = beta, Y = retorno real anual (%).
   * Puntos: (0, rf_real), (1, Rm_real), (beta, Ri_real); línea vertical α; sin punto CAPM.
   */
  function drawSML(canvas, opts) {
    var rf = opts.rf;
    var Rm_real = opts.Rm_real;
    var Ri_real = opts.Ri_real;
    var beta = opts.beta;
    var alpha = opts.alpha;
    var assetTicker = opts.assetTicker || 'Activo';
    var ventanaLabel = opts.ventanaLabel || '';

    var E_Ri = rf + beta * (Rm_real - rf);
    var aboveSML = Ri_real > E_Ri;

    var betaMax = Math.max(2, beta * 1.3);
    if (betaMax < 0.5) betaMax = 2;
    var yAtEnd = rf + betaMax * (Rm_real - rf);

    var yMin = Math.min(rf, Rm_real, Ri_real, yAtEnd);
    var yMax = Math.max(rf, Rm_real, Ri_real, yAtEnd);
    var marginY = (yMax - yMin) * 0.12 || 0.01;
    yMin -= marginY;
    yMax += marginY;

    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    var w = rect.width, h = rect.height;
    var pad = { top: 40, right: 140, bottom: 48, left: 60 };
    var plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;

    function toX(b) { return pad.left + (b / betaMax) * plotW; }
    function toY(y) { return pad.top + plotH - ((y - yMin) / (yMax - yMin)) * plotH; }

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    var labelFont = '13px system-ui, sans-serif';
    var yStep = (yMax - yMin) / 5;
    ctx.fillStyle = '#8b949e';
    ctx.font = labelFont;
    ctx.textAlign = 'right';
    for (var yi = 0; yi <= 5; yi++) {
      var yVal = yMin + yi * yStep;
      var yy = toY(yVal);
      if (yy >= pad.top && yy <= pad.top + plotH) ctx.fillText((yVal * 100).toFixed(1) + '%', pad.left - 6, yy + 4);
    }
    ctx.textAlign = 'center';
    var xTicks = [0, 0.5, 1, 1.5, 2];
    if (betaMax > 2) xTicks.push(betaMax);
    for (var xi = 0; xi < xTicks.length; xi++) {
      var b = xTicks[xi];
      if (b > betaMax) continue;
      ctx.fillText(b.toFixed(2), toX(b), pad.top + plotH + 14);
    }

    ctx.strokeStyle = 'rgba(88, 166, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(rf));
    ctx.lineTo(toX(betaMax), toY(yAtEnd));
    ctx.stroke();

    var ax = toX(beta), ayReal = toY(Ri_real), aySML = toY(E_Ri);
    var midY = (ayReal + aySML) / 2;

    function drawLabel(x, y, text, color, align) {
      ctx.fillStyle = color || '#e6edf3';
      ctx.font = labelFont;
      ctx.textAlign = align || 'left';
      ctx.fillText(text, x, y + 5);
    }

    ctx.strokeStyle = aboveSML ? 'rgba(63, 185, 80, 0.8)' : 'rgba(248, 81, 73, 0.8)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ax, aySML);
    ctx.lineTo(ax, ayReal);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = aboveSML ? '#3fb950' : '#f85149';
    ctx.font = labelFont;
    ctx.textAlign = 'right';
    ctx.fillText('α = ' + (alpha * 100).toFixed(2) + '%', ax - 8, midY + 5);

    ctx.fillStyle = 'rgba(139, 148, 158, 0.95)';
    ctx.beginPath();
    ctx.arc(toX(0), toY(rf), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    drawLabel(toX(0) + 12, toY(rf), 'Rf ' + (rf * 100).toFixed(2) + '%', '#8b949e');

    ctx.fillStyle = 'rgba(139, 148, 158, 0.95)';
    ctx.beginPath();
    ctx.arc(toX(1), toY(Rm_real), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    drawLabel(toX(1) + 12, toY(Rm_real), 'Benchmark ' + (Rm_real * 100).toFixed(2) + '%', '#8b949e');

    ctx.fillStyle = aboveSML ? '#3fb950' : '#f85149';
    ctx.beginPath();
    ctx.arc(ax, ayReal, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    drawLabel(ax + 14, ayReal, assetTicker + '  β=' + beta.toFixed(2) + '  ' + (Ri_real * 100).toFixed(2) + '%', aboveSML ? '#3fb950' : '#f85149');

    ctx.fillStyle = '#8b949e';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('β (beta)', pad.left + plotW / 2, h - 8);
    ctx.save();
    ctx.translate(16, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Rendimiento real anual (%)', 0, 0);
    ctx.restore();
  }

  window.BetaCapm = {
    loadIpc: loadIpc,
    fetchIPCSeries: fetchIPCSeries,
    getIpcMap: getIpcMap,
    getIpcForMonth: getIpcForMonth,
    windowMonths: windowMonths,
    periodsPerYear: periodsPerYear,
    minObsWarningByFreq: minObsWarningByFreq,
    rfPeriodic: rfPeriodic,
    resampleToWeekly: resampleToWeekly,
    deflateToRealWithIpcLocf: deflateToRealWithIpcLocf,
    realAnnualFromLogReturns: realAnnualFromLogReturns,
    fetchSeries: fetchSeries,
    alignPrices: alignPrices,
    alignByMonth: alignByMonth,
    windowFilterPrices: windowFilterPrices,
    resampleSeriesToMonthly: resampleSeriesToMonthly,
    toMonthlySeries: toMonthlySeries,
    windowFilterMonthly: windowFilterMonthly,
    resampleToMonthly: resampleToMonthly,
    clipToIpcRange: clipToIpcRange,
    deflateToReal: deflateToReal,
    deflateSeriesToReal: deflateSeriesToReal,
    deflateMonthly: deflateMonthly,
    realLogReturns: realLogReturns,
    computeLogReturns: computeLogReturns,
    realAnnualFromMonthlyLogReturns: realAnnualFromMonthlyLogReturns,
    computeBeta: computeBeta,
    buildMervalSynthetic: buildMervalSynthetic,
    fetchMervalSyntheticReal: fetchMervalSyntheticReal,
    dataQualitySemaphore: dataQualitySemaphore,
    fetchCerUniverse: fetchCerUniverse,
    fetchArgStocks: fetchArgStocks,
    filterCerByWindow: filterCerByWindow,
    fetchBondSeries: fetchBondSeries,
    fetchCerYield: fetchCerYield,
    getCerYieldFromPrices: getCerYieldFromPrices,
    drawSML: drawSML,
    MERVAL_BASKET: MERVAL_BASKET,
    MIN_OBS_WARNING: MIN_OBS_WARNING,
    MIN_OBS_RED: MIN_OBS_RED,
    VAR_RM_EPS: VAR_RM_EPS,
    CORR_LOW_THRESHOLD: CORR_LOW_THRESHOLD,
    ANTI_SPLIT_MAX_EVENTS: ANTI_SPLIT_MAX_EVENTS,
  };
})();
