import { useState, useEffect, useRef, useMemo } from "react";
import { ChevronDown, Play, X, Pencil, Trash2, LogIn, TrendingUp, TrendingDown, ZoomIn, ZoomOut } from "lucide-react";
import { USDOG_LOGO, SOG_LOGO } from "./logos.js";

const TICK_MS = 500;
const MAX_HISTORY = 400;
const VISIBLE_CANDLES_DEFAULT = 70;
const START_BALANCE_USDOG = 1000;
const KRW_PER_USDOG = 1430;

const SOG_TOTAL_SUPPLY = 100_000_000_000_000;
const USDOG_POOL = 1_000_000_000_000;
const START_PRICE = USDOG_POOL / SOG_TOTAL_SUPPLY; // 0.01

// ============ Engine ============
// 난이도별: 변동성 배율, 유저 매매 영향력, 페이크아웃(역방향 유도) 확률
const DIFFICULTY_PRESETS = {
  easy:    { volMult: 0.6, userInfluence: 0.020, fakeoutChance: 0.00, label: "쉬움" },
  normal:  { volMult: 1.0, userInfluence: 0.008, fakeoutChance: 0.05, label: "보통" },
  hard:    { volMult: 1.6, userInfluence: 0.003, fakeoutChance: 0.15, label: "어려움" },
  extreme: { volMult: 2.6, userInfluence: 0.0008, fakeoutChance: 0.30, label: "극한" },
};

function useEngine(orderFlowRef, difficulty) {
  const [candles, setCandles] = useState(() =>
    Array.from({ length: MAX_HISTORY }, (_, i) => ({
      o: START_PRICE, h: START_PRICE * 1.001, l: START_PRICE * 0.999, c: START_PRICE,
      v: 1000 + Math.random() * 500, t: i,
    }))
  );
  const [eventLabel, setEventLabel] = useState(null);
  const sRef = useRef({ price: START_PRICE, momentum: 0, eventTicks: 0, eventDir: 0, tick: 0, pendingFlow: [] });
  const diffRef = useRef(difficulty);
  diffRef.current = difficulty;

  useEffect(() => {
    const id = setInterval(() => {
      const s = sRef.current;
      const preset = DIFFICULTY_PRESETS[diffRef.current] || DIFFICULTY_PRESETS.normal;

      if (s.eventTicks <= 0 && Math.random() < 0.012 * preset.volMult) {
        s.eventTicks = 6 + Math.floor(Math.random() * 10);
        s.eventDir = Math.random() < 0.5 ? 1 : -1;
        setEventLabel(s.eventDir > 0 ? "🚀 대량 매수 유입" : "🔻 대량 매도 유입");
      }

      let drift = (Math.random() - 0.5) * 0.006 * preset.volMult;

      // 유저 주문은 즉시 반영하지 않고 큐에 넣어 지연 후 노이즈와 함께 반영
      const flow = orderFlowRef.current;
      if (flow.pending !== 0) {
        const delay = 3 + Math.floor(Math.random() * 8);
        s.pendingFlow.push({ ticksLeft: delay, amount: flow.pending * preset.userInfluence });
        flow.pending = 0;
      }
      let queuedForce = 0;
      s.pendingFlow = s.pendingFlow.filter((f) => {
        f.ticksLeft -= 1;
        if (f.ticksLeft <= 0) {
          const flipped = Math.random() < preset.fakeoutChance ? -1 : 1;
          queuedForce += f.amount * flipped * (0.5 + Math.random());
          return false;
        }
        return true;
      });
      drift += queuedForce;

      if (s.eventTicks > 0) {
        drift += s.eventDir * (0.01 + Math.random() * 0.015) * preset.volMult;
        s.eventTicks -= 1;
        if (s.eventTicks === 0) setEventLabel(null);
      }

      s.momentum = s.momentum * 0.7 + drift * 0.3;
      const open = s.price;
      let next = Math.max(0.0001, s.price * (1 + s.momentum + drift));
      const high = Math.max(open, next) * (1 + Math.random() * 0.002 * preset.volMult);
      const low = Math.min(open, next) * (1 - Math.random() * 0.002 * preset.volMult);
      const vol = 300 + Math.abs(drift) * 200000 + Math.random() * 700;
      s.price = next;
      s.tick += 1;
      setCandles((prev) => [...prev.slice(1), { o: open, h: high, l: low, c: next, v: vol, t: s.tick }]);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [orderFlowRef]);

  return { candles, eventLabel };
}

// ============ USDOG 페그 엔진 (0.9998 ~ 1.0001 USD 사이 미세 변동) ============
const PEG_MIN = 0.9998;
const PEG_MAX = 1.0001;
function usePegEngine() {
  const [pegHistory, setPegHistory] = useState(() =>
    Array.from({ length: 120 }, () => ({ o: 1, h: 1.00005, l: 0.99995, c: 1 }))
  );
  const pRef = useRef({ price: 1.0 });
  useEffect(() => {
    const id = setInterval(() => {
      const p = pRef.current;
      const meanReversion = (1.0 - p.price) * 0.15; // 1.0으로 회귀하려는 힘
      const noise = (Math.random() - 0.5) * 0.00025;
      let next = p.price + meanReversion + noise;
      next = Math.min(PEG_MAX, Math.max(PEG_MIN, next));
      const open = p.price;
      p.price = next;
      setPegHistory((prev) => [...prev.slice(1), {
        o: open,
        h: Math.max(open, next) + Math.random() * 0.00003,
        l: Math.min(open, next) - Math.random() * 0.00003,
        c: next,
      }]);
    }, 1200);
    return () => clearInterval(id);
  }, []);
  return pegHistory;
}

// ============ Indicators ============
function sma(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += closes[k];
    return sum / period;
  });
}
function bollinger(closes, period, mult) {
  return closes.map((_, i) => {
    if (i < period - 1) return { mid: null, up: null, low: null };
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    return { mid: mean, up: mean + mult * sd, low: mean - mult * sd };
  });
}
function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(0, diff), loss = Math.max(0, -diff);
    if (i <= period) {
      gains += gain; losses += loss;
      if (i === period) {
        const avgG = gains / period, avgL = losses / period;
        out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
        out._avgG = avgG; out._avgL = avgL;
      }
    } else {
      out._avgG = (out._avgG * (period - 1) + gain) / period;
      out._avgL = (out._avgL * (period - 1) + loss) / period;
      out[i] = out._avgL === 0 ? 100 : 100 - 100 / (1 + out._avgG / out._avgL);
    }
  }
  return out;
}
function ichimoku(candles) {
  const highs = candles.map((c) => c.h), lows = candles.map((c) => c.l);
  const mid = (period, i) => {
    if (i < period - 1) return null;
    const h = Math.max(...highs.slice(i - period + 1, i + 1));
    const l = Math.min(...lows.slice(i - period + 1, i + 1));
    return (h + l) / 2;
  };
  const conv = candles.map((_, i) => mid(9, i));
  const base = candles.map((_, i) => mid(26, i));
  const spanB = candles.map((_, i) => mid(52, i));
  const spanA = candles.map((_, i) => (conv[i] != null && base[i] != null ? (conv[i] + base[i]) / 2 : null));
  return { conv, base, spanA, spanB };
}

