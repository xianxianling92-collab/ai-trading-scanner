import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, Settings2, X, Plus, Sparkles, ChevronUp, ChevronDown, LineChart, Star, Info } from "lucide-react";

// ============ Storage (localStorage biasa, menggantikan window.storage khusus Claude) ============
const storage = {
  async get(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? null : { key, value: raw };
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return { key, value };
    } catch (e) {
      return null;
    }
  },
};

// ============ Adapter sumber data ============
// Setiap adapter mengembalikan bentuk seragam:
// { closes[], highs[], lows[], volumes[] } (ascending, terlama -> terbaru), + optional lastPrice/prevClose

async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function viaProxy(url, log) {
  const attempts = [
    { name: "direct", url, parse: (r) => r.json() },
    { name: "allorigins-raw", url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, parse: (r) => r.json() },
    { name: "allorigins-get", url: `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, parse: async (r) => JSON.parse((await r.json()).contents) },
    { name: "codetabs", url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, parse: (r) => r.json() },
    { name: "corsproxy.io", url: `https://corsproxy.io/?url=${encodeURIComponent(url)}`, parse: (r) => r.json() },
    { name: "thingproxy", url: `https://thingproxy.freeboard.io/fetch/${url}`, parse: (r) => r.json() },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const res = await fetchWithTimeout(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await a.parse(res);
      log && log(a.name, "ok");
      return json;
    } catch (e) {
      log && log(a.name, e.name === "AbortError" ? "timeout" : e.message || "gagal");
      lastErr = e;
    }
  }
  throw lastErr || new Error("Semua jalur fetch gagal");
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
  const json = await viaProxy(url);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo: data kosong");
  const meta = result.meta;
  const q = result.indicators?.quote?.[0] || {};
  let n = (q.close || []).length;
  while (n > 0 && (q.close[n - 1] == null || q.volume[n - 1] == null)) n--;
  if (n < 22) throw new Error("Yahoo: riwayat kurang");
  return {
    closes: q.close.slice(0, n),
    highs: q.high.slice(0, n),
    lows: q.low.slice(0, n),
    volumes: q.volume.slice(0, n),
    lastPrice: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose,
  };
}

async function fetchFinnhub(symbol, key) {
  if (!key) throw new Error("Finnhub: API key belum diisi");
  const to = Math.floor(Date.now() / 1000);
  const from = to - 180 * 24 * 3600;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${key}`;
  const json = await viaProxy(url);
  if (json.s !== "ok" || !json.c?.length) throw new Error("Finnhub: simbol tidak didukung di tier gratis");
  return { closes: json.c, highs: json.h, lows: json.l, volumes: json.v };
}

async function fetchAlphaVantage(symbol, key) {
  if (!key) throw new Error("Alpha Vantage: API key belum diisi");
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${key}`;
  const json = await viaProxy(url);
  const series = json["Time Series (Daily)"];
  if (!series) throw new Error(json["Note"] || json["Information"] || "Alpha Vantage: simbol tidak ditemukan / limit tercapai");
  const dates = Object.keys(series).sort();
  return {
    closes: dates.map((d) => parseFloat(series[d]["4. close"])),
    highs: dates.map((d) => parseFloat(series[d]["2. high"])),
    lows: dates.map((d) => parseFloat(series[d]["3. low"])),
    volumes: dates.map((d) => parseFloat(series[d]["5. volume"])),
  };
}

async function fetchPolygon(symbol, key) {
  if (!key) throw new Error("Polygon.io: API key belum diisi");
  const to = new Date().toISOString().slice(0, 10);
  const fromD = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const bare = symbol.replace(".JK", "");
  const url = `https://api.polygon.io/v2/aggs/ticker/${bare}/range/1/day/${fromD}/${to}?adjusted=true&sort=asc&limit=200&apiKey=${key}`;
  const json = await viaProxy(url);
  if (!json.results?.length) throw new Error("Polygon: tidak ada data (tier gratis umumnya hanya saham AS)");
  return {
    closes: json.results.map((r) => r.c),
    highs: json.results.map((r) => r.h),
    lows: json.results.map((r) => r.l),
    volumes: json.results.map((r) => r.v),
  };
}

async function fetchViaAiSearch(symbol) {
  const code = symbol.replace(".JK", "");
  const prompt = `Cari data saham ${code} di Bursa Efek Indonesia (IDX) menggunakan web search (boleh dari Yahoo Finance, Investing.com, RTI Business, Google Finance, atau situs resmi IDX). Saya butuh data HARI INI atau data penutupan terbaru yang tersedia.

Balas HANYA dengan satu objek JSON valid (tanpa markdown, tanpa backtick, tanpa teks lain sama sekali) persis dengan skema ini:
{"lastPrice": number, "prevClose": number, "volume": number, "avgVolume20": number, "high20": number, "low10": number, "ma5": number, "ma20": number, "macdBullish": boolean}

Keterangan field: lastPrice = harga terakhir (Rupiah), prevClose = harga penutupan sebelumnya, volume = volume hari ini (lembar saham), avgVolume20 = estimasi rata-rata volume 20 hari terakhir, high20 = level resistance / harga tertinggi kira-kira 20 hari terakhir, low10 = harga terendah kira-kira 10 hari terakhir, ma5/ma20 = perkiraan moving average 5 & 20 hari, macdBullish = true jika MACD sedang di atas signal line (momentum naik) berdasarkan analisis teknikal terbaru yang kamu temukan. Jika suatu angka tidak ditemukan persis, berikan estimasi masuk akal berdasarkan data yang ada. Jangan beri penjelasan apapun, HANYA objek JSON.`;

  const res = await fetch("/.netlify/functions/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, maxTokens: 1024, webSearch: true }),
  });
  if (!res.ok) throw new Error(`AI Search: HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI Search: format jawaban tidak sesuai");
  const snap = JSON.parse(match[0]);
  if (!snap.lastPrice || !snap.prevClose) throw new Error("AI Search: data harga tidak lengkap");
  return { __kind: "snapshot", ...snap };
}

function computeFromSnapshot(s, symbol, settings) {
  const lastClose = s.lastPrice;
  const prev = s.prevClose;
  const pctChange = ((lastClose - prev) / prev) * 100;
  const resistance = s.high20 ?? lastClose * 1.03;
  const avgVolume = s.avgVolume20 || 1;
  const volRatio = (s.volume || 0) / avgVolume;
  const ma5 = s.ma5 ?? lastClose;
  const ma20 = s.ma20 ?? lastClose;
  const macdBullish = !!s.macdBullish;
  const macd = macdBullish ? 1 : -1;
  const signal = 0;

  const breakout = lastClose > resistance && volRatio >= settings.volMultiplier;
  const trendingUp = lastClose > ma5 && ma5 > ma20 && pctChange > 0;
  const trendingDown = lastClose < ma5 && ma5 < ma20 && pctChange < 0;

  const araLimit = getAraLimit(lastClose);
  const potentialAra = pctChange > 0 && pctChange / araLimit >= settings.araProximityRatio;

  const swingLow = s.low10 ?? lastClose * 0.95;
  const entry = lastClose;
  const slRaw = Math.min(swingLow * 0.99, entry * (1 - settings.slPct / 100));
  const sl = Math.max(slRaw, entry * (1 - settings.slPct / 100 - 0.05));
  const risk = entry - sl;
  const tp = entry + risk * settings.riskReward;

  let trend = "Netral";
  if (trendingUp || (pctChange > 0 && lastClose > ma20)) trend = "Bullish";
  if (trendingDown || (pctChange < 0 && lastClose < ma20)) trend = "Bearish";

  const distToResistance = ((resistance - lastClose) / lastClose) * 100;

  const scoreTrend = trend === "Bullish" ? 25 : trend === "Netral" ? 10 : 0;
  const scoreVolume = Math.min(volRatio / 2, 1) * 20;
  const scoreMacd = macdBullish ? 20 : 0;
  const scoreMa20 = lastClose > ma20 ? 20 : 0;
  const scoreResistance = breakout ? 15 : Math.max(0, 15 * (1 - Math.min(distToResistance, 15) / 15));
  const score = Math.round(scoreTrend + scoreVolume + scoreMacd + scoreMa20 + scoreResistance);

  const checklist = {
    trend: trend === "Bullish",
    volume: volRatio >= settings.volMultiplier,
    macd: macdBullish,
    ma20: lastClose > ma20,
    resistance: breakout || distToResistance < 3,
  };

  let recommendation = "Wait & See";
  if (score >= 80) recommendation = "Strong Buy";
  else if (score >= 60) recommendation = "Buy";
  else if (score >= 40) recommendation = "Hold / Watchlist";
  else recommendation = "Avoid";

  return { symbol, lastClose, pctChange, resistance, distToResistance, volRatio, ma5, ma20, macd, signal, breakout, trend, entry, sl, tp, risk, score, checklist, recommendation, potentialAra };
}

function alphaVantageSymbol(symbol) {
  // Perkiraan: bursa Jakarta di Alpha Vantage kadang pakai suffix .JKT — belum tentu tepat, sifatnya best-effort
  return symbol.replace(".JK", ".JKT");
}

const PROVIDERS = {
  aisearch: { label: "AI Web Search (Claude)", needsKey: false, kind: "snapshot", fetch: (s) => fetchViaAiSearch(s) },
  yahoo: { label: "Yahoo Finance", needsKey: false, kind: "series", fetch: (s) => fetchYahoo(s) },
  finnhub: { label: "Finnhub", needsKey: true, kind: "series", fetch: (s, keys) => fetchFinnhub(s, keys.finnhub) },
  alphavantage: { label: "Alpha Vantage", needsKey: true, kind: "series", fetch: (s, keys) => fetchAlphaVantage(alphaVantageSymbol(s), keys.alphavantage) },
  polygon: { label: "Polygon.io", needsKey: true, kind: "series", fetch: (s, keys) => fetchPolygon(s, keys.polygon) },
};

// ============ Indikator ============
const ARA_BANDS = [{ max: 200, pct: 35 }, { max: 5000, pct: 25 }, { max: Infinity, pct: 20 }];
const getAraLimit = (price) => (ARA_BANDS.find((b) => price <= b.max) || ARA_BANDS[2]).pct;

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function computeMetrics(bundle, symbol, settings) {
  const { closes: c, highs: h, lows: l, volumes: v, lastPrice, prevClose } = bundle;
  const n = c.length;
  if (n < 22) throw new Error("Riwayat data tidak cukup");

  const lastClose = lastPrice ?? c[n - 1];
  const prev = prevClose ?? c[n - 2];
  const pctChange = ((lastClose - prev) / prev) * 100;

  const lookback = settings.lookbackDays;
  const priorHighs = h.slice(Math.max(0, n - 1 - lookback), n - 1);
  const resistance = Math.max(...priorHighs);
  const priorVols = v.slice(Math.max(0, n - 1 - lookback), n - 1);
  const avgVolume = priorVols.reduce((a, b) => a + b, 0) / priorVols.length;
  const volRatio = avgVolume > 0 ? v[n - 1] / avgVolume : 0;

  const ma = (period) => {
    const s = c.slice(Math.max(0, n - period), n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const ma5 = ma(5);
  const ma20 = ma(20);

  const ema12 = emaSeries(c, 12);
  const ema26 = emaSeries(c, 26);
  const macdSeries = ema12.map((val, i) => val - ema26[i]);
  const signalSeries = emaSeries(macdSeries, 9);
  const macd = macdSeries[n - 1];
  const signal = signalSeries[n - 1];
  const macdBullish = macd > signal;

  const breakout = lastClose > resistance && volRatio >= settings.volMultiplier;
  const trendingUp = lastClose > ma5 && ma5 > ma20 && pctChange > 0;
  const trendingDown = lastClose < ma5 && ma5 < ma20 && pctChange < 0;

  const araLimit = getAraLimit(lastClose);
  const potentialAra = pctChange > 0 && pctChange / araLimit >= settings.araProximityRatio;

  const swingLowWindow = l.slice(Math.max(0, n - 11), n - 1);
  const swingLow = swingLowWindow.length ? Math.min(...swingLowWindow) : lastClose * 0.95;
  const entry = lastClose;
  const slRaw = Math.min(swingLow * 0.99, entry * (1 - settings.slPct / 100));
  const sl = Math.max(slRaw, entry * (1 - settings.slPct / 100 - 0.05));
  const risk = entry - sl;
  const tp = entry + risk * settings.riskReward;

  let trend = "Netral";
  if (trendingUp || (pctChange > 0 && lastClose > ma20)) trend = "Bullish";
  if (trendingDown || (pctChange < 0 && lastClose < ma20)) trend = "Bearish";

  const distToResistance = ((resistance - lastClose) / lastClose) * 100;

  // --- Skor teknikal 0-100 ---
  const scoreTrend = trend === "Bullish" ? 25 : trend === "Netral" ? 10 : 0;
  const scoreVolume = Math.min(volRatio / 2, 1) * 20;
  const scoreMacd = macdBullish ? (macd > 0 ? 20 : 14) : 0;
  const scoreMa20 = lastClose > ma20 ? 20 : 0;
  const scoreResistance = breakout ? 15 : Math.max(0, 15 * (1 - Math.min(distToResistance, 15) / 15));
  const score = Math.round(scoreTrend + scoreVolume + scoreMacd + scoreMa20 + scoreResistance);

  const checklist = {
    trend: trend === "Bullish",
    volume: volRatio >= settings.volMultiplier,
    macd: macdBullish,
    ma20: lastClose > ma20,
    resistance: breakout || distToResistance < 3,
  };

  let recommendation = "Wait & See";
  if (score >= 80) recommendation = "Strong Buy";
  else if (score >= 60) recommendation = "Buy";
  else if (score >= 40) recommendation = "Hold / Watchlist";
  else recommendation = "Avoid";

  return {
    symbol, lastClose, pctChange, resistance, distToResistance, volRatio, ma5, ma20, macd, signal,
    breakout, trend, entry, sl, tp, risk, score, checklist, recommendation, potentialAra,
  };
}

const fmtPrice = (v) => (v == null ? "-" : Math.round(v).toLocaleString("id-ID"));
const fmtPct = (v) => (v == null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

const DEFAULT_WATCHLIST = ["BBCA.JK", "BBRI.JK", "BMRI.JK", "TLKM.JK", "ASII.JK", "GOTO.JK", "ANTM.JK", "MLPL.JK"];
const DEFAULT_SETTINGS = { lookbackDays: 20, volMultiplier: 1.5, araProximityRatio: 0.7, slPct: 3, riskReward: 2 };

async function callAiAnalysis(m) {
  const prompt = `Kamu analis teknikal saham. Data untuk ${m.symbol.replace(".JK", "")} (BEI):
Harga: ${Math.round(m.lastClose)}, perubahan: ${m.pctChange.toFixed(2)}%, trend: ${m.trend}, skor teknikal: ${m.score}/100,
breakout resisten: ${m.breakout ? "ya" : "tidak"}, volume vs rata-rata: ${m.volRatio.toFixed(1)}x, MACD ${m.macd > m.signal ? "di atas" : "di bawah"} signal,
MA20: ${Math.round(m.ma20)}, entry acuan ${Math.round(m.entry)}, SL ${Math.round(m.sl)}, TP ${Math.round(m.tp)}.
Tulis 3-4 kalimat Bahasa Indonesia, jelaskan kenapa sinyal ini muncul berdasar data di atas. Jangan menyuruh "beli sekarang", cukup jelaskan pembacaan teknikalnya. Tanpa markdown.`;
  const res = await fetch("/.netlify/functions/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, maxTokens: 300, webSearch: false }),
  });
  if (!res.ok) throw new Error(`Analisis AI: HTTP ${res.status}`);
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join(" ").trim() || "Analisis tidak tersedia.";
}

function Stars({ score }) {
  const filled = Math.round((score / 100) * 5);
  return (
    <span className="inline-flex text-[#F5A623]">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={14} fill={i <= filled ? "#F5A623" : "none"} strokeWidth={1.5} />
      ))}
    </span>
  );
}

export default function AiTradingScanner() {
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);
  const [data, setData] = useState({});
  const [errors, setErrors] = useState({});
  const [loadingSet, setLoadingSet] = useState(new Set());
  const [aiText, setAiText] = useState({});
  const [aiLoading, setAiLoading] = useState(new Set());
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [newTicker, setNewTicker] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [filter, setFilter] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(0);
  const [providerOrder, setProviderOrder] = useState(["aisearch", "yahoo", "finnhub", "alphavantage", "polygon"]);
  const [providerEnabled, setProviderEnabled] = useState({ aisearch: true, yahoo: true, finnhub: false, alphavantage: false, polygon: false });
  const [apiKeys, setApiKeys] = useState({ finnhub: "", alphavantage: "", polygon: "" });
  const [usedProvider, setUsedProvider] = useState({});
  const [expandedChart, setExpandedChart] = useState(null);
  const [diagLog, setDiagLog] = useState([]);
  const [diagRunning, setDiagRunning] = useState(false);
  const intervalRef = useRef(null);

  const runDiagnostics = async () => {
    setDiagRunning(true);
    setDiagLog([]);
    const entries = [];
    const log = (name, status) => entries.push({ name, status, t: Date.now() });
    try {
      const t0 = Date.now();
      const res = await fetchWithTimeout("/.netlify/functions/claude-proxy", 6000).catch((e) => e);
      log("Netlify Function (baseline)", res instanceof Error ? `error: ${res.message}` : `respond (${Date.now() - t0}ms)`);
    } catch (e) {
      log("Netlify Function (baseline)", `error: ${e.message}`);
    }
    try {
      await viaProxy("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d", log);
    } catch (e) {
      log("(semua jalur Yahoo)", `gagal total: ${e.message}`);
    }
    setDiagLog([...entries]);
    setDiagRunning(false);
  };

  useEffect(() => {
    (async () => {
      try {
        const saved = await storage.get("watchlist_v3");
        if (saved?.value) {
          const parsed = JSON.parse(saved.value);
          if (Array.isArray(parsed) && parsed.length) setWatchlist(parsed);
        }
      } catch (e) {}
      try {
        const savedKeys = await storage.get("api_keys_v1");
        if (savedKeys?.value) setApiKeys((p) => ({ ...p, ...JSON.parse(savedKeys.value) }));
      } catch (e) {}
      try {
        const savedProv = await storage.get("provider_config_v1");
        if (savedProv?.value) {
          const parsed = JSON.parse(savedProv.value);
          if (parsed.order) setProviderOrder(parsed.order);
          if (parsed.enabled) setProviderEnabled(parsed.enabled);
        }
      } catch (e) {}
      setStorageReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    storage.set("watchlist_v3", JSON.stringify(watchlist)).catch(() => {});
  }, [watchlist, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    storage.set("api_keys_v1", JSON.stringify(apiKeys)).catch(() => {});
  }, [apiKeys, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    storage.set("provider_config_v1", JSON.stringify({ order: providerOrder, enabled: providerEnabled })).catch(() => {});
  }, [providerOrder, providerEnabled, storageReady]);

  const fetchOne = useCallback(
    async (symbol) => {
      setLoadingSet((p) => new Set(p).add(symbol));
      setErrors((p) => { const n = { ...p }; delete n[symbol]; return n; });
      const triedErrors = [];
      for (const pid of providerOrder) {
        if (!providerEnabled[pid]) continue;
        try {
          const bundle = await PROVIDERS[pid].fetch(symbol, apiKeys);
          const metrics = PROVIDERS[pid].kind === "snapshot" ? computeFromSnapshot(bundle, symbol, settings) : computeMetrics(bundle, symbol, settings);
          setData((p) => ({ ...p, [symbol]: metrics }));
          setUsedProvider((p) => ({ ...p, [symbol]: PROVIDERS[pid].label }));
          setLoadingSet((p) => { const n = new Set(p); n.delete(symbol); return n; });
          return;
        } catch (e) {
          triedErrors.push(`${PROVIDERS[pid].label}: ${e.message}`);
        }
      }
      setErrors((p) => ({ ...p, [symbol]: triedErrors.join(" · ") || "Tidak ada provider aktif" }));
      setLoadingSet((p) => { const n = new Set(p); n.delete(symbol); return n; });
    },
    [settings, providerOrder, providerEnabled, apiKeys]
  );

  const scanAll = useCallback(async () => {
    setScanning(true);
    setScanDone(false);
    await Promise.all(watchlist.map((s) => fetchOne(s)));
    setScanning(false);
    setScanDone(true);
  }, [watchlist, fetchOne]);

  useEffect(() => {
    if (storageReady) scanAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageReady]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh > 0) intervalRef.current = setInterval(scanAll, autoRefresh * 60 * 1000);
    return () => intervalRef.current && clearInterval(intervalRef.current);
  }, [autoRefresh, scanAll]);

  const addTicker = () => {
    let t = newTicker.trim().toUpperCase();
    if (!t) return;
    if (!t.endsWith(".JK")) t += ".JK";
    if (!watchlist.includes(t)) {
      setWatchlist((p) => [...p, t]);
      setNewTicker("");
      setTimeout(() => fetchOne(t), 0);
    } else setNewTicker("");
  };

  const removeTicker = (symbol) => {
    setWatchlist((p) => p.filter((s) => s !== symbol));
    setData((p) => { const n = { ...p }; delete n[symbol]; return n; });
  };

  const moveProvider = (pid, dir) => {
    setProviderOrder((prev) => {
      const idx = prev.indexOf(pid);
      const swap = idx + dir;
      if (swap < 0 || swap >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  };

  const runAiAnalysis = async (symbol) => {
    const m = data[symbol];
    if (!m) return;
    setAiLoading((p) => new Set(p).add(symbol));
    try {
      const text = await callAiAnalysis(m);
      setAiText((p) => ({ ...p, [symbol]: text }));
    } catch (e) {
      setAiText((p) => ({ ...p, [symbol]: "Gagal memuat analisis AI. Coba lagi." }));
    } finally {
      setAiLoading((p) => { const n = new Set(p); n.delete(symbol); return n; });
    }
  };

  const filtered = watchlist.filter((s) => {
    if (filter === "all") return true;
    const m = data[s];
    if (!m) return false;
    if (filter === "bullish") return m.trend === "Bullish";
    if (filter === "breakout") return m.breakout;
    if (filter === "ara") return m.potentialAra;
    if (filter === "strongbuy") return m.recommendation === "Strong Buy";
    return true;
  });

  const trendColor = (t) => (t === "Bullish" ? "#16A34A" : t === "Bearish" ? "#DC2626" : "#6B7280");
  const recColor = (r) =>
    r === "Strong Buy" ? "#16A34A" : r === "Buy" ? "#2563EB" : r === "Hold / Watchlist" ? "#D97706" : "#DC2626";

  return (
    <div className="min-h-screen w-full bg-[#F7F8FA] text-[#1A1D1F]" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');`}</style>

      <div className="max-w-2xl mx-auto px-3 py-5 sm:px-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#2563EB] flex items-center justify-center text-white font-bold text-sm">AI</div>
            <h1 className="text-lg font-bold tracking-tight">AI Trading</h1>
          </div>
          <div className="flex items-center gap-2">
            <select value={autoRefresh} onChange={(e) => setAutoRefresh(Number(e.target.value))} className="bg-white border border-[#E5E7EB] text-xs px-2 py-1.5 rounded-lg text-[#6B7280] focus:outline-none">
              <option value={0}>Auto-refresh: Off</option>
              <option value={1}>Tiap 1 mnt</option>
              <option value={5}>Tiap 5 mnt</option>
              <option value={15}>Tiap 15 mnt</option>
            </select>
            <button onClick={scanAll} disabled={scanning} className="flex items-center gap-1.5 bg-[#2563EB] text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-[#1D4ED8] transition-colors disabled:opacity-60">
              {scanning ? <RefreshCw size={14} className="animate-spin" /> : scanDone ? "✓" : <RefreshCw size={14} />}
              {scanning ? "Scanning..." : "Scan Saham"}
            </button>
            <button onClick={() => setShowSources((s) => !s)} className="bg-white border border-[#E5E7EB] rounded-lg p-1.5 hover:border-[#2563EB] transition-colors" title="Sumber data">
              <LineChart size={16} className="text-[#6B7280]" />
            </button>
            <button onClick={() => setShowSettings((s) => !s)} className="bg-white border border-[#E5E7EB] rounded-lg p-1.5 hover:border-[#2563EB] transition-colors">
              <Settings2 size={16} className="text-[#6B7280]" />
            </button>
          </div>
        </div>

        {/* Sumber data */}
        {showSources && (
          <div className="bg-white border border-[#E5E7EB] rounded-xl p-4 mb-4 shadow-sm">
            <p className="text-sm font-semibold mb-3">Sumber Data (urutan prioritas — dicoba berurutan sampai berhasil)</p>
            <div className="space-y-2.5">
              {providerOrder.map((pid, idx) => (
                <div key={pid} className="flex items-center gap-2 border border-[#F0F1F3] rounded-lg px-3 py-2">
                  <input type="checkbox" checked={providerEnabled[pid]} onChange={(e) => setProviderEnabled((p) => ({ ...p, [pid]: e.target.checked }))} className="accent-[#2563EB]" />
                  <span className="text-sm font-medium w-28">{PROVIDERS[pid].label}</span>
                  {PROVIDERS[pid].needsKey && (
                    <input
                      type="password"
                      placeholder="API key"
                      value={apiKeys[pid]}
                      onChange={(e) => setApiKeys((p) => ({ ...p, [pid]: e.target.value }))}
                      className="flex-1 text-xs border border-[#E5E7EB] rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#2563EB]"
                    />
                  )}
                  <div className="flex gap-0.5 ml-auto">
                    <button onClick={() => moveProvider(pid, -1)} disabled={idx === 0} className="disabled:opacity-30 text-[#6B7280]"><ChevronUp size={14} /></button>
                    <button onClick={() => moveProvider(pid, 1)} disabled={idx === providerOrder.length - 1} className="disabled:opacity-30 text-[#6B7280]"><ChevronDown size={14} /></button>
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2 border border-dashed border-[#E5E7EB] rounded-lg px-3 py-2 opacity-60">
                <input type="checkbox" disabled className="accent-[#2563EB]" />
                <span className="text-sm font-medium w-28">RTI Business</span>
                <span className="text-xs text-[#9CA3AF] flex items-center gap-1"><Info size={12} /> Tidak ada API publik untuk aplikasi pihak ketiga</span>
              </div>
              <div className="flex items-center gap-2 border border-dashed border-[#E5E7EB] rounded-lg px-3 py-2 opacity-80">
                <input type="checkbox" disabled className="accent-[#2563EB]" checked />
                <span className="text-sm font-medium w-28">TradingView</span>
                <span className="text-xs text-[#9CA3AF] flex items-center gap-1"><Info size={12} /> Dipakai sebagai widget chart live (tombol "Lihat Chart" di tiap kartu), bukan sumber angka</span>
              </div>
            </div>
            <p className="text-xs text-[#9CA3AF] mt-3 leading-relaxed">
              <b>AI Web Search</b> jalan lewat Netlify Function (server-side) yang memanggil Claude API pakai API key
              yang disimpan aman di environment variable Netlify — browser tidak pernah melihat API key-nya. Fitur
              ini butuh env var <code>ANTHROPIC_API_KEY</code> diatur di dashboard Netlify. Angkanya hasil pencarian +
              estimasi AI, jadi anggap sebagai perkiraan yang masuk akal, bukan feed presisi tinggi. Yahoo
              Finance/Finnhub/Alpha Vantage/Polygon.io tetap dicoba sebagai pelengkap lewat CORS proxy publik.
            </p>

            <div className="mt-4 pt-3 border-t border-[#F0F1F3]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold">Diagnostik Koneksi</p>
                <button onClick={runDiagnostics} disabled={diagRunning} className="text-xs bg-[#F7F8FA] border border-[#E5E7EB] rounded-lg px-2.5 py-1 hover:border-[#2563EB] disabled:opacity-50">
                  {diagRunning ? "Menguji..." : "Tes Koneksi"}
                </button>
              </div>
              {diagLog.length > 0 && (
                <div className="space-y-1">
                  {diagLog.map((d, i) => (
                    <div key={i} className="flex items-center justify-between text-xs bg-[#F7F8FA] rounded px-2 py-1">
                      <span className="text-[#6B7280]">{d.name}</span>
                      <span className={d.status.startsWith("ok") || d.status.startsWith("respond") ? "text-[#16A34A]" : "text-[#DC2626]"}>{d.status}</span>
                    </div>
                  ))}
                  <p className="text-[10px] text-[#9CA3AF] mt-1.5 leading-relaxed">
                    Kalau baseline (api.anthropic.com) juga gagal, berarti browser/jaringan kamu yang memblokir fetch
                    keluar sama sekali (coba cek adblocker/VPN/firewall). Kalau baseline sukses tapi semua jalur Yahoo
                    gagal, berarti proxy publik sedang down/limit — coba lagi beberapa saat atau pakai provider lain
                    dengan API key sendiri di atas.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Settings */}
        {showSettings && (
          <div className="bg-white border border-[#E5E7EB] rounded-xl p-4 mb-4 shadow-sm">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { key: "lookbackDays", label: "Lookback (hari)", step: 1 },
                { key: "volMultiplier", label: "Vol breakout (x)", step: 0.1 },
                { key: "slPct", label: "SL (%)", step: 0.5 },
                { key: "riskReward", label: "Risk:Reward", step: 0.5 },
              ].map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs text-[#6B7280]">
                  {f.label}
                  <input type="number" step={f.step} value={settings[f.key]} onChange={(e) => setSettings((s) => ({ ...s, [f.key]: Number(e.target.value) }))} className="border border-[#E5E7EB] rounded px-2 py-1 text-sm" />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Add ticker + filter */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={newTicker} onChange={(e) => setNewTicker(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTicker()} placeholder="Tambah kode saham" className="bg-white border border-[#E5E7EB] rounded-lg px-3 py-1.5 text-sm w-40 focus:outline-none focus:ring-1 focus:ring-[#2563EB]" />
          <button onClick={addTicker} className="bg-white border border-[#E5E7EB] rounded-lg p-1.5 hover:border-[#2563EB] transition-colors"><Plus size={16} /></button>
          <div className="flex gap-1.5 ml-auto flex-wrap text-xs">
            {[{ k: "all", l: "Semua" }, { k: "strongbuy", l: "Strong Buy" }, { k: "bullish", l: "Bullish" }, { k: "breakout", l: "Breakout" }, { k: "ara", l: "Potensi ARA" }].map((f) => (
              <button key={f.k} onClick={() => setFilter(f.k)} className={`px-2.5 py-1.5 rounded-lg border transition-colors ${filter === f.k ? "bg-[#2563EB] text-white border-[#2563EB] font-medium" : "bg-white border-[#E5E7EB] text-[#6B7280] hover:border-[#2563EB]"}`}>
                {f.l}
              </button>
            ))}
          </div>
        </div>

        {/* Cards */}
        <div className="space-y-3">
          {filtered.map((symbol) => {
            const m = data[symbol];
            const err = errors[symbol];
            const loading = loadingSet.has(symbol);
            const code = symbol.replace(".JK", "");
            const tvSymbol = `IDX:${code}`;
            return (
              <div key={symbol} className="bg-white border border-[#E5E7EB] rounded-xl px-4 py-3.5 shadow-sm relative">
                <button onClick={() => removeTicker(symbol)} className="absolute top-3 right-3 text-[#D1D5DB] hover:text-[#DC2626]"><X size={14} /></button>

                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-base font-bold">{code}</span>
                  {m && <span className="text-xs text-[#6B7280]">Rp{fmtPrice(m.lastClose)}</span>}
                  {m && <span className={`text-xs font-medium ${m.pctChange >= 0 ? "text-[#16A34A]" : "text-[#DC2626]"}`}>{fmtPct(m.pctChange)}</span>}
                  {usedProvider[symbol] && <span className="text-[10px] text-[#9CA3AF] ml-auto mr-4">via {usedProvider[symbol]}</span>}
                </div>

                {err ? (
                  <p className="text-xs text-[#DC2626] mt-2">{err}</p>
                ) : loading && !m ? (
                  <p className="text-xs text-[#9CA3AF] mt-2">Memuat data...</p>
                ) : m ? (
                  <>
                    <div className="flex items-center gap-2 mt-1 mb-3">
                      <Stars score={m.score} />
                      <span className="text-sm font-semibold text-[#1A1D1F]">{m.score}/100</span>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
                      {[
                        ["Trend", m.checklist.trend, m.trend],
                        ["Volume", m.checklist.volume, `${m.volRatio.toFixed(1)}x`],
                        ["MACD", m.checklist.macd, m.checklist.macd ? "bullish" : "bearish"],
                        ["MA20", m.checklist.ma20, m.checklist.ma20 ? "di atas" : "di bawah"],
                        ["Resistance", m.checklist.resistance, m.breakout ? "tembus" : `${m.distToResistance.toFixed(1)}%`],
                      ].map(([label, ok, note]) => (
                        <div key={label} className="flex items-center justify-between border-b border-[#F5F6F8] pb-1">
                          <span className="text-[#6B7280]">{label}</span>
                          <span className={`font-medium ${ok ? "text-[#16A34A]" : "text-[#D1D5DB]"}`}>{ok ? "✔" : "—"} <span className="text-[#9CA3AF] font-normal">{note}</span></span>
                        </div>
                      ))}
                    </div>

                    <div className="flex items-center justify-between mb-3 rounded-lg px-3 py-2" style={{ backgroundColor: `${recColor(m.recommendation)}12` }}>
                      <span className="text-xs text-[#6B7280]">Rekomendasi teknikal</span>
                      <span className="text-sm font-bold" style={{ color: recColor(m.recommendation) }}>{m.recommendation}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                      <div className="bg-[#F7F8FA] rounded-lg px-2 py-1.5 text-center">
                        <div className="text-[#9CA3AF]">Entry</div>
                        <div className="font-semibold">{fmtPrice(m.entry)}</div>
                      </div>
                      <div className="bg-[#FEF2F2] rounded-lg px-2 py-1.5 text-center">
                        <div className="text-[#F87171]">SL</div>
                        <div className="font-semibold text-[#DC2626]">{fmtPrice(m.sl)}</div>
                      </div>
                      <div className="bg-[#F0FDF4] rounded-lg px-2 py-1.5 text-center">
                        <div className="text-[#4ADE80]">TP</div>
                        <div className="font-semibold text-[#16A34A]">{fmtPrice(m.tp)}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 mb-1">
                      <button onClick={() => setExpandedChart(expandedChart === symbol ? null : symbol)} className="text-xs text-[#2563EB] font-medium hover:underline">
                        {expandedChart === symbol ? "Sembunyikan chart" : "Lihat Chart (TradingView)"}
                      </button>
                      {!aiText[symbol] && !aiLoading.has(symbol) && (
                        <button onClick={() => runAiAnalysis(symbol)} className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-[#2563EB]">
                          <Sparkles size={12} /> Analisis AI
                        </button>
                      )}
                    </div>

                    {expandedChart === symbol && (
                      <div className="mt-2 rounded-lg overflow-hidden border border-[#E5E7EB]" style={{ height: 320 }}>
                        <iframe
                          title={`chart-${symbol}`}
                          src={`https://www.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tvSymbol)}&interval=D&theme=light&style=1&hide_top_toolbar=0&hide_legend=0`}
                          style={{ width: "100%", height: "100%", border: "none" }}
                        />
                      </div>
                    )}

                    {aiLoading.has(symbol) && <p className="text-xs text-[#9CA3AF] mt-2">AI menganalisis...</p>}
                    {aiText[symbol] && (
                      <div className="mt-2 pt-2 border-t border-[#F0F1F3]">
                        <p className="text-xs font-semibold mb-1 text-[#1A1D1F]">Analisis AI</p>
                        <p className="text-xs leading-relaxed text-[#6B7280]">{aiText[symbol]}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-[#D1D5DB] mt-2">-</p>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && <p className="text-center text-xs text-[#9CA3AF] py-8">Tidak ada saham yang cocok dengan filter ini.</p>}
        </div>

        <div className="mt-5 pt-4 border-t border-[#E5E7EB]">
          <p className="text-[11px] leading-relaxed text-[#9CA3AF]">
            Skor, checklist, dan rekomendasi dihasilkan dari aturan teknikal sederhana (trend, volume, MACD, MA20,
            resistance) — bukan rekomendasi atau ajakan beli/jual dari manusia maupun jaminan hasil. Data historis
            bergantung provider yang aktif dan bisa delay. Analisis AI bersifat naratif teknikal. Selalu cek ulang &
            kelola risiko sendiri sebelum eksekusi order.
          </p>
        </div>
      </div>
    </div>
  );
}
