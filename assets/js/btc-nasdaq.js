/**
 * btc-nasdaq.js — Evolución BTC vs NASDAQ (2016 a la fecha)
 * BTC: Coinbase / CoinGecko. NASDAQ: índice sintético Data912 (101 componentes) o fallback Yahoo/QQQ/sintético.
 */
(function () {
  'use strict';

  var FETCH_TIMEOUT_MS = 15000;
  var COINBASE_CANDLES = 'https://api.exchange.coinbase.com/products/BTC-USD/candles';
  var COINGECKO_RANGE = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range';
  var DATA912_BASE = 'https://data912.com';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  var CACHE_KEY_PREFIX = 'fintools_ndx_';
  var CONCURRENCY = 8;
  var MIN_TICKERS_WARNING = 60;
  var CORS_PROXY = 'https://api.allorigins.win/raw?url=';
  var YAHOO_IXIC = 'https://query1.finance.yahoo.com/v8/finance/chart/^IXIC';
  var YAHOO_QQQ = 'https://query1.finance.yahoo.com/v8/finance/chart/QQQ';
  var CANDLES_PER_REQUEST = 300;
  var SECONDS_PER_DAY = 86400;

  /** Lista EXACTA Nasdaq-100 sintético (101 símbolos; incluye GOOGL y GOOG). */
  var NASDAQ_100_TICKERS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'GOOG', 'META', 'AVGO', 'TSLA', 'WMT', 'ASML', 'MU', 'COST', 'AMD', 'NFLX', 'PLTR', 'CSCO', 'LRCX', 'AMAT', 'TMUS', 'INTC', 'LIN', 'PEP', 'TXN', 'AMGN', 'KLAC', 'GILD', 'ISRG', 'ADI', 'HON', 'QCOM', 'SHOP', 'PDD', 'ARM', 'BKNG', 'PANW', 'APP', 'VRTX', 'CMCSA', 'CEG', 'SBUX', 'ADBE', 'INTU', 'CRWD', 'MELI', 'WDC', 'MAR', 'STX', 'ADP', 'REGN', 'MNST', 'SNPS', 'ORLY', 'CTAS', 'CDNS', 'MDLZ', 'CSX', 'ABNB', 'WBD', 'AEP', 'DASH', 'MRVL', 'PCAR', 'ROST', 'NXPI', 'FTNT', 'BKR', 'MPWR', 'FAST', 'FER', 'IDXX', 'EA', 'EXC', 'FANG', 'ADSK', 'XEL', 'CCEP', 'ALNY', 'DDOG', 'MSTR', 'MCHP', 'ODFL', 'KDP', 'WDAY', 'PYPL', 'GEHC', 'TRI', 'CPRT', 'TTWO', 'AXON', 'ROP', 'PAYX', 'INSM', 'CTSH', 'CHTR', 'KHC', 'ZS', 'DXCM', 'VRSK', 'TEAM', 'CSGP'];

  function dateStrFromUnix(sec) {
    var d = new Date(sec * 1000);
    var y = d.getUTCFullYear();
    var m = ('0' + (d.getUTCMonth() + 1)).slice(-2);
    var day = ('0' + d.getUTCDate()).slice(-2);
    return y + '-' + m + '-' + day;
  }

  function dateToUnix(dateStr) {
    if (!dateStr) return NaN;
    return Math.floor(new Date(dateStr + 'T12:00:00Z').getTime() / 1000);
  }

  function fetchWithTimeout(url, options) {
    options = options || {};
    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    options.signal = controller.signal;
    return fetch(url, options).then(function (r) {
      clearTimeout(timeoutId);
      return r;
    }, function (err) {
      clearTimeout(timeoutId);
      throw err;
    });
  }

  /** Fetch URL through CORS proxy; parse response as JSON. */
  function fetchViaProxy(yahooUrl) {
    var proxyUrl = CORS_PROXY + encodeURIComponent(yahooUrl);
    return fetchWithTimeout(proxyUrl).then(function (r) {
      if (!r.ok) throw new Error('Proxy: ' + r.status);
      return r.text();
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('NASDAQ: respuesta inválida.');
      }
    });
  }

  function parseYahooChartResponse(data) {
    var chart = data && data.chart;
    var result = chart && chart.result && chart.result[0];
    if (!result) throw new Error('Sin datos en la respuesta.');
    var timestamps = result.timestamp || [];
    var quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    var closes = quote.close || [];
    var out = [];
    for (var i = 0; i < timestamps.length; i++) {
      var c = closes[i];
      if (c == null || typeof c !== 'number' || !isFinite(c)) continue;
      out.push({ date: dateStrFromUnix(timestamps[i]), value: c });
    }
    return out;
  }

  /** Ejecuta tareas con límite de concurrencia (ej. 8 en paralelo). */
  function runWithConcurrency(tasks, concurrency, onProgress) {
    var index = 0;
    var completed = 0;
    var total = tasks.length;
    function runNext() {
      if (index >= total) return Promise.resolve();
      var i = index++;
      return tasks[i]().then(function (result) {
        completed++;
        if (onProgress) onProgress(completed, total);
        return runNext();
      });
    }
    var workers = [];
    for (var w = 0; w < concurrency && w < total; w++) {
      workers.push(runNext());
    }
    return Promise.all(workers);
  }

  function getCachedTicker(ticker, lastDate) {
    try {
      var key = CACHE_KEY_PREFIX + ticker + '_' + (lastDate || '');
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj.ts && (Date.now() - obj.ts) > CACHE_TTL_MS) return null;
      return obj.series || null;
    } catch (e) {
      return null;
    }
  }

  function setCachedTicker(ticker, lastDate, series) {
    try {
      var key = CACHE_KEY_PREFIX + ticker + '_' + (lastDate || '');
      localStorage.setItem(key, JSON.stringify({ series: series, ts: Date.now() }));
    } catch (e) {}
  }

  /** Obtiene serie de precios (c o close) desde Data912: cedears y luego stocks. */
  function fetchOneTickerData912(ticker) {
    var t = (ticker || '').toUpperCase();
    var urls = [
      DATA912_BASE + '/historical/cedears/' + encodeURIComponent(t),
      DATA912_BASE + '/historical/stocks/' + encodeURIComponent(t)
    ];
    function tryUrl(i) {
      if (i >= urls.length) return Promise.resolve(null);
      return fetchWithTimeout(urls[i])
        .then(function (r) {
          if (!r.ok) return tryUrl(i + 1);
          return r.json();
        })
        .then(function (data) {
          var arr = Array.isArray(data) ? data : (data && data.data) || (data && data.prices) || [];
          if (!arr.length) return tryUrl(i + 1);
          var out = [];
          for (var j = 0; j < arr.length; j++) {
            var row = arr[j];
            var c = row && (row.c != null ? row.c : row.close);
            var d = row && (row.date || row.Date);
            if (typeof c !== 'number' || !isFinite(c) || c <= 0 || !d) continue;
            out.push({ date: String(d).slice(0, 10), value: c });
          }
          out.sort(function (a, b) { return a.date.localeCompare(b.date); });
          return out.length ? out : tryUrl(i + 1);
        })
        .catch(function () { return tryUrl(i + 1); });
    }
    return tryUrl(0);
  }

  /**
   * Construye Nasdaq-100 sintético (equal-weight, base 100 por ticker) desde Data912.
   * Por ticker: idx_i(t) = 100 * P_i(t) / P_i(t0) con t0 = primera fecha válida en el rango.
   * nasdaq_synth(t) = promedio de idx_i(t) sobre tickers con dato en t.
   * onProgress({ phase: 'loading', current, total }) y onProgress({ phase: 'building', validCount }).
   */
  function buildSyntheticNasdaq100(fromUnix, toUnix, onProgress) {
    var total = NASDAQ_100_TICKERS.length;
    var results = [];
    var completed = 0;

    function fetchOne(ticker) {
      return function () {
        var lastDate = dateStrFromUnix(toUnix);
        var cached = getCachedTicker(ticker, lastDate);
        if (cached && cached.length >= 2) {
          completed++;
          if (onProgress) onProgress({ phase: 'loading', current: completed, total: total });
          return Promise.resolve({ ticker: ticker, series: cached });
        }
        return fetchOneTickerData912(ticker).then(function (series) {
          completed++;
          if (onProgress) onProgress({ phase: 'loading', current: completed, total: total });
          if (series && series.length >= 2) {
            setCachedTicker(ticker, lastDate, series);
            return { ticker: ticker, series: series };
          }
          return { ticker: ticker, series: null };
        }).catch(function () {
          completed++;
          if (onProgress) onProgress({ phase: 'loading', current: completed, total: total });
          return { ticker: ticker, series: null };
        });
      };
    }

    var tasks = NASDAQ_100_TICKERS.map(fetchOne);
    var pool = [];
    var idx = 0;
    function runNext() {
      if (idx >= tasks.length) return Promise.resolve();
      var i = idx++;
      return tasks[i]().then(function (res) {
        results[i] = res;
        return runNext();
      });
    }
    var workers = [];
    for (var w = 0; w < CONCURRENCY && w < tasks.length; w++) workers.push(runNext());

    return Promise.all(workers).then(function () {
      var validSeries = [];
      for (var v = 0; v < results.length; v++) {
        if (results[v] && results[v].series && results[v].series.length >= 2) validSeries.push(results[v].series);
      }
      var N = validSeries.length;
      if (onProgress) onProgress({ phase: 'building', validCount: N });
      if (N === 0) return { series: [], validTickerCount: 0, fallback: null };

      var byDateSums = {};
      var byDateCount = {};
      for (var s = 0; s < validSeries.length; s++) {
        var series = validSeries[s];
        var inRange = [];
        for (var i = 0; i < series.length; i++) {
          var unix = dateToUnix(series[i].date);
          if (unix >= fromUnix && unix <= toUnix) inRange.push(series[i]);
        }
        if (inRange.length < 2) continue;
        var t0 = inRange[0].date;
        var p0 = inRange[0].value;
        if (!p0 || !isFinite(p0)) continue;
        for (var j = 0; j < inRange.length; j++) {
          var d = inRange[j].date;
          var p = inRange[j].value;
          if (!p || !isFinite(p)) continue;
          var idxVal = 100 * (p / p0);
          byDateSums[d] = (byDateSums[d] || 0) + idxVal;
          byDateCount[d] = (byDateCount[d] || 0) + 1;
        }
      }
      var out = [];
      Object.keys(byDateSums).forEach(function (d) {
        var n = byDateCount[d];
        if (n > 0) out.push({ date: d, value: byDateSums[d] / n });
      });
      out.sort(function (a, b) { return a.date.localeCompare(b.date); });
      return { series: out, validTickerCount: N, fallback: 'data912_synth' };
    });
  }

  /** NASDAQ sintético: valores aproximados mensuales 2016–hoy para que el gráfico siempre pueda mostrarse. */
  function getSyntheticNasdaqSeries(fromUnix, toUnix) {
    var anchors = [
      { y: 2016, m: 1, v: 4614 },
      { y: 2017, m: 1, v: 5383 },
      { y: 2018, m: 1, v: 6906 },
      { y: 2019, m: 1, v: 6986 },
      { y: 2020, m: 1, v: 9152 },
      { y: 2021, m: 1, v: 12888 },
      { y: 2022, m: 1, v: 14340 },
      { y: 2023, m: 1, v: 10466 },
      { y: 2024, m: 1, v: 15055 },
      { y: 2025, m: 1, v: 18500 }
    ];
    var byDay = {};
    var now = new Date();
    for (var a = 0; a < anchors.length - 1; a++) {
      var cur = anchors[a];
      var next = anchors[a + 1];
      var startD = new Date(cur.y, cur.m - 1, 1);
      var endD = new Date(next.y, next.m - 1, 1);
      if (endD > now) endD = now;
      for (var d = new Date(startD); d < endD; d.setDate(d.getDate() + 1)) {
        var t = d.getTime() / 1000;
        if (t >= fromUnix && t <= toUnix) {
          var frac = (d - startD) / (endD - startD);
          var val = cur.v + frac * (next.v - cur.v);
          byDay[dateStrFromUnix(Math.floor(t))] = val;
        }
      }
    }
    var last = anchors[anchors.length - 1];
    var lastStart = new Date(last.y, last.m - 1, 1);
    for (var d = new Date(lastStart); d <= now; d.setDate(d.getDate() + 1)) {
      var t = d.getTime() / 1000;
      if (t >= fromUnix && t <= toUnix) byDay[dateStrFromUnix(Math.floor(t))] = last.v;
    }
    return Object.keys(byDay).sort().map(function (day) { return { date: day, value: byDay[day] }; });
  }

  /** Coinbase Exchange: velas diarias; máximo 300 por request. */
  function fetchBtcCoinbase(fromUnix, toUnix) {
    var all = [];
    var start = fromUnix;
    function next() {
      var end = Math.min(start + CANDLES_PER_REQUEST * SECONDS_PER_DAY, toUnix);
      if (start >= end) return Promise.resolve(all);
      var url = COINBASE_CANDLES + '?granularity=' + SECONDS_PER_DAY + '&start=' + new Date(start * 1000).toISOString() + '&end=' + new Date(end * 1000).toISOString();
      return fetchWithTimeout(url)
        .then(function (r) {
          if (!r.ok) throw new Error('Coinbase no respondió.');
          return r.json();
        })
        .then(function (candles) {
          if (!Array.isArray(candles)) return next();
          for (var i = 0; i < candles.length; i++) {
            var c = candles[i];
            var close = c[4];
            if (typeof close === 'number' && isFinite(close) && close > 0) {
              all.push({ date: dateStrFromUnix(c[0]), value: close });
            }
          }
          start = end;
          if (candles.length < CANDLES_PER_REQUEST) return Promise.resolve(all);
          return next();
        });
    }
    return next().then(function () {
      var byDay = {};
      all.forEach(function (p) {
        if (!byDay[p.date]) byDay[p.date] = p.value;
      });
      return Object.keys(byDay).sort().map(function (day) { return { date: day, value: byDay[day] }; });
    });
  }

  /** CoinGecko: market_chart/range (fallback BTC). */
  function fetchBtcCoinGecko(fromUnix, toUnix) {
    var url = COINGECKO_RANGE + '?vs_currency=usd&from=' + fromUnix + '&to=' + toUnix;
    return fetchWithTimeout(url)
      .then(function (r) {
        if (!r.ok) throw new Error('CoinGecko no respondió.');
        return r.json();
      })
      .then(function (data) {
        var prices = (data && data.prices) || [];
        var byDay = {};
        for (var i = 0; i < prices.length; i++) {
          var ts = prices[i][0];
          var val = prices[i][1];
          if (typeof val !== 'number' || !isFinite(val)) continue;
          var day = dateStrFromUnix(Math.floor(ts / 1000));
          if (!byDay[day] || ts > byDay[day].ts) byDay[day] = { ts: ts, value: val };
        }
        return Object.keys(byDay).sort().map(function (day) { return { date: day, value: byDay[day].value }; });
      });
  }

  /** BTC: Coinbase primero; si falla (CORS/red), CoinGecko. */
  function fetchBtcRange(fromUnix, toUnix) {
    return fetchBtcCoinbase(fromUnix, toUnix).catch(function () {
      return fetchBtcCoinGecko(fromUnix, toUnix);
    });
  }

  /** NASDAQ: primero índice sintético Data912 (101 componentes); si no hay datos, Yahoo/QQQ/sintético. Retorna { series, fallback, validTickerCount? }. */
  function fetchNasdaqRange(fromUnix, toUnix, onProgress) {
    return buildSyntheticNasdaq100(fromUnix, toUnix, onProgress).then(function (result) {
      if (result.series && result.series.length >= 2) {
        return {
          series: result.series,
          fallback: result.fallback,
          validTickerCount: result.validTickerCount
        };
      }
      return fetchNasdaqFallback(fromUnix, toUnix);
    }).catch(function () {
      return fetchNasdaqFallback(fromUnix, toUnix);
    });
  }

  function fetchNasdaqFallback(fromUnix, toUnix) {
    var yahooIxicUrl = YAHOO_IXIC + '?period1=' + fromUnix + '&period2=' + toUnix + '&interval=1d';
    return fetchViaProxy(yahooIxicUrl)
      .then(function (data) {
        var out = parseYahooChartResponse(data);
        if (out.length >= 2) return { series: out, fallback: null };
        throw new Error('Pocos datos IXIC');
      })
      .catch(function () {
        var qqqUrl = YAHOO_QQQ + '?period1=' + fromUnix + '&period2=' + toUnix + '&interval=1d';
        return fetchViaProxy(qqqUrl).then(function (data) {
          var out = parseYahooChartResponse(data);
          if (out.length >= 2) return { series: out, fallback: 'qqq' };
          throw new Error('Pocos datos QQQ');
        });
      })
      .catch(function () {
        return { series: getSyntheticNasdaqSeries(fromUnix, toUnix), fallback: 'synthetic' };
      });
  }

  /** Resample serie diaria a un punto por año: último precio disponible de cada año. */
  function resampleToAnnual(series) {
    if (!series || !series.length) return [];
    var byYear = {};
    series.forEach(function (p) {
      var y = (p.date || '').slice(0, 4);
      if (!y) return;
      var val = p.value;
      if (typeof val !== 'number' || !isFinite(val) || val <= 0) return;
      if (!byYear[y] || (p.date > byYear[y].date)) byYear[y] = { year: y, date: p.date, value: val };
    });
    return Object.keys(byYear).sort().map(function (y) { return byYear[y]; });
  }

  /**
   * Valores anuales con retornos logarítmicos: índice base 100 = 100 * exp(ln(P_t/P_0)) = 100 * (P_t/P_0).
   * Alinea por año y devuelve { dates: años, btcIndex, nasdaqIndex }.
   */
  function alignAndNormalizeAnnual(btcAnnual, nasdaqAnnual) {
    var btcByYear = {};
    btcAnnual.forEach(function (p) { btcByYear[p.year] = p.value; });
    var nasdaqByYear = {};
    nasdaqAnnual.forEach(function (p) { nasdaqByYear[p.year] = p.value; });
    var years = [];
    Object.keys(btcByYear).forEach(function (y) {
      if (nasdaqByYear[y] != null && isFinite(nasdaqByYear[y]) && isFinite(btcByYear[y]) && btcByYear[y] > 0 && nasdaqByYear[y] > 0) years.push(y);
    });
    years.sort();
    if (years.length === 0) return { dates: years, btcIndex: [], nasdaqIndex: [] };
    var p0Btc = btcByYear[years[0]];
    var p0Nasdaq = nasdaqByYear[years[0]];
    var btcIndex = [];
    var nasdaqIndex = [];
    years.forEach(function (y) {
      btcIndex.push(100 * (btcByYear[y] / p0Btc));
      nasdaqIndex.push(100 * (nasdaqByYear[y] / p0Nasdaq));
    });
    return { dates: years, btcIndex: btcIndex, nasdaqIndex: nasdaqIndex };
  }

  /** Align by date and normalize both series to base 100 at first common date (legacy, para uso diario). */
  function alignAndNormalize(btcSeries, nasdaqSeries) {
    var btcByDate = {};
    btcSeries.forEach(function (p) { btcByDate[p.date] = p.value; });
    var nasdaqByDate = {};
    nasdaqSeries.forEach(function (p) { nasdaqByDate[p.date] = p.value; });
    var dates = [];
    Object.keys(btcByDate).forEach(function (d) {
      if (nasdaqByDate[d] != null && isFinite(nasdaqByDate[d]) && isFinite(btcByDate[d])) dates.push(d);
    });
    dates.sort();
    if (dates.length === 0) return { dates: [], btcIndex: [], nasdaqIndex: [] };
    var firstBtc = btcByDate[dates[0]];
    var firstNasdaq = nasdaqByDate[dates[0]];
    var btcIndex = [];
    var nasdaqIndex = [];
    dates.forEach(function (d) {
      btcIndex.push(100 * (btcByDate[d] / firstBtc));
      nasdaqIndex.push(100 * (nasdaqByDate[d] / firstNasdaq));
    });
    return { dates: dates, btcIndex: btcIndex, nasdaqIndex: nasdaqIndex };
  }

  /** Draw two lines on canvas: BTC (orange) and NASDAQ (blue). Índice base 100 = primera fecha común. */
  function drawDualLineChart(canvas, aligned) {
    var dates = aligned.dates;
    var btc = aligned.btcIndex;
    var nasdaq = aligned.nasdaqIndex;
    if (!dates.length || !btc.length || !nasdaq.length) return;

    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var rect = canvas.getBoundingClientRect();
    var w = rect.width;
    var h = rect.height;
    if (w <= 0 || h <= 0) {
      w = Number(canvas.getAttribute('width')) || 800;
      h = Number(canvas.getAttribute('height')) || 360;
    }
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.scale(dpr, dpr);
    var pad = { top: 24, right: 24, bottom: 44, left: 52 };
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;

    var rawMin = Math.min.apply(null, btc.concat(nasdaq));
    var rawMax = Math.max.apply(null, btc.concat(nasdaq));
    var range = rawMax - rawMin || 1;
    var marginY = range * 0.08;
    var yMin = Math.max(0, rawMin - marginY);
    var yMax = rawMax + marginY;
    var yRange = yMax - yMin || 1;
    function niceStep(r) {
      var step = r / 5;
      var mag = Math.pow(10, Math.floor(Math.log10(step)));
      var norm = step / mag;
      if (norm <= 1) return mag; if (norm <= 2) return 2 * mag; if (norm <= 5) return 5 * mag;
      return 10 * mag;
    }
    var yStep = niceStep(yRange);
    yMin = Math.floor(yMin / yStep) * yStep;
    yMax = Math.ceil(yMax / yStep) * yStep;
    if (yMin < 0) yMin = 0;
    var yRangeFinal = yMax - yMin || 1;

    function toX(i) {
      return pad.left + (i / (dates.length - 1 || 1)) * plotW;
    }
    function toY(v) {
      return pad.top + plotH - ((v - yMin) / yRangeFinal) * plotH;
    }

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    var labelFont = '12px system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.font = labelFont;
    ctx.textAlign = 'right';
    for (var yVal = yMin; yVal <= yMax + 1e-6; yVal += yStep) {
      var yy = toY(yVal);
      if (yy >= pad.top - 2 && yy <= pad.top + plotH + 2) {
        ctx.fillText(yVal % 1 === 0 ? String(Math.round(yVal)) : yVal.toFixed(1), pad.left - 6, yy + 4);
      }
    }
    ctx.textAlign = 'center';
    var xStep = Math.max(1, Math.floor(dates.length / 8));
    for (var xi = 0; xi < dates.length; xi += xStep) {
      var d = dates[xi];
      if (!d) continue;
      var label = d.length >= 10 ? d.slice(0, 7) : d;
      ctx.fillText(label, toX(xi), pad.top + plotH + 14);
    }

    function drawLine(values, color, lineWidth) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth || 2;
      ctx.beginPath();
      for (var i = 0; i < values.length; i++) {
        var x = toX(i);
        var y = toY(values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    drawLine(nasdaq, 'rgba(88, 166, 255, 0.95)', 2);
    drawLine(btc, 'rgba(247, 147, 26, 0.95)', 2);

    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    var isAnnual = dates.length > 0 && dates.every(function (d) { return d.length === 4; });
    ctx.fillText(isAnnual ? 'Base 100 = primer año común (retornos log.)' : 'Base 100 = primera fecha común', pad.left + plotW / 2, h - 8);

    ctx.save();
    ctx.translate(14, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Índice (base 100)', 0, 0);
    ctx.restore();
  }

  /** Mensaje amigable para errores de red/CORS. */
  function normalizeErrorMessage(err) {
    var msg = (err && err.message) ? String(err.message) : '';
    if (err && err.name === 'TypeError' && (msg.indexOf('fetch') >= 0 || msg.indexOf('Failed') >= 0)) {
      return 'No hay conexión o error de red. Revisá tu internet.';
    }
    if (msg.indexOf('abort') >= 0) return 'Tiempo de espera agotado. Reintentá.';
    return msg || 'Error al cargar datos. Revisá tu conexión.';
  }

  window.BtcNasdaq = {
    fetchBtcRange: fetchBtcRange,
    fetchNasdaqRange: fetchNasdaqRange,
    resampleToAnnual: resampleToAnnual,
    alignAndNormalizeAnnual: alignAndNormalizeAnnual,
    alignAndNormalize: alignAndNormalize,
    drawDualLineChart: drawDualLineChart,
    normalizeErrorMessage: normalizeErrorMessage,
    MIN_TICKERS_WARNING: MIN_TICKERS_WARNING
  };
})();