// ============ Chart w/ pan + zoom ============
function TradingChart({ allCandles, liqPrice, entryPrice, drawings, onAddPoint, drawMode, viewStart, viewCount, onPan, vZoom }) {
  const w = 1000, h = 400, padL = 8, padR = 82, padT = 10, padB = 6;
  const candles = allCandles.slice(viewStart, viewStart + viewCount);
  const closes = allCandles.map((c) => c.c);
  const ma20full = sma(closes, 20), ma50full = sma(closes, 50), ma200full = sma(closes, 200);
  const bollFull = bollinger(closes, 20, 2.2);
  const ichiFull = ichimoku(allCandles);
  const slice = (arr) => arr.slice(viewStart, viewStart + viewCount);
  const ma20 = slice(ma20full), ma50 = slice(ma50full), ma200 = slice(ma200full), boll = slice(bollFull);
  const ichi = { conv: slice(ichiFull.conv), base: slice(ichiFull.base), spanA: slice(ichiFull.spanA), spanB: slice(ichiFull.spanB) };

  const vals = [];
  candles.forEach((c) => vals.push(c.h, c.l));
  boll.forEach((b) => b.up && vals.push(b.up, b.low));
  ichi.spanA.forEach((v) => v != null && vals.push(v));
  ichi.spanB.forEach((v) => v != null && vals.push(v));
  if (liqPrice) vals.push(liqPrice);
  if (entryPrice) vals.push(entryPrice);
  const rawMax = Math.max(...vals) * 1.0004;
  const rawMin = Math.min(...vals) * 0.9996;
  const rawRange = rawMax - rawMin || 1;
  const mid = (rawMax + rawMin) / 2;
  // vZoom: 1 = 기본, >1일수록 세로로 확대(범위 축소)
  const range = rawRange / (vZoom || 1);
  const max = mid + range / 2;
  const min = mid - range / 2;
  const y = (v) => padT + (h - padT - padB) - ((v - min) / range) * (h - padT - padB);
  const x = (i) => padL + (i / (candles.length - 1)) * (w - padL - padR);
  const cw = (w - padL - padR) / candles.length;

  const path = (series) => {
    let d = "";
    series.forEach((v, i) => { if (v == null) return; d += (d === "" ? "M" : "L") + x(i) + "," + y(v) + " "; });
    return d;
  };

  const last = candles[candles.length - 1];
  const gridVals = [max, max - range * 0.25, max - range * 0.5, max - range * 0.75, min];

  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const handlePointerDown = (e) => {
    if (drawMode) return;
    dragRef.current = { startX: e.clientX, startView: viewStart };
  };
  const handlePointerMove = (e) => {
    if (!dragRef.current) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const dxPixels = e.clientX - dragRef.current.startX;
    const dxData = (dxPixels / rect.width) * w;
    const candleShift = Math.round(-dxData / cw);
    let newStart = dragRef.current.startView + candleShift;
    newStart = Math.max(0, Math.min(allCandles.length - viewCount, newStart));
    onPan(newStart);
  };
  const handlePointerUp = () => { dragRef.current = null; };

  // 클릭 좌표 → 데이터 좌표(절대 캔들 인덱스 + 가격)로 변환해 저장 (뷰가 바뀌어도 안전)
  const handleClick = (e) => {
    if (!drawMode) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const py = ((e.clientY - rect.top) / rect.height) * h;
    const localIdx = ((px - padL) / (w - padL - padR)) * (candles.length - 1);
    const absoluteIdx = viewStart + localIdx;
    const priceVal = min + ((h - padT - padB - (py - padT)) / (h - padT - padB)) * range;
    if (!isFinite(absoluteIdx) || !isFinite(priceVal)) return;
    onAddPoint({ idx: absoluteIdx, priceVal });
  };

  // 데이터 좌표 → 현재 뷰의 픽셀 x좌표로 변환 (범위 밖이면 null)
  const idxToX = (absoluteIdx) => {
    const localIdx = absoluteIdx - viewStart;
    if (candles.length <= 1) return null;
    return padL + (localIdx / (candles.length - 1)) * (w - padL - padR);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${w} ${h}`}
      className={`w-full h-full touch-none ${drawMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      preserveAspectRatio="none"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <defs>
        <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0a0d14" />
          <stop offset="100%" stopColor="#000000" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={w} height={h} fill="url(#bgGrad)" />
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="#151b26" strokeWidth="1" />
          <text x={w - padR + 6} y={y(v) + 3} fill="#5b6472" fontSize="10.5" fontFamily="monospace">{v.toFixed(6).slice(0, 8)}</text>
        </g>
      ))}
      <path
        d={path(ichi.spanA) + ichi.spanB.map((v, i) => { const idx = candles.length - 1 - i; const vv = ichi.spanB[idx]; return vv == null ? "" : `L${x(idx)},${y(vv)} `; }).join("") + "Z"}
        fill="#2a5c3a" opacity="0.22"
      />
      <path d={path(ichi.spanA)} stroke="#3ea36b" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d={path(ichi.spanB)} stroke="#c95d5d" strokeWidth="0.8" fill="none" opacity="0.6" />
      <path d={path(ichi.conv)} stroke="#4aa8e0" strokeWidth="1" fill="none" opacity="0.8" />
      <path d={path(ichi.base)} stroke="#e07a4a" strokeWidth="1" fill="none" opacity="0.8" />
      <path d={path(boll.map((b) => b.up))} stroke="#4a7fd6" strokeWidth="1" fill="none" opacity="0.5" />
      <path d={path(boll.map((b) => b.low))} stroke="#4a7fd6" strokeWidth="1" fill="none" opacity="0.5" />
      <path d={path(ma20)} stroke="#f2c14e" strokeWidth="1.2" fill="none" />
      <path d={path(ma50)} stroke="#e5537a" strokeWidth="1.2" fill="none" />
      <path d={path(ma200)} stroke="#ffffff" strokeWidth="1.2" fill="none" />
      {entryPrice && <line x1={padL} x2={w - padR} y1={y(entryPrice)} y2={y(entryPrice)} stroke="#8b96a5" strokeDasharray="4 3" strokeWidth="1" />}
      {liqPrice && (
        <g>
          <line x1={padL} x2={w - padR} y1={y(liqPrice)} y2={y(liqPrice)} stroke="#f6465d" strokeDasharray="2 3" strokeWidth="1" />
          <rect x={w - padR} y={y(liqPrice) - 8} width={padR} height={16} fill="#f6465d" />
          <text x={w - padR + 4} y={y(liqPrice) + 4} fill="#000" fontSize="10" fontFamily="monospace" fontWeight="bold">청산</text>
        </g>
      )}
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const color = up ? "#f6465d" : "#3b82f6";
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth="1" />
            <rect x={x(i) - cw * 0.32} y={Math.min(y(c.o), y(c.c))} width={cw * 0.64} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill={color} />
          </g>
        );
      })}
      {drawings.map((d, i) => {
        const x1 = idxToX(d.p1.idx);
        const x2 = idxToX((d.p2 || d.p1).idx);
        if (x1 == null || x2 == null) return null;
        return (
          <line key={i} x1={x1} y1={y(d.p1.priceVal)} x2={x2} y2={y((d.p2 || d.p1).priceVal)} stroke="#ffd166" strokeWidth="1.5" />
        );
      })}
      <rect x={w - padR} y={y(last.c) - 9} width={padR} height={18} fill={last.c >= last.o ? "#f6465d" : "#3b82f6"} />
      <text x={w - padR + 4} y={y(last.c) + 4} fill="#fff" fontSize="10.5" fontFamily="monospace" fontWeight="bold">{last.c.toFixed(6).slice(0, 8)}</text>
    </svg>
  );
}

