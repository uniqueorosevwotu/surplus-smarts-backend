// ============================================
// SURPLUS SMARTS — BACKEND SERVER
// Node.js + Express
// Deploy this on Railway.app
// ============================================

const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// YOUR API KEYS — ALREADY SET
// ============================================
const TWELVE_DATA_KEY = '5c791b3f0363487995830d787cd234be';
const NEWS_API_KEY    = 'cf9094777d43494b98720d3349fdc549';

// ============================================
// PAIRS TO MONITOR
// ============================================
const PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY',
  'AUD/USD','USD/CAD','EUR/GBP',
  'XAU/USD','USO/USD'
];

// ============================================
// FETCH REAL LIVE PRICE
// ============================================
async function getLivePrice(symbol) {
  try {
    const url = `https://api.twelvedata.com/price?symbol=${symbol}&apikey=${TWELVE_DATA_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    return parseFloat(data.price) || null;
  } catch(e) {
    return null;
  }
}

// ============================================
// FETCH REAL CANDLES (for indicator calculation)
// ============================================
async function getCandles(symbol, interval = '4h', outputsize = 52) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_DATA_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.values) return null;
    return data.values.map(c => ({
      time:  c.datetime,
      open:  parseFloat(c.open),
      high:  parseFloat(c.high),
      low:   parseFloat(c.low),
      close: parseFloat(c.close),
    })).reverse(); // oldest first
  } catch(e) {
    return null;
  }
}

// ============================================
// CALCULATE RSI
// ============================================
function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    avgGain = ((avgGain * (period - 1)) + (diff > 0 ? diff : 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

// ============================================
// CALCULATE MACD
// ============================================
function ema(values, period) {
  const k = 2 / (period + 1);
  let emaVal = values[0];
  for (let i = 1; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}
function calculateMACD(candles) {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close);
  const ema12 = ema(closes.slice(-12), 12);
  const ema26 = ema(closes.slice(-26), 26);
  const macdLine = ema12 - ema26;
  const signal = ema(closes.slice(-9), 9);
  return {
    macd: parseFloat(macdLine.toFixed(5)),
    signal: parseFloat(signal.toFixed(5)),
    histogram: parseFloat((macdLine - signal).toFixed(5)),
    bullish: macdLine > signal
  };
}

// ============================================
// DETECT HIGHER HIGHS / LOWER LOWS
// ============================================
function detectStructure(candles) {
  if (candles.length < 10) return 'NEUTRAL';
  const recent = candles.slice(-10);
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  const recentHigh = Math.max(...highs.slice(-3));
  const prevHigh   = Math.max(...highs.slice(0, 5));
  const recentLow  = Math.min(...lows.slice(-3));
  const prevLow    = Math.min(...lows.slice(0, 5));
  const higherHigh = recentHigh > prevHigh;
  const higherLow  = recentLow  > prevLow;
  const lowerHigh  = recentHigh < prevHigh;
  const lowerLow   = recentLow  < prevLow;
  if (higherHigh && higherLow) return 'BULLISH';
  if (lowerHigh  && lowerLow)  return 'BEARISH';
  return 'NEUTRAL';
}

// ============================================
// GENERATE REAL SIGNAL
// ============================================
function generateSignal(rsi, macd, structure, currentPrice, candles) {
  let bullScore = 0;
  let bearScore = 0;

  // RSI scoring
  if (rsi !== null) {
    if (rsi < 35) bullScore += 2;       // oversold = buy opportunity
    else if (rsi < 50) bullScore += 1;
    if (rsi > 65) bearScore += 2;       // overbought = sell opportunity
    else if (rsi > 50) bearScore += 1;
  }

  // MACD scoring
  if (macd !== null) {
    if (macd.bullish) bullScore += 2;
    else bearScore += 2;
    if (macd.histogram > 0) bullScore += 1;
    else bearScore += 1;
  }

  // Structure scoring
  if (structure === 'BULLISH') bullScore += 3;
  else if (structure === 'BEARISH') bearScore += 3;

  const total = bullScore + bearScore;
  const confidence = total > 0
    ? Math.round((Math.max(bullScore, bearScore) / total) * 100)
    : 50;

  let signal = 'WAIT';
  if (bullScore > bearScore && confidence >= 58) signal = 'BUY';
  else if (bearScore > bullScore && confidence >= 58) signal = 'SELL';

  // Calculate levels
  const recentLows  = candles.slice(-10).map(c => c.low);
  const recentHighs = candles.slice(-10).map(c => c.high);
  const atr = candles.slice(-14).reduce((sum, c, i, arr) => {
    if (i === 0) return sum;
    return sum + Math.abs(c.high - c.low);
  }, 0) / 13;

  const dp = currentPrice > 10 ? 2 : 4;
  let entry = currentPrice;
  let sl, tp;

  if (signal === 'BUY') {
    sl = parseFloat((Math.min(...recentLows) - atr * 0.3).toFixed(dp));
    tp = parseFloat((currentPrice + (currentPrice - sl) * 2).toFixed(dp));
  } else if (signal === 'SELL') {
    sl = parseFloat((Math.max(...recentHighs) + atr * 0.3).toFixed(dp));
    tp = parseFloat((currentPrice - (sl - currentPrice) * 2).toFixed(dp));
  } else {
    sl = parseFloat((currentPrice - atr).toFixed(dp));
    tp = parseFloat((currentPrice + atr).toFixed(dp));
  }

  return {
    signal,
    confidence,
    entry: entry.toFixed(dp),
    sl: sl.toFixed(dp),
    tp: tp.toFixed(dp),
    rsi,
    macd: macd ? macd.macd : null,
    macdBullish: macd ? macd.bullish : null,
    structure,
    bullScore,
    bearScore
  };
}

// ============================================
// BUILD REASONS (educational explanations)
// ============================================
function buildReasons(sig, rsi, macd, structure) {
  const reasons = [];
  if (structure === 'BULLISH') reasons.push({ icon:'📈', text:'Price showing Higher Highs + Higher Lows on H4 — bullish market structure confirmed' });
  if (structure === 'BEARISH') reasons.push({ icon:'📉', text:'Price showing Lower Highs + Lower Lows on H4 — bearish market structure confirmed' });
  if (rsi !== null) {
    if (rsi < 35) reasons.push({ icon:'📊', text:`RSI at ${rsi} — market is oversold, meaning sellers are exhausted and a reversal up is likely` });
    else if (rsi > 65) reasons.push({ icon:'📊', text:`RSI at ${rsi} — market is overbought, meaning buyers are exhausted and a pullback down is likely` });
    else reasons.push({ icon:'📊', text:`RSI at ${rsi} — neutral zone, momentum supports the current trend direction` });
  }
  if (macd !== null) {
    if (macd.bullish) reasons.push({ icon:'⚡', text:'MACD line crossed above signal line — bullish momentum building' });
    else reasons.push({ icon:'⚡', text:'MACD line crossed below signal line — bearish momentum building' });
  }
  if (sig === 'WAIT') reasons.push({ icon:'⏳', text:'No strong confluence yet — waiting for clearer setup before risking your money' });
  if (sig === 'BUY')  reasons.push({ icon:'✅', text:'Multiple indicators aligned bullish — good risk/reward opportunity to buy' });
  if (sig === 'SELL') reasons.push({ icon:'🔴', text:'Multiple indicators aligned bearish — good risk/reward opportunity to sell' });
  return reasons;
}

// ============================================
// CACHE (avoid hammering free API)
// ============================================
const cache = {};
const CACHE_TTL = 4 * 60 * 1000; // 4 minutes

async function getSignalForPair(symbol) {
  const now = Date.now();
  if (cache[symbol] && (now - cache[symbol].ts) < CACHE_TTL) {
    return cache[symbol].data;
  }
  const candles = await getCandles(symbol);
  if (!candles || candles.length < 30) return null;
  const currentPrice = candles[candles.length - 1].close;
  const rsi       = calculateRSI(candles);
  const macd      = calculateMACD(candles);
  const structure = detectStructure(candles);
  const sigData   = generateSignal(rsi, macd, structure, currentPrice, candles);
  const reasons   = buildReasons(sigData.signal, rsi, macd, structure);
  const result = {
    symbol,
    price: currentPrice.toFixed(currentPrice > 10 ? 2 : 4),
    ...sigData,
    reasons,
    candles: candles.slice(-30).map(c => ({ time: c.time, close: c.close, high: c.high, low: c.low })),
    updatedAt: new Date().toISOString()
  };
  cache[symbol] = { ts: now, data: result };
  return result;
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SURPLUS SMARTS BACKEND LIVE ✅', time: new Date().toISOString() });
});

// All signals
app.get('/api/signals', async (req, res) => {
  try {
    const results = await Promise.allSettled(
      ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','EUR/GBP','XAU/USD'].map(getSignalForPair)
    );
    const signals = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
    res.json({ success: true, signals, count: signals.length });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Single pair signal
app.get('/api/signal/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.replace('-', '/').toUpperCase();
    const data = await getSignalForPair(symbol);
    if (!data) return res.status(400).json({ success: false, error: 'Could not fetch data' });
    res.json({ success: true, data });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Real news
app.get('/api/news', async (req, res) => {
  try {
    const url = `https://newsapi.org/v2/everything?q=forex+trading+dollar+ECB+Fed+interest+rates&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!data.articles) return res.json({ success: true, news: [] });
    const news = data.articles.map(a => ({
      headline: a.title,
      source: a.source.name,
      time: a.publishedAt,
      url: a.url,
      impact: a.title.toLowerCase().match(/fed|ecb|rate|inflation|gdp|nfp|war|crisis/) ? 'high' :
              a.title.toLowerCase().match(/oil|gold|trade|data/) ? 'med' : 'low',
      sentiment: a.title.toLowerCase().match(/rise|surge|gain|strong|bullish|up|high|beat/) ? 'bullish' : 'bearish'
    }));
    res.json({ success: true, news });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Live price only (fast endpoint)
app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.replace('-', '/').toUpperCase();
  const price = await getLivePrice(symbol);
  res.json({ symbol, price });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SURPLUS SMARTS Backend running on port ${PORT}`);
});