// ============ USDOG/USD 페그 미니 차트 (정보용, 거래 불가) ============
function PegChart({ pegHistory }) {
  const w = 1000, h = 70, padL = 8, padR = 60, padT = 8, padB = 8;
  const vals = [];
  pegHistory.forEach((c) => vals.push(c.h, c.l));
  vals.push(PEG_MIN, PEG_MAX);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const range = max - min || 0.0001;
  const y = (v) => padT + (h - padT - padB) - ((v - min) / range) * (h - padT - padB);
  const x = (i) => padL + (i / (pegHistory.length - 1)) * (w - padL - padR);
  const cw = (w - padL - padR) / pegHistory.length;
  const last = pegHistory[pegHistory.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none">
      <rect width={w} height={h} fill="#000" />
      <line x1={padL} x2={w - padR} y1={y(1.0)} y2={y(1.0)} stroke="#2a3040" strokeWidth="1" strokeDasharray="3 2" />
      {pegHistory.map((c, i) => {
        const up = c.c >= c.o;
        const color = up ? "#f6465d" : "#3b82f6";
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} stroke={color} strokeWidth="1" />
            <rect x={x(i) - cw * 0.32} y={Math.min(y(c.o), y(c.c))} width={cw * 0.64} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill={color} />
          </g>
        );
      })}
      <rect x={w - padR} y={y(last.c) - 8} width={padR} height={16} fill={last.c >= 1 ? "#f6465d" : "#3b82f6"} />
      <text x={w - padR + 4} y={y(last.c) + 4} fill="#fff" fontSize="9.5" fontFamily="monospace" fontWeight="bold">{last.c.toFixed(4)}</text>
    </svg>
  );
}

function VolumePanel({ allCandles, viewStart, viewCount }) {
  const candles = allCandles.slice(viewStart, viewStart + viewCount);
  const w = 1000, h = 60, padL = 8, padR = 82;
  const maxV = Math.max(...candles.map((c) => c.v));
  const x = (i) => padL + (i / (candles.length - 1)) * (w - padL - padR);
  const cw = (w - padL - padR) / candles.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none">
      <rect width={w} height={h} fill="#000" />
      {candles.map((c, i) => {
        const up = c.c >= c.o;
        const barH = (c.v / maxV) * (h - 4);
        return <rect key={i} x={x(i) - cw * 0.32} y={h - barH} width={cw * 0.64} height={barH} fill={up ? "#f6465d" : "#3b82f6"} opacity="0.6" />;
      })}
    </svg>
  );
}

function RsiPanel({ allCandles, viewStart, viewCount }) {
  const w = 1000, h = 90, padL = 8, padR = 82, padT = 6, padB = 6;
  const closesFull = allCandles.map((c) => c.c);
  const rsi14Full = rsi(closesFull, 14);
  const validVals = rsi14Full.filter((v) => v != null);
  const rsiSmaFull = sma(validVals, 20);
  const offset = rsi14Full.length - validVals.length;
  const signalFull = new Array(rsi14Full.length).fill(null);
  rsiSmaFull.forEach((v, i) => (signalFull[i + offset] = v));

  const rsi14 = rsi14Full.slice(viewStart, viewStart + viewCount);
  const signal = signalFull.slice(viewStart, viewStart + viewCount);

  const y = (v) => padT + (h - padT - padB) - (v / 100) * (h - padT - padB);
  const x = (i) => padL + (i / (rsi14.length - 1)) * (w - padL - padR);
  const path = (series) => {
    let d = "";
    series.forEach((v, i) => { if (v == null) return; d += (d === "" ? "M" : "L") + x(i) + "," + y(v) + " "; });
    return d;
  };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-full" preserveAspectRatio="none">
      <rect width={w} height={h} fill="#000" />
      {[30, 50, 70].map((v) => <line key={v} x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke="#151b26" strokeWidth="1" />)}
      <path d={path(rsi14)} stroke="#3ea3ff" strokeWidth="1.3" fill="none" />
      <path d={path(signal)} stroke="#f2c14e" strokeWidth="1.3" fill="none" />
      <text x={padL} y={12} fill="#5b6472" fontSize="9.5" fontFamily="monospace">RSI(14) / Signal(20)</text>
    </svg>
  );
}

function OrderBook({ price }) {
  const rows = (dir) => Array.from({ length: 5 }).map((_, i) => ({ p: price * (1 + dir * (i + 1) * 0.00012), qty: Math.floor(200 + Math.random() * 4000) }));
  const asks = rows(1).reverse();
  const bids = rows(-1);
  const maxQty = Math.max(...asks.map((a) => a.qty), ...bids.map((b) => b.qty));
  return (
    <div className="text-[11px] font-mono">
      <div className="flex justify-between items-center text-[#5b6472] px-1 pb-1">
        <span className="flex items-center gap-1">
          <img src={SOG_LOGO} alt="SOG" className="w-3.5 h-3.5 rounded-full object-cover" /> Price (USDOG)
        </span>
        <span>Quantity (SOG)</span>
      </div>
      {asks.map((a, i) => (
        <div key={i} className="relative flex justify-between px-1 py-[3px]">
          <div className="absolute right-0 top-0 h-full bg-[#3a1219]" style={{ width: `${(a.qty / maxQty) * 100}%` }} />
          <span className="relative text-[#f6465d]">{a.p.toFixed(6)}</span>
          <span className="relative text-[#c9d1d9]">{a.qty.toLocaleString()}</span>
        </div>
      ))}
      <div className="text-center py-1.5 text-sm font-bold text-[#f6465d] border-y border-[#1a1f2b] my-0.5">{price.toFixed(6)}</div>
      {bids.map((b, i) => (
        <div key={i} className="relative flex justify-between px-1 py-[3px]">
          <div className="absolute right-0 top-0 h-full bg-[#10203a]" style={{ width: `${(b.qty / maxQty) * 100}%` }} />
          <span className="relative text-[#3b82f6]">{b.p.toFixed(6)}</span>
          <span className="relative text-[#c9d1d9]">{b.qty.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ============ App ============
export default function App() {
  const orderFlowRef = useRef({ pending: 0 });
  const [difficulty, setDifficulty] = useState("normal");
  const { candles, eventLabel } = useEngine(orderFlowRef, difficulty);
  const pegHistory = usePegEngine();
  const pegRate = pegHistory[pegHistory.length - 1].c; // 1 USDOG = pegRate USD
  const price = candles[candles.length - 1].c;
  const openPrice = candles[0].o;
  const changePct = ((price - openPrice) / openPrice) * 100;

  const [loggedIn, setLoggedIn] = useState(false);

  const [balance, setBalance] = useState(START_BALANCE_USDOG);
  const [sogHolding, setSogHolding] = useState(0); // 보유 SOG 현물 (포지션과 별개, 레버리지 없음)
  const [position, setPosition] = useState(null); // {side, size, entry, leverage, margin, mode}
  const [leverage, setLeverage] = useState(12.5);
  const [marginMode, setMarginMode] = useState("cross"); // "cross" | "isolated"
  const [marginInput, setMarginInput] = useState("");
  const [log, setLog] = useState([]);
  const [liquidated, setLiquidated] = useState(false);
  const [tab, setTab] = useState("positions");
  const [showInfo, setShowInfo] = useState(false);
  const [clickFx, setClickFx] = useState(null);

  const [drawMode, setDrawMode] = useState(false);
  const [drawings, setDrawings] = useState([]);
  const pendingPoint = useRef(null);

  // chart view window (pan/zoom)
  const [viewCount, setViewCount] = useState(VISIBLE_CANDLES_DEFAULT);
  const [vZoom, setVZoom] = useState(1); // 세로(가격) 확대 배율
  const [viewStart, setViewStart] = useState(MAX_HISTORY - VISIBLE_CANDLES_DEFAULT);
  const autoFollow = useRef(true);

  useEffect(() => {
    // keep following the latest candle unless user has panned away
    if (autoFollow.current) {
      setViewStart(candles.length - viewCount);
    }
  }, [candles, viewCount]);

  const handlePan = (newStart) => {
    autoFollow.current = newStart >= candles.length - viewCount - 1;
    setViewStart(newStart);
  };
  const zoomIn = () => setViewCount((v) => Math.max(20, v - 15));
  const zoomOut = () => setViewCount((v) => Math.min(MAX_HISTORY, v + 15));
  const vZoomIn = () => setVZoom((v) => Math.min(6, +(v + 0.3).toFixed(2)));
  const vZoomOut = () => setVZoom((v) => Math.max(0.4, +(v - 0.3).toFixed(2)));

  const pushLog = (msg, tone) => setLog((l) => [{ msg, tone, id: Date.now() + Math.random() }, ...l.slice(0, 19)]);

  const liqPrice = position
    ? position.mode === "isolated"
      ? position.side === "long" ? position.entry * (1 - 0.98 / position.leverage) : position.entry * (1 + 0.98 / position.leverage)
      : position.side === "long" ? position.entry * (1 - 1 / position.leverage) : position.entry * (1 + 1 / position.leverage)
    : null;

  const pnl = position ? (position.side === "long" ? (price - position.entry) * position.size : (position.entry - price) * position.size) : 0;
  const pnlPct = position ? (pnl / position.margin) * 100 : 0;

  useEffect(() => {
    if (!position) return;
    const hit = position.side === "long" ? price <= liqPrice : price >= liqPrice;
    if (hit) {
      pushLog(`💥 청산 · ${position.side.toUpperCase()} ${position.leverage}x (${position.mode === "isolated" ? "격리" : "교차"}) · 증거금 ${position.margin.toFixed(2)} USDOG 손실`, "bad");
      setPosition(null);
      // 증거금만 잃음 — 잔고(balance)는 그대로 유지. 잔고가 실질적으로 0일 때만 리필 모달.
      setBalance((b) => {
        const newB = b; // margin은 진입 시 이미 차감되어 있으므로 추가 차감 없음
        if (newB < 0.01) setLiquidated(true);
        return newB;
      });
    }
  }, [price, position, liqPrice]);

  const margin = Number(marginInput) || 0;
  const totalEquityUsdog = balance + (position ? position.margin + pnl : 0) + sogHolding * price;
  const totalEquityKrw = totalEquityUsdog * KRW_PER_USDOG;

  const openPosition = (side) => {
    if (position || liquidated || margin <= 0 || margin > balance) return;
    const size = (margin * leverage) / price;
    setBalance((b) => b - margin);
    setPosition({ side, size, entry: price, leverage, margin, mode: marginMode });
    orderFlowRef.current.pending += side === "long" ? 1 : -1;
    pushLog(`${side === "long" ? "Long" : "Short"} 진입 · ${leverage}x · ${marginMode === "isolated" ? "격리" : "교차"} · ${margin} USDOG`, side === "long" ? "good" : "bad");
    setMarginInput("");
    setClickFx(side);
    setTimeout(() => setClickFx(null), 250);
  };

  // 불타기(추가 증거금 투입) — 교차 모드에서만 허용
  const [addMarginInput, setAddMarginInput] = useState("");
  const addMargin = () => {
    const amt = Number(addMarginInput) || 0;
    if (!position || position.mode !== "cross" || amt <= 0 || amt > balance) return;
    setBalance((b) => b - amt);
    setPosition((p) => ({ ...p, margin: p.margin + amt }));
    pushLog(`🔥 불타기 · 증거금 ${amt} USDOG 추가 (총 ${(position.margin + amt).toFixed(2)} USDOG)`, "neutral");
    setAddMarginInput("");
  };

  const closePosition = () => {
    if (!position) return;
    setBalance((b) => b + position.margin + pnl);
    orderFlowRef.current.pending += position.side === "long" ? -0.7 : 0.7;
    pushLog(`포지션 종료 · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDOG`, pnl >= 0 ? "good" : "bad");
    setPosition(null);
  };

  const instantRefill = () => {
    setBalance(START_BALANCE_USDOG);
    setLiquidated(false);
    pushLog("🎁 코인 리필 · 1000 USDOG 지급", "neutral");
  };

  // ============ SOG ↔ USDOG 컨버트 (현재 시세 기준) ============
  const [convertMode, setConvertMode] = useState("toSog"); // "toSog" | "toUsdog"
  const [convertInput, setConvertInput] = useState("");
  const convertAmount = Number(convertInput) || 0;

  const convertPreview = convertMode === "toSog"
    ? convertAmount / price // USDOG → 받을 SOG
    : convertAmount * price; // SOG → 받을 USDOG

  const doConvert = () => {
    if (convertAmount <= 0) return;
    if (convertMode === "toSog") {
      if (convertAmount > balance) return;
      setBalance((b) => b - convertAmount);
      setSogHolding((s) => s + convertAmount / price);
      pushLog(`🔄 환전 · ${convertAmount.toFixed(2)} USDOG → ${(convertAmount / price).toFixed(2)} SOG`, "neutral");
    } else {
      if (convertAmount > sogHolding) return;
      setSogHolding((s) => s - convertAmount);
      setBalance((b) => b + convertAmount * price);
      pushLog(`🔄 환전 · ${convertAmount.toFixed(2)} SOG → ${(convertAmount * price).toFixed(2)} USDOG`, "neutral");
    }
    setConvertInput("");
  };

  const handleAddPoint = (pt) => {
    if (!pendingPoint.current) pendingPoint.current = pt;
    else {
      setDrawings((d) => [...d, { p1: pendingPoint.current, p2: pt }]);
      pendingPoint.current = null;
      setDrawMode(false);
    }
  };

  if (!loggedIn) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#0a0d14] to-black text-[#c9d1d9] flex items-center justify-center p-6">
        <div className="bg-[#0d1117] border border-[#1a1f2b] rounded-2xl p-8 max-w-xs w-full text-center shadow-[0_0_40px_rgba(246,70,93,0.08)]">
          <div className="w-16 h-16 mx-auto rounded-full overflow-hidden mb-4 shadow-lg"><img src={USDOG_LOGO} alt="USDOG" className="w-full h-full object-cover" /></div>
          <div className="font-bold text-lg mb-1">SADDOG Exchange</div>
          <div className="text-[11px] text-[#5b6472] mb-5">SOG / USDOG 모의투자</div>

          <div className="text-left mb-4">
            <div className="text-[10px] text-[#5b6472] mb-2">난이도 선택</div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(DIFFICULTY_PRESETS).map(([key, p]) => (
                <button
                  key={key}
                  onClick={() => setDifficulty(key)}
                  className={`py-2 rounded-lg text-xs font-semibold border transition-all ${
                    difficulty === key
                      ? "bg-[#e8b339] text-black border-[#e8b339]"
                      : "bg-[#131722] text-[#8b96a5] border-[#1a1f2b] hover:border-[#3a4658]"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="text-[9.5px] text-[#3a4658] mt-2 leading-relaxed">
              {difficulty === "easy" && "변동성 낮음 · 내 매매가 가격에 잘 반영됨 (연습용)"}
              {difficulty === "normal" && "변동성 보통 · 매매 영향은 지연되어 나타남"}
              {difficulty === "hard" && "변동성 높음 · 내 매매 영향력 작음 · 가끔 역방향 유도"}
              {difficulty === "extreme" && "극단적 변동성 · 내 매매 영향 거의 없음 · 페이크아웃 빈번"}
            </div>
          </div>

          <button onClick={() => setLoggedIn(true)} className="w-full bg-white text-black font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 hover:bg-gray-100 active:scale-[0.98] transition-transform">
            <LogIn size={16} /> Google로 계속하기
          </button>
          <div className="text-[9.5px] text-[#3a4658] mt-4 leading-relaxed">⚠ 데모 버전: 실제 구글 인증은 연결되어 있지 않습니다.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-[#c9d1d9] font-sans text-sm select-none pb-6">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#131722] bg-gradient-to-r from-[#0a0d14] to-black">
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-full overflow-hidden"><img src={SOG_LOGO} alt="SOG" className="w-full h-full object-cover" /></div>
          <span className="font-bold text-base">SOG/USDOG</span>
          <button onClick={() => setShowInfo(true)}><ChevronDown size={16} className="text-[#5b6472]" /></button>
          <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-[#131722] text-[#e8b339] font-semibold">{DIFFICULTY_PRESETS[difficulty]?.label}</span>
        </div>
        <span className={`font-mono text-sm font-bold ${changePct >= 0 ? "text-[#f6465d]" : "text-[#3b82f6]"}`}>
          {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
        </span>
      </div>

      <div className="flex items-center justify-between px-3 py-2.5 bg-gradient-to-r from-[#12141b] to-[#0a0d12] border-b border-[#1a1f2b] text-[11px]">
        <span className="text-[#5b6472]">내 자산</span>
        <div className="text-right">
          <div className="font-mono font-bold text-[#e8b339] text-[13px]">{totalEquityUsdog.toFixed(2)} USDOG</div>
          <div className="font-mono text-[#5b6472] text-[10px]">≈ ₩{Math.round(totalEquityKrw).toLocaleString()} · 현금 {balance.toFixed(2)} USDOG · 보유 {sogHolding.toFixed(2)} SOG</div>
        </div>
      </div>

      {eventLabel && (
        <div className="bg-gradient-to-r from-[#1a1206] via-[#241708] to-[#1a1206] text-[#e8b339] text-center text-[11px] py-1.5 font-semibold border-b border-[#2a2010] animate-pulse">
          ⚡ {eventLabel}
        </div>
      )}

      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#131722]">
        <div className="flex gap-2.5 text-[9.5px] font-mono text-[#5b6472] flex-wrap">
          <span className="text-[#f2c14e]">MA20</span>
          <span className="text-[#e5537a]">MA50</span>
          <span className="text-white">MA200</span>
          <span className="text-[#4a7fd6]">BOLL</span>
          <span className="text-[#4aa8e0]">전환선</span>
          <span className="text-[#e07a4a]">기준선</span>
          <span className="text-[#3ea36b]">구름</span>
        </div>
        <div className="flex gap-1 items-center">
          <span className="text-[9px] text-[#3a4658] mr-0.5">좌우</span>
          <button onClick={zoomIn} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white"><ZoomIn size={13} /></button>
          <button onClick={zoomOut} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white"><ZoomOut size={13} /></button>
          <span className="text-[9px] text-[#3a4658] mx-0.5">세로</span>
          <button onClick={vZoomIn} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white rotate-90"><ZoomIn size={13} /></button>
          <button onClick={vZoomOut} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white rotate-90"><ZoomOut size={13} /></button>
          <button onClick={() => { setDrawMode((d) => !d); pendingPoint.current = null; }} className={`p-1.5 rounded ml-1 ${drawMode ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}><Pencil size={13} /></button>
          <button onClick={() => setDrawings([])} className="p-1.5 rounded bg-[#131722] text-[#5b6472]"><Trash2 size={13} /></button>
        </div>
      </div>
      {drawMode && <div className="px-3 py-1 text-[10px] text-[#e8b339] bg-[#1a1206]">차트를 두 번 탭해서 추세선을 그리세요 (본인에게만 표시)</div>}
      {!drawMode && !autoFollow.current && (
        <div className="px-3 py-1 text-[10px] text-[#5b6472] bg-[#0d1117] flex justify-between items-center">
          <span>과거 차트를 보는 중 · 드래그해서 이동</span>
          <button onClick={() => { autoFollow.current = true; setViewStart(candles.length - viewCount); }} className="text-[#e8b339] font-semibold">최신으로 →</button>
        </div>
      )}

      <div className="border-b border-[#131722]" style={{ height: 400 }}>
        <TradingChart allCandles={candles} liqPrice={liqPrice} entryPrice={position?.entry} drawings={drawings} onAddPoint={handleAddPoint} drawMode={drawMode} viewStart={viewStart} viewCount={viewCount} onPan={handlePan} vZoom={vZoom} />
      </div>
      <div className="border-b border-[#131722]" style={{ height: 60 }}><VolumePanel allCandles={candles} viewStart={viewStart} viewCount={viewCount} /></div>
      <div className="border-b border-[#131722]" style={{ height: 90 }}><RsiPanel allCandles={candles} viewStart={viewStart} viewCount={viewCount} /></div>

      {/* USDOG/USD 페그 차트 — 정보용, 거래 불가 */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold text-[#8b96a5]">USDOG / USD 페그</span>
        <span className="text-[9px] text-[#3a4658]">정보 제공용 · 거래 불가</span>
      </div>
      <div className="border-b border-[#131722]" style={{ height: 70 }}><PegChart pegHistory={pegHistory} /></div>

      {/* SOG ↔ USDOG 컨버트 */}
      <div className="mx-3 mt-3 rounded-xl border border-[#1a1f2b] p-3">
        <div className="text-[11px] font-semibold text-[#8b96a5] mb-2">SOG ↔ USDOG 환전</div>
        <div className="flex rounded-lg overflow-hidden border border-[#1a1f2b] mb-2 text-[11px] font-semibold">
          <button
            onClick={() => setConvertMode("toSog")}
            className={`flex-1 py-1.5 ${convertMode === "toSog" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
          >
            USDOG → SOG
          </button>
          <button
            onClick={() => setConvertMode("toUsdog")}
            className={`flex-1 py-1.5 ${convertMode === "toUsdog" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
          >
            SOG → USDOG
          </button>
        </div>
        <div className="text-[10px] text-[#5b6472] flex justify-between mb-1.5">
          <span>보유: {convertMode === "toSog" ? `${balance.toFixed(2)} USDOG` : `${sogHolding.toFixed(2)} SOG`}</span>
          <span>현재가 {price.toFixed(6)}</span>
        </div>
        <input
          type="number"
          value={convertInput}
          onChange={(e) => setConvertInput(e.target.value)}
          placeholder={convertMode === "toSog" ? "USDOG 수량" : "SOG 수량"}
          className="w-full bg-[#131722] border border-[#1a1f2b] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#3a4658] mb-2"
        />
        {convertAmount > 0 && (
          <div className="text-[10.5px] text-[#8b96a5] mb-2 font-mono">
            받는 수량: <span className="text-[#e8b339] font-bold">{convertPreview.toFixed(4)} {convertMode === "toSog" ? "SOG" : "USDOG"}</span>
          </div>
        )}
        <button
          onClick={doConvert}
          disabled={convertAmount <= 0 || (convertMode === "toSog" ? convertAmount > balance : convertAmount > sogHolding)}
          className="w-full bg-[#e8b339] hover:bg-[#f0c257] disabled:opacity-30 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm"
        >
          환전하기
        </button>
      </div>

      {/* Order entry + book */}
      <div className="grid grid-cols-5 gap-0 border-b border-[#131722]">
        <div className="col-span-3 p-3 flex flex-col gap-2.5 border-r border-[#131722]">
          <div className="flex gap-2">
            <select value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} disabled={!!position || liquidated} className="flex-1 bg-[#131722] border border-[#1a1f2b] rounded px-2 py-1.5 text-xs font-mono">
              {[1, 5, 10, 12.5, 25, 50, 75, 100].map((l) => <option key={l} value={l}>{l}x</option>)}
            </select>
            <div className="flex-1 flex rounded overflow-hidden border border-[#1a1f2b]">
              <button
                onClick={() => setMarginMode("cross")}
                disabled={!!position || liquidated}
                className={`flex-1 text-[11px] font-semibold ${marginMode === "cross" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
              >Cross</button>
              <button
                onClick={() => setMarginMode("isolated")}
                disabled={!!position || liquidated}
                className={`flex-1 text-[11px] font-semibold ${marginMode === "isolated" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
              >격리</button>
            </div>
          </div>

          <div className="text-[11px] text-[#5b6472] flex justify-between">
            <span>Available</span>
            <span className="font-mono text-[#c9d1d9]">{balance.toFixed(2)} USDOG</span>
          </div>

          <input type="number" value={marginInput} onChange={(e) => setMarginInput(e.target.value)} placeholder="증거금 (USDOG)" disabled={!!position || liquidated}
            className="w-full bg-[#131722] border border-[#1a1f2b] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#3a4658]" />
          <div className="flex gap-1.5">
            {[0.25, 0.5, 0.75, 1].map((p) => (
              <button key={p} onClick={() => setMarginInput(String(Math.floor(balance * p)))} disabled={!!position || liquidated} className="flex-1 text-[10px] bg-[#131722] hover:bg-[#1a1f2b] rounded py-1 disabled:opacity-40">{p * 100}%</button>
            ))}
          </div>

          {position && (
            <div className="text-[10px] text-[#5b6472] flex justify-between font-mono">
              <span>청산가 ({position.mode === "isolated" ? "격리" : "교차"})</span>
              <span className="text-[#f6465d]">{liqPrice.toFixed(6)}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              onClick={() => openPosition("long")}
              disabled={!!position || liquidated || margin <= 0 || margin > balance}
              className={`bg-[#f6465d] hover:bg-[#e03350] disabled:opacity-30 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-95 ${clickFx === "long" ? "ring-2 ring-white" : ""}`}
            >
              <TrendingUp size={15} /> Long
            </button>
            <button
              onClick={() => openPosition("short")}
              disabled={!!position || liquidated || margin <= 0 || margin > balance}
              className={`bg-[#3b82f6] hover:bg-[#2f6fd6] disabled:opacity-30 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-95 ${clickFx === "short" ? "ring-2 ring-white" : ""}`}
            >
              <TrendingDown size={15} /> Short
            </button>
          </div>
        </div>
        <div className="col-span-2 p-2"><OrderBook price={price} /></div>
      </div>

      <div className="mx-3 mt-2 px-3 py-2 bg-[#131722] rounded text-[10.5px] text-[#8b96a5] flex justify-between items-center">
        <span>⚠ SOG/USDOG는 실험적 시장입니다. 변동성이 매우 높습니다.</span>
      </div>

      {/* Position PnL — big visible card */}
      {position && (
        <div className="mx-3 mt-3 rounded-xl border border-[#1a1f2b] overflow-hidden">
          <div className={`px-4 py-3 flex items-center justify-between ${pnl >= 0 ? "bg-gradient-to-r from-[#1a0a0d] to-[#0d1117]" : "bg-gradient-to-r from-[#0a1220] to-[#0d1117]"}`}>
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${position.side === "long" ? "bg-[#f6465d]/20 text-[#f6465d]" : "bg-[#3b82f6]/20 text-[#3b82f6]"}`}>
                {position.side === "long" ? "LONG" : "SHORT"} {position.leverage}x
              </span>
              <span className="text-[10px] text-[#5b6472]">{position.mode === "isolated" ? "격리" : "교차"}</span>
            </div>
            <button onClick={closePosition} className="bg-[#1a1f2b] hover:bg-[#232a38] text-[11px] font-semibold px-3 py-1.5 rounded flex items-center gap-1"><X size={11} /> 종료</button>
          </div>
          <div className="px-4 py-3 flex items-center justify-between">
            <span className="text-[11px] text-[#5b6472]">평가손익</span>
            <span className={`font-mono font-black text-2xl ${pnl >= 0 ? "text-[#f6465d]" : "text-[#3b82f6]"}`}>
              {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} <span className="text-sm">USDOG</span>
            </span>
          </div>
          <div className="px-4 pb-3 flex justify-between text-[11px]">
            <span className="text-[#5b6472]">수익률</span>
            <span className={`font-mono font-bold ${pnlPct >= 0 ? "text-[#f6465d]" : "text-[#3b82f6]"}`}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</span>
          </div>
          <div className="px-4 pb-3 flex justify-between text-[11px] font-mono">
            <span className="text-[#5b6472]">증거금 / 청산가</span>
            <span>{position.margin.toFixed(2)} USDOG · <span className="text-[#f6465d]">{liqPrice.toFixed(6)}</span></span>
          </div>
          {position.mode === "cross" && (
            <div className="px-4 pb-4 pt-1 border-t border-[#1a1f2b] flex gap-2 items-center">
              <input
                type="number"
                value={addMarginInput}
                onChange={(e) => setAddMarginInput(e.target.value)}
                placeholder="추가 증거금 (불타기)"
                className="flex-1 bg-[#131722] border border-[#1a1f2b] rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-[#3a4658]"
              />
              <button
                onClick={addMargin}
                disabled={Number(addMarginInput) <= 0 || Number(addMarginInput) > balance}
                className="bg-[#e8b339] hover:bg-[#f0c257] disabled:opacity-30 disabled:cursor-not-allowed text-black text-xs font-bold px-3 py-1.5 rounded whitespace-nowrap"
              >
                🔥 불타기
              </button>
            </div>
          )}
          {position.mode === "isolated" && (
            <div className="px-4 pb-3 text-[9.5px] text-[#3a4658]">격리 모드는 추가 증거금 투입이 불가합니다. 청산 위험을 줄이려면 교차 모드를 사용하세요.</div>
          )}
        </div>
      )}

      <div className="flex gap-4 px-3 mt-3 border-b border-[#131722] text-[13px]">
        {["positions", "log"].map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`pb-2 ${tab === t ? "text-white border-b-2 border-[#e8b339] font-semibold" : "text-[#5b6472]"}`}>
            {t === "positions" ? `Positions(${position ? 1 : 0})` : "Log"}
          </button>
        ))}
      </div>

      <div className="p-3">
        {tab === "positions" && !position && <div className="text-center text-[#3a4658] text-xs py-6">보유 중인 포지션이 없습니다</div>}
        {tab === "log" && (
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
            {log.length === 0 && <div className="text-[#3a4658] text-xs py-4 text-center">거래 기록이 없습니다</div>}
            {log.map((l) => (
              <div key={l.id} className={`text-[11px] font-mono ${l.tone === "good" ? "text-[#f6465d]" : l.tone === "bad" ? "text-[#3b82f6]" : "text-[#5b6472]"}`}>{l.msg}</div>
            ))}
          </div>
        )}
      </div>

      {showInfo && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50" onClick={() => setShowInfo(false)}>
          <div className="bg-[#0d1117] border border-[#1a1f2b] rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="font-bold text-base mb-3">SOG 시장 정보</div>
            <div className="space-y-3 text-[12px] font-mono">
              <div className="flex justify-between"><span className="text-[#5b6472]">총발행량</span><span>100,000,000,000,000 SOG</span></div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">예치 준비금</span><span>{USDOG_POOL.toLocaleString()} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${USDOG_POOL.toLocaleString()} USD · ₩{Math.round(USDOG_POOL * KRW_PER_USDOG).toLocaleString()} KRW</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">시작 가격</span><span>{START_PRICE.toFixed(6)} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${START_PRICE.toFixed(6)} USD · ₩{(START_PRICE * KRW_PER_USDOG).toFixed(2)} KRW</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">현재 가격</span><span className="text-[#e8b339]">{price.toFixed(6)} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${price.toFixed(6)} USD · ₩{(price * KRW_PER_USDOG).toFixed(2)} KRW</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">현재 시가총액</span><span>{(price * SOG_TOTAL_SUPPLY).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${(price * SOG_TOTAL_SUPPLY).toLocaleString(undefined, { maximumFractionDigits: 0 })} USD · ₩{Math.round(price * SOG_TOTAL_SUPPLY * KRW_PER_USDOG).toLocaleString()} KRW</span>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-[#5b6472] mt-4 leading-relaxed">시총 = 현재가 × 총발행량. 시작 시총은 예치 준비금(1조 USDOG)과 동일합니다. USDOG는 1달러 페그 스테이블코인이라 USD 금액과 동일합니다.</div>
            <button onClick={() => setShowInfo(false)} className="w-full mt-4 bg-[#131722] py-2 rounded text-xs">닫기</button>
          </div>
        </div>
      )}

      {liquidated && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50">
          <div className="bg-[#0d1117] border border-[#f6465d]/40 rounded-xl p-6 max-w-xs w-full text-center">
            <div className="w-14 h-14 mx-auto rounded-full overflow-hidden mb-3"><img src={USDOG_LOGO} alt="USDOG" className="w-full h-full object-cover" /></div>
            <div className="text-base font-bold text-[#f6465d] mb-1">청산되었습니다</div>
            <div className="text-[11px] text-[#5b6472] mb-5">아래 버튼을 눌러 1000 USDOG를 받고 다시 시작하세요.<br/><span className="text-[#3a4658]">(추후 이 버튼은 광고 시청 후 지급으로 변경됩니다)</span></div>
            <button onClick={instantRefill} className="w-full bg-[#e8b339] hover:bg-[#f0c257] text-black font-bold py-3 rounded-lg flex items-center justify-center gap-2 active:scale-95 transition-transform">
              <Play size={16} /> 코인 리필 받기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
