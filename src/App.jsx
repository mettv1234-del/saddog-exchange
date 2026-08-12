import { useState, useEffect, useRef, useMemo } from "react";
import { ChevronDown, Play, X, Pencil, Trash2, LogIn, TrendingUp, TrendingDown, ZoomIn, ZoomOut, Globe, DoorOpen } from "lucide-react";
import { USDOG_LOGO, SOG_LOGO } from "./logos.js";
import { useTranslation } from "./i18n.js";

const TICK_MS = 500;

// 가격 크기에 따라 적절한 소수 자릿수로 표시 (작은 값은 사토시까지, 큰 값은 짧게)
function formatPrice(v) {
  if (v == null || !isFinite(v)) return "-";
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(6);
  return v.toFixed(9);
}
const MAX_HISTORY = 5000; // 넉넉한 히스토리 보관 (약 40분 분량, TICK_MS=500ms 기준) — MA200/일목 등 지표가 끊기지 않도록
const VISIBLE_CANDLES_DEFAULT = 70;
const START_BALANCE_USDOG = 100;
const KRW_PER_USDOG = 1430;
const PRICE_FLOOR = 0.000000001; // 사토시 단위 하한 (10^-9)

const SOG_TOTAL_SUPPLY = 100_000_000_000_000;
const USDOG_POOL = 1_000_000_000_000;
const START_PRICE = USDOG_POOL / SOG_TOTAL_SUPPLY; // 0.01

// 레버리지별 최대 증거금 한도 (USDOG). 1배는 무제한(Infinity)
const LEVERAGE_MARGIN_CAP = {
  100: 10,
  75: 15,
  50: 20,
  20: 100,
  10: 1000,
  5: 10000,
  3: 100000,
  2: 1000000,
  1: Infinity,
};

// 레버리지별 유지증거금률(Maintenance Margin Rate) — 실제 거래소처럼 레버리지가 높을수록 더 빨리 청산됨
// 레버리지별 유지증거금률(Maintenance Margin Rate) — 실제 거래소처럼 레버리지가 높을수록 mmr도 커서 더 빨리 청산됨
// (저배율일수록 버틸 수 있는 폭이 넓어야 하므로 mmr이 작아야 함)
function maintenanceMarginRate(leverage) {
  if (leverage >= 100) return 0.25;
  if (leverage >= 75) return 0.18;
  if (leverage >= 50) return 0.12;
  if (leverage >= 20) return 0.08;
  if (leverage >= 10) return 0.05;
  if (leverage >= 5) return 0.025;
  if (leverage >= 3) return 0.01;
  if (leverage >= 2) return 0.0075;
  return 0.005; // 1x — 사실상 청산이 거의 발생하지 않음
}

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
  const sRef = useRef({
    price: START_PRICE, momentum: 0, tick: 0, pendingFlow: [],
    event: null, // 빅이벤트 상태머신: {pattern, phase, phaseIdx, phases:[...], startPrice, dir}
    megaEventTicks: 0, megaEventTotalTicks: 0, megaEventDir: 0, megaEventStrength: 0,
  });
  const diffRef = useRef(difficulty);
  diffRef.current = difficulty;

  useEffect(() => {
    const id = setInterval(() => {
      const s = sRef.current;
      const preset = DIFFICULTY_PRESETS[diffRef.current] || DIFFICULTY_PRESETS.normal;

      // 빅이벤트 발동: 패턴1(이중바닥 박스권 브레이크아웃) 또는 패턴2(계단식 지그재그) 중 무작위 선택
      if (!s.event && s.megaEventTicks <= 0 && Math.random() < 0.0022 * preset.volMult) {
        const dir = Math.random() < 0.5 ? 1 : -1;
        const patternType = Math.random() < 0.5 ? 1 : 2;
        const startPrice = s.price;

        if (patternType === 1) {
          // 패턴1: 고점 찍고 조정 → 더 낮은(높은) 고점 → 비슷한 저점 재터치 → 횡보 → 강한 브레이크아웃
          const legMult = 1.4 + Math.random() * 2.2; // 첫 다리 강도
          s.event = {
            pattern: 1, dir, startPrice, phaseIdx: 0,
            phases: [
              { name: "leg1", ticks: 18 + rndInt(12), mult: legMult, vol: 1.0 },        // 첫 상승/하락
              { name: "pullback1", ticks: 12 + rndInt(10), mult: 1 / (legMult * 0.55), vol: 0.6 }, // 조정 (완전히 되돌리지 않음)
              { name: "leg2", ticks: 14 + rndInt(10), mult: legMult * 0.7, vol: 1.0 },  // 이전 고점보다 낮게 재상승
              { name: "retest", ticks: 10 + rndInt(8), mult: 1 / (legMult * 0.62), vol: 0.6 }, // 비슷한 저점 재터치
              { name: "range", ticks: 14 + rndInt(14), mult: 1.02, vol: 0.35 },          // 횡보 (낮은 변동성)
              { name: "breakout", ticks: 20 + rndInt(20), mult: 3.0 + Math.random() * 4, vol: 2.6 }, // 강한 브레이크아웃
            ],
          };
        } else {
          // 패턴2: 저점/고점을 계단식으로 계속 높이며(낮추며) 지그재그 → 마지막 50:50 방향 → 폭발 가속
          const steps = 3 + rndInt(3);
          const phases = [];
          for (let i = 0; i < steps; i++) {
            phases.push({ name: `up${i}`, ticks: 10 + rndInt(8), mult: 1.3 + Math.random() * 0.9, vol: 1.0 });
            phases.push({ name: `pull${i}`, ticks: 8 + rndInt(6), mult: 1 / (1.15 + Math.random() * 0.4), vol: 0.5 });
          }
          const finalDir = Math.random() < 0.5 ? dir : -dir; // 지그재그 끝에 50:50으로 최종 방향 결정
          phases.push({ name: "range", ticks: 10 + rndInt(10), mult: 1.01, vol: 0.3 });
          phases.push({ name: "explode", ticks: 20 + rndInt(18), mult: 3.5 + Math.random() * 4.5, vol: 2.8, overrideDir: finalDir });
          s.event = { pattern: 2, dir, startPrice, phaseIdx: 0, phases };
        }
        emitEventLabel(s);
      }

      // 메가이벤트: 극히 낮은 확률로 비트코인 가격대까지 폭등하는 초대형 이벤트
      if (!s.event && s.megaEventTicks <= 0 && Math.random() < 0.00004) {
        s.megaEventTicks = 300 + rndInt(400);
        s.megaEventTotalTicks = s.megaEventTicks;
        const targetPrice = 8000 + Math.random() * 6000;
        const targetMult = targetPrice / s.price;
        s.megaEventStrength = Math.pow(Math.max(1.01, targetMult), 1 / s.megaEventTicks) - 1;
        setEventLabel("🌕 전설의 불장 · 역대급 강세장 진입");
      }

      let drift = (Math.random() - 0.5) * 0.006 * preset.volMult;

      // 유저 주문은 즉시 반영하지 않고 큐에 넣어 지연 후 노이즈와 함께 반영
      const flow = orderFlowRef.current;
      if (flow.pending !== 0) {
        const delay = 3 + rndInt(8);
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

      const open = s.price;
      let next;
      let wickMult = 1.8; // 기본(평상시) 꼬리 배율

      if (s.megaEventTicks > 0) {
        const progress = 1 - s.megaEventTicks / s.megaEventTotalTicks;
        const wave = Math.sin(progress * Math.PI * 5) * 0.0035 * (1 - progress * 0.5);
        const finalBurst = progress > 0.85 ? (progress - 0.85) * 0.02 : 0;
        next = Math.max(PRICE_FLOOR, s.price * (1 + s.megaEventStrength + wave + finalBurst + (Math.random() - 0.5) * 0.0015));
        s.megaEventTicks -= 1;
        wickMult = 2.2;
        if (s.megaEventTicks === 0) setEventLabel(null);
      } else if (s.event) {
        const ph = s.event.phases[s.event.phaseIdx];
        if (!ph.ticksLeft) ph.ticksLeft = ph.ticks;
        const phaseDir = ph.overrideDir !== undefined ? ph.overrideDir : s.event.dir;
        // 이 phase가 끝날 때까지 mult배 만큼 이동하도록 매틱 증가율 산출
        if (!ph.perTickRate) ph.perTickRate = Math.pow(ph.mult, 1 / ph.ticks) - 1;
        const noiseScale = 0.0008 * ph.vol;
        next = Math.max(PRICE_FLOOR, s.price * (1 + phaseDir * ph.perTickRate + (Math.random() - 0.5) * noiseScale * 2));
        wickMult = 0.6 + ph.vol * 0.9; // 조정/횡보는 꼬리 짧게, 브레이크아웃/폭발은 꼬리 길게
        ph.ticksLeft -= 1;
        if (ph.ticksLeft <= 0) {
          s.event.phaseIdx += 1;
          if (s.event.phaseIdx >= s.event.phases.length) {
            s.event = null;
            setEventLabel(null);
          } else {
            emitEventLabel(s);
          }
        }
      } else {
        // 평상시(횡보): 변동성을 살려서 지루하지 않게
        s.momentum = s.momentum * 0.65 + drift * 0.35;
        next = Math.max(PRICE_FLOOR, s.price * (1 + s.momentum + drift * 1.6));
        wickMult = 1.8;
      }

      const high = Math.max(open, next) * (1 + Math.random() * 0.002 * preset.volMult * wickMult);
      const low = Math.max(PRICE_FLOOR, Math.min(open, next) * (1 - Math.random() * 0.002 * preset.volMult * wickMult));
      const vol = 300 + Math.abs(drift) * 200000 + Math.random() * 700;
      s.price = next;
      s.tick += 1;
      setCandles((prev) => [...prev.slice(1), { o: open, h: high, l: low, c: next, v: vol, t: s.tick }]);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [orderFlowRef]);

  function rndInt(n) { return Math.floor(Math.random() * n); }
  function emitEventLabel(s) {
    const ph = s.event.phases[s.event.phaseIdx];
    const labels = {
      leg1: s.event.dir > 0 ? "🚀 1차 상승 전개" : "🔻 1차 하락 전개",
      pullback1: "⚖️ 단기 조정 진행 중",
      leg2: s.event.dir > 0 ? "🚀 2차 상승 시도" : "🔻 2차 하락 시도",
      retest: "🔁 저점(고점) 재확인 중",
      range: "😴 횡보 구간 · 방향 탐색 중",
      breakout: s.event.dir > 0 ? "💥 박스권 강한 상방 돌파" : "💥 박스권 강한 하방 이탈",
      explode: (ph.overrideDir ?? s.event.dir) > 0 ? "💥 폭발적 상승 가속" : "💥 폭발적 하락 가속",
    };
    const key = ph.name.replace(/[0-9]/g, "");
    setEventLabel(labels[key] || labels[ph.name] || "⚡ 변동성 확대 중");
  }

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
function TradingChart({ allCandles, entryLines, drawings, onAddPoint, drawMode, viewStart, viewCount, onPan, vZoom, onZoomH, onZoomV, onSetViewCount, tradeMarkers }) {
  const w = 1000, h = 400, padL = 8, padR = 82, padT = 10, padB = 6;
  const candles = allCandles.slice(viewStart, viewStart + viewCount);

  // 성능 최적화: 전체 히스토리 대신 "보이는 구간 + 지표 계산에 필요한 lookback"만 잘라서 계산
  // (MA200이 가장 긴 lookback=200; 화면을 넓게 볼 때도 최소 200개 선행 데이터 확보)
  const LOOKBACK = Math.max(220, 200);
  const calcStart = Math.max(0, viewStart - LOOKBACK);
  const calcSlice = allCandles.slice(calcStart, viewStart + viewCount);
  const closes = calcSlice.map((c) => c.c);
  const ma20full = sma(closes, 20), ma50full = sma(closes, 50), ma200full = sma(closes, 200);
  const bollFull = bollinger(closes, 20, 2.2);
  const ichiFull = ichimoku(calcSlice);
  // calcSlice 기준 인덱스를 뷰포트(viewStart) 기준으로 다시 잘라내기
  const viewOffsetInCalc = viewStart - calcStart;
  const slice = (arr) => arr.slice(viewOffsetInCalc, viewOffsetInCalc + viewCount);
  const ma20 = slice(ma20full), ma50 = slice(ma50full), ma200 = slice(ma200full), boll = slice(bollFull);
  const ichi = { conv: slice(ichiFull.conv), base: slice(ichiFull.base), spanA: slice(ichiFull.spanA), spanB: slice(ichiFull.spanB) };

  const vals = [];
  candles.forEach((c) => vals.push(c.h, c.l));
  boll.forEach((b) => b.up && vals.push(b.up, b.low));
  ichi.spanA.forEach((v) => v != null && vals.push(v));
  ichi.spanB.forEach((v) => v != null && vals.push(v));
  if (entryLines) entryLines.forEach((l) => { vals.push(l.entry); if (l.liq) vals.push(l.liq); });
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
    if (e.pointerType === "touch") return; // 터치는 onTouchStart에서 별도 처리 (핀치 지원 위해)
    dragRef.current = { startX: e.clientX, startView: viewStart };
  };
  const handlePointerMove = (e) => {
    if (e.pointerType === "touch") return;
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

  // 마우스 휠: 세로 스크롤 = 좌우(캔들 개수) 확대, Shift+휠 = 세로(가격범위) 확대
  const handleWheel = (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      onZoomV && onZoomV(e.deltaY < 0 ? 1 : -1);
    } else {
      onZoomH && onZoomH(e.deltaY < 0 ? 1 : -1);
    }
  };

  // 핀치 줌 (모바일 두 손가락) — 거리 변화로 좌우(캔들 개수) 확대/축소
  const pinchRef = useRef(null);
  const touchDist = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const handleTouchStart = (e) => {
    if (drawMode) return;
    if (e.touches.length === 2) {
      pinchRef.current = { startDist: touchDist(e.touches), startCount: viewCount };
      dragRef.current = null; // 팬 동작과 겹치지 않게
    } else if (e.touches.length === 1) {
      dragRef.current = { startX: e.touches[0].clientX, startView: viewStart };
    }
  };
  const handleTouchMove = (e) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault();
      const dist = touchDist(e.touches);
      const ratio = pinchRef.current.startDist / Math.max(1, dist); // 손가락 벌리면 ratio<1 → 확대(캔들 수 감소)
      let newCount = Math.round(pinchRef.current.startCount * ratio);
      newCount = Math.max(20, Math.min(MAX_HISTORY, newCount));
      onSetViewCount && onSetViewCount(newCount);
    } else if (e.touches.length === 1 && dragRef.current) {
      const svg = svgRef.current;
      const rect = svg.getBoundingClientRect();
      const dxPixels = e.touches[0].clientX - dragRef.current.startX;
      const dxData = (dxPixels / rect.width) * w;
      const candleShift = Math.round(-dxData / cw);
      let newStart = dragRef.current.startView + candleShift;
      newStart = Math.max(0, Math.min(allCandles.length - viewCount, newStart));
      onPan(newStart);
    }
  };
  const handleTouchEnd = (e) => {
    if (e.touches.length < 2) pinchRef.current = null;
    if (e.touches.length === 0) dragRef.current = null;
  };

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
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
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
          <text x={w - padR + 6} y={y(v) + 3} fill="#5b6472" fontSize="10.5" fontFamily="monospace">{formatPrice(v)}</text>
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
      {(entryLines || []).map((l, i) => (
        <g key={i}>
          <line x1={padL} x2={w - padR} y1={y(l.entry)} y2={y(l.entry)} stroke="#8b96a5" strokeDasharray="4 3" strokeWidth="1" />
          {l.liq && (
            <g>
              <line x1={padL} x2={w - padR} y1={y(l.liq)} y2={y(l.liq)} stroke="#f6465d" strokeDasharray="2 3" strokeWidth="1" />
              <rect x={w - padR} y={y(l.liq) - 8} width={padR} height={16} fill="#f6465d" />
              <text x={w - padR + 4} y={y(l.liq) + 4} fill="#000" fontSize="10" fontFamily="monospace" fontWeight="bold">청산</text>
            </g>
          )}
        </g>
      ))}
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
      {/* 거래 마커: 롱진입(B, 초록 위 삼각형), 숏진입(S, 빨강 아래 삼각형), 종료/청산은 X */}
      {(tradeMarkers || []).map((mk, i) => {
        const mx = idxToX(mk.idx);
        if (mx == null) return null;
        const my = y(mk.price);
        if (mk.type === "entry") {
          const isLong = mk.side === "long";
          const color = isLong ? "#00d68f" : "#f6465d";
          const triY = isLong ? my + 14 : my - 14;
          const points = isLong
            ? `${mx - 5},${triY + 6} ${mx + 5},${triY + 6} ${mx},${triY - 4}`
            : `${mx - 5},${triY - 6} ${mx + 5},${triY - 6} ${mx},${triY + 4}`;
          return (
            <g key={i}>
              <polygon points={points} fill={color} />
              <text x={mx} y={isLong ? triY + 20 : triY - 12} fill={color} fontSize="9" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
                {isLong ? "B" : "S"}
              </text>
            </g>
          );
        }
        // exit / liquidation
        const color = mk.type === "liquidation" ? "#f6465d" : "#8b96a5";
        return (
          <g key={i} opacity="0.85">
            <circle cx={mx} cy={my} r="5" fill="none" stroke={color} strokeWidth="1.3" />
            <line x1={mx - 2.5} y1={my - 2.5} x2={mx + 2.5} y2={my + 2.5} stroke={color} strokeWidth="1.3" />
            <line x1={mx - 2.5} y1={my + 2.5} x2={mx + 2.5} y2={my - 2.5} stroke={color} strokeWidth="1.3" />
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
      <text x={w - padR + 4} y={y(last.c) + 4} fill="#fff" fontSize="10.5" fontFamily="monospace" fontWeight="bold">{formatPrice(last.c)}</text>
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
  // 성능 최적화: RSI(14)+Signal(20) 계산에 필요한 lookback만 사용
  const LOOKBACK = 60;
  const calcStart = Math.max(0, viewStart - LOOKBACK);
  const closesFull = allCandles.slice(calcStart, viewStart + viewCount).map((c) => c.c);
  const rsi14Full = rsi(closesFull, 14);
  const validVals = rsi14Full.filter((v) => v != null);
  const rsiSmaFull = sma(validVals, 20);
  const offset = rsi14Full.length - validVals.length;
  const signalFull = new Array(rsi14Full.length).fill(null);
  rsiSmaFull.forEach((v, i) => (signalFull[i + offset] = v));

  const viewOffsetInCalc = viewStart - calcStart;
  const rsi14 = rsi14Full.slice(viewOffsetInCalc, viewOffsetInCalc + viewCount);
  const signal = signalFull.slice(viewOffsetInCalc, viewOffsetInCalc + viewCount);

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
          <span className="relative text-[#f6465d]">{formatPrice(a.p)}</span>
          <span className="relative text-[#c9d1d9]">{a.qty.toLocaleString()}</span>
        </div>
      ))}
      <div className="text-center py-1.5 text-sm font-bold text-[#f6465d] border-y border-[#1a1f2b] my-0.5">{formatPrice(price)}</div>
      {bids.map((b, i) => (
        <div key={i} className="relative flex justify-between px-1 py-[3px]">
          <div className="absolute right-0 top-0 h-full bg-[#10203a]" style={{ width: `${(b.qty / maxQty) * 100}%` }} />
          <span className="relative text-[#3b82f6]">{formatPrice(b.p)}</span>
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
  const [lang, setLang] = useState("ko");
  const t = useTranslation(lang);
  const { candles, eventLabel } = useEngine(orderFlowRef, difficulty);
  const pegHistory = usePegEngine();
  const pegRate = pegHistory[pegHistory.length - 1].c; // 1 USDOG = pegRate USD
  const price = candles[candles.length - 1].c;
  const openPrice = candles[0].o;
  const changePct = ((price - openPrice) / openPrice) * 100;

  const [loggedIn, setLoggedIn] = useState(false);
  const [marketView, setMarketView] = useState("futures"); // "futures" (SOG/USDOG) | "spot" (USDOG/USD)
  const [showMarketMenu, setShowMarketMenu] = useState(false);

  const [balance, setBalance] = useState(START_BALANCE_USDOG);
  const [sogHolding, setSogHolding] = useState(0); // 보유 SOG 현물 (포지션과 별개, 레버리지 없음)
  const [positions, setPositions] = useState([]); // [{id, side, size, entry, leverage, margin, mode}]
  const [hedgeMode, setHedgeMode] = useState(false); // 양방향 포지션 허용 토글
  const [tradeMarkers, setTradeMarkers] = useState([]); // {idx, price, type: "buy"|"sell", side}
  const [leverage, setLeverage] = useState(12.5);
  const [marginMode, setMarginMode] = useState("cross"); // "cross" | "isolated"
  const [marginInput, setMarginInput] = useState("");
  const [log, setLog] = useState([]);
  const [liquidated, setLiquidated] = useState(false); // deprecated: kept for disabled= checks below
  const [flashLiquidation, setFlashLiquidation] = useState(false);
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

  // 청산가 계산: 격리는 증거금 100% 손실 근접 시, 교차는 전체 계좌자산이 유지증거금에 닿을 때
  // (교차는 잔고까지 담보이므로 "가격만으로" 정확한 청산가를 못 박기 어려워, 매틱 실시간 검사로 처리)
  function calcIsolatedLiqPrice(pos) {
    const mmr = maintenanceMarginRate(pos.leverage);
    // 격리: 증거금 대비 (1 - mmr) 만큼 손실나면 청산 (실제 거래소 근사식)
    const lossRatio = (1 - mmr) / pos.leverage;
    return pos.side === "long" ? pos.entry * (1 - lossRatio) : pos.entry * (1 + lossRatio);
  }

  const positionPnl = (pos, curPrice) =>
    pos.side === "long" ? (curPrice - pos.entry) * pos.size : (pos.entry - curPrice) * pos.size;

  useEffect(() => {
    if (positions.length === 0) return;
    const toLiquidate = [];
    for (const pos of positions) {
      const pnlNow = positionPnl(pos, price);
      if (pos.mode === "isolated") {
        const liq = calcIsolatedLiqPrice(pos);
        const hit = pos.side === "long" ? price <= liq : price >= liq;
        if (hit) toLiquidate.push(pos);
      } else {
        // 교차: 계좌 전체 자산(잔고 + 모든 교차포지션의 증거금+평가손익 합)이 유지증거금 이하로 떨어지면 청산
        const mmr = maintenanceMarginRate(pos.leverage);
        const notional = pos.size * price;
        const maintenanceMargin = notional * mmr;
        const crossPositions = positions.filter((p) => p.mode === "cross");
        const crossEquity = balance + crossPositions.reduce((sum, p) => sum + p.margin + positionPnl(p, price), 0);
        // 모든 교차 포지션의 유지증거금 합계와 비교 (계좌 전체가 공동담보이므로)
        const totalMaintenanceMargin = crossPositions.reduce((sum, p) => sum + p.size * price * maintenanceMarginRate(p.leverage), 0);
        if (crossEquity <= totalMaintenanceMargin) toLiquidate.push(pos);
      }
    }
    if (toLiquidate.length > 0) {
      toLiquidate.forEach((pos) => {
        pushLog(`💥 청산 · ${pos.side.toUpperCase()} ${pos.leverage}x (${pos.mode === "isolated" ? "격리" : "교차"}) · 증거금 ${pos.margin.toFixed(2)} USDOG 손실`, "bad");
        setTradeMarkers((m) => [...m, { idx: candles[candles.length - 1].t, price, type: "liquidation", side: pos.side }]);
      });
      setPositions((prev) => prev.filter((p) => !toLiquidate.includes(p)));
      setFlashLiquidation(true);
      setTimeout(() => setFlashLiquidation(false), 500);
    }
  }, [price, positions, balance]);

  const margin = Number(marginInput) || 0;
  const totalPositionsValue = positions.reduce((sum, p) => sum + p.margin + positionPnl(p, price), 0);
  const totalEquityUsdog = balance + totalPositionsValue + sogHolding * price;
  const totalEquityKrw = totalEquityUsdog * KRW_PER_USDOG;

  const marginCap = LEVERAGE_MARGIN_CAP[leverage] ?? Infinity;
  const hasLong = positions.some((p) => p.side === "long");
  const hasShort = positions.some((p) => p.side === "short");
  const canOpen = (side) => {
    if (!hedgeMode && positions.length > 0) return false; // 단방향: 이미 포지션 있으면 불가
    if (hedgeMode && ((side === "long" && hasLong) || (side === "short" && hasShort))) return false; // 같은 방향 중복 방지
    return true;
  };

  const openPosition = (side) => {
    if (!canOpen(side) || margin <= 0 || margin > balance) return;
    if (margin > marginCap) return;
    const size = (margin * leverage) / price;
    setBalance((b) => b - margin);
    setPositions((prev) => [...prev, { id: Date.now() + Math.random(), side, size, entry: price, leverage, margin, mode: marginMode }]);
    orderFlowRef.current.pending += side === "long" ? 1 : -1;
    pushLog(`${side === "long" ? "Long" : "Short"} 진입 · ${leverage}x · ${marginMode === "isolated" ? "격리" : "교차"} · ${margin} USDOG`, side === "long" ? "good" : "bad");
    setTradeMarkers((m) => [...m, { idx: candles[candles.length - 1].t, price, type: "entry", side }]);
    setMarginInput("");
    setClickFx(side);
    setTimeout(() => setClickFx(null), 250);
  };

  // 불타기(추가 증거금 투입) — 교차 모드에서만 허용
  const [addMarginInput, setAddMarginInput] = useState("");
  const [addMarginTargetId, setAddMarginTargetId] = useState(null);
  const addMargin = () => {
    const amt = Number(addMarginInput) || 0;
    const target = positions.find((p) => p.id === addMarginTargetId);
    if (!target || target.mode !== "cross" || amt <= 0 || amt > balance) return;
    setBalance((b) => b - amt);
    setPositions((prev) => prev.map((p) => (p.id === target.id ? { ...p, margin: p.margin + amt } : p)));
    pushLog(`🔥 불타기 · 증거금 ${amt} USDOG 추가 (총 ${(target.margin + amt).toFixed(2)} USDOG)`, "neutral");
    setAddMarginInput("");
  };

  const closePosition = (posId) => {
    const pos = positions.find((p) => p.id === posId);
    if (!pos) return;
    const pnlNow = positionPnl(pos, price);
    setBalance((b) => b + pos.margin + pnlNow);
    orderFlowRef.current.pending += pos.side === "long" ? -0.7 : 0.7;
    pushLog(`포지션 종료 · ${pnlNow >= 0 ? "+" : ""}${pnlNow.toFixed(2)} USDOG`, pnlNow >= 0 ? "good" : "bad");
    setTradeMarkers((m) => [...m, { idx: candles[candles.length - 1].t, price, type: "exit", side: pos.side }]);
    setPositions((prev) => prev.filter((p) => p.id !== posId));
  };

  const instantRefill = () => {
    setBalance((b) => b + START_BALANCE_USDOG);
    pushLog(`🎁 코인 리필 · ${START_BALANCE_USDOG} USDOG 지급`, "neutral");
  };

  // ============ SOG ↔ USDOG 컨버트 (현재 시세 기준) ============
  const [convertMode, setConvertMode] = useState("toSog"); // "toSog" | "toUsdog"
  const [convertInput, setConvertInput] = useState("");
  const [convertIsMax, setConvertIsMax] = useState(false); // MAX 선택 시 원본 정밀값 사용
  const convertAmount = convertIsMax
    ? (convertMode === "toSog" ? balance : sogHolding)
    : (Number(convertInput) || 0);

  const convertPreview = convertMode === "toSog"
    ? convertAmount / price // USDOG → 받을 SOG
    : convertAmount * price; // SOG → 받을 USDOG

  const handleConvertInputChange = (val) => {
    setConvertIsMax(false);
    setConvertInput(val);
  };

  const handleConvertMax = () => {
    setConvertIsMax(true);
    // 화면 표시는 깔끔하게 반올림 (실제 전송은 convertAmount의 원본 값 사용)
    const raw = convertMode === "toSog" ? balance : sogHolding;
    setConvertInput(raw.toFixed(convertMode === "toSog" ? 2 : 4));
  };

  const doConvert = () => {
    if (convertAmount <= 0) return;
    if (convertMode === "toSog") {
      if (convertAmount > balance) return;
      const sogReceived = convertAmount / price;
      setBalance((b) => Math.max(0, b - convertAmount));
      setSogHolding((s) => s + sogReceived);
      pushLog(`🔄 환전 · ${convertAmount.toFixed(2)} USDOG → ${sogReceived.toFixed(2)} SOG`, "neutral");
    } else {
      if (convertAmount > sogHolding) return;
      const usdogReceived = convertAmount * price;
      setSogHolding((s) => Math.max(0, s - convertAmount));
      setBalance((b) => b + usdogReceived);
      pushLog(`🔄 환전 · ${convertAmount.toFixed(2)} SOG → ${usdogReceived.toFixed(2)} USDOG`, "neutral");
    }
    setConvertInput("");
    setConvertIsMax(false);
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
          <div className="flex justify-end mb-2">
            <div className="flex rounded-lg overflow-hidden border border-[#1a1f2b] text-[10px] font-semibold">
              <button onClick={() => setLang("ko")} className={`px-2.5 py-1 ${lang === "ko" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}>한국어</button>
              <button onClick={() => setLang("en")} className={`px-2.5 py-1 ${lang === "en" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}>English</button>
            </div>
          </div>
          <div className="w-16 h-16 mx-auto rounded-full overflow-hidden mb-4 shadow-lg"><img src={USDOG_LOGO} alt="USDOG" className="w-full h-full object-cover" /></div>
          <div className="font-bold text-lg mb-1">{t.appName}</div>
          <div className="text-[11px] text-[#5b6472] mb-5">{t.tagline}</div>

          <div className="text-left mb-4">
            <div className="text-[10px] text-[#5b6472] mb-2">{t.difficultyLabel}</div>
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
                  {t.difficulty[key]}
                </button>
              ))}
            </div>
            <div className="text-[9.5px] text-[#3a4658] mt-2 leading-relaxed">
              {t.difficultyDesc[difficulty]}
            </div>
          </div>

          <button onClick={() => setLoggedIn(true)} className="w-full bg-white text-black font-semibold py-2.5 rounded-lg flex items-center justify-center gap-2 hover:bg-gray-100 active:scale-[0.98] transition-transform">
            <LogIn size={16} /> {t.googleLogin}
          </button>
          <div className="text-[9.5px] text-[#3a4658] mt-4 leading-relaxed">{t.demoNotice}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-[#c9d1d9] font-sans text-sm select-none pb-6">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#131722] bg-gradient-to-r from-[#0a0d14] to-black relative">
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-full overflow-hidden"><img src={marketView === "futures" ? SOG_LOGO : USDOG_LOGO} alt="logo" className="w-full h-full object-cover" /></div>
          <button onClick={() => setShowMarketMenu((v) => !v)} className="flex items-center gap-1">
            <span className="font-bold text-base">{marketView === "futures" ? "SOG/USDOG" : "USDOG/USD"}</span>
            <ChevronDown size={16} className={`text-[#5b6472] transition-transform ${showMarketMenu ? "rotate-180" : ""}`} />
          </button>
          <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-[#131722] text-[#e8b339] font-semibold">{t.difficulty[difficulty]}</span>
        </div>
        {marketView === "futures" ? (
          <span className={`font-mono text-sm font-bold ${changePct >= 0 ? "text-[#f6465d]" : "text-[#3b82f6]"}`}>
            {changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%
          </span>
        ) : (
          <span className="font-mono text-sm font-bold text-[#8b96a5]">{pegRate.toFixed(4)}</span>
        )}

        {showMarketMenu && (
          <div className="absolute top-full left-3 mt-1 w-64 bg-[#0d1117] border border-[#1a1f2b] rounded-xl shadow-xl z-40 overflow-hidden">
            <div className="px-3 py-2 text-[10px] text-[#5b6472] border-b border-[#1a1f2b]">{t.marketSelectTitle}</div>
            <button
              onClick={() => { setMarketView("futures"); setShowMarketMenu(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[#131722] ${marketView === "futures" ? "bg-[#131722]" : ""}`}
            >
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0"><img src={SOG_LOGO} className="w-full h-full object-cover" alt="" /></div>
              <div>
                <div className="text-sm font-semibold">SOG/USDOG</div>
                <div className="text-[10px] text-[#5b6472]">{t.marketFutures}</div>
              </div>
            </button>
            <button
              onClick={() => { setMarketView("spot"); setShowMarketMenu(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-[#131722] ${marketView === "spot" ? "bg-[#131722]" : ""}`}
            >
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0"><img src={USDOG_LOGO} className="w-full h-full object-cover" alt="" /></div>
              <div>
                <div className="text-sm font-semibold">USDOG/USD</div>
                <div className="text-[10px] text-[#5b6472]">{t.marketSpot}</div>
              </div>
            </button>
            <div className="border-t border-[#1a1f2b]">
              <button
                onClick={() => setShowInfo(true)}
                className="w-full px-3 py-2.5 text-left text-xs text-[#8b96a5] hover:bg-[#131722]"
              >
                {t.marketInfoTitle}
              </button>
              <div className="px-3 py-2 flex items-center gap-1.5 text-[10px] text-[#5b6472]">
                <Globe size={12} />
                <button onClick={() => setLang("ko")} className={`px-2 py-0.5 rounded ${lang === "ko" ? "bg-[#e8b339] text-black" : "bg-[#131722]"}`}>한국어</button>
                <button onClick={() => setLang("en")} className={`px-2 py-0.5 rounded ${lang === "en" ? "bg-[#e8b339] text-black" : "bg-[#131722]"}`}>English</button>
              </div>
              <button
                onClick={() => { setShowMarketMenu(false); setLoggedIn(false); }}
                className="w-full px-3 py-2.5 text-left text-xs text-[#f6465d] hover:bg-[#131722] flex items-center gap-1.5 border-t border-[#1a1f2b]"
              >
                <DoorOpen size={13} /> {t.exitToMenu}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-2.5 bg-gradient-to-r from-[#12141b] to-[#0a0d12] border-b border-[#1a1f2b] text-[11px]">
        <span className="text-[#5b6472]">{t.myAssets}</span>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <div className="font-mono font-bold text-[#e8b339] text-[13px]">{totalEquityUsdog.toFixed(2)} USDOG</div>
            <div className="font-mono text-[#5b6472] text-[10px]">≈ ₩{Math.round(totalEquityKrw).toLocaleString()} · {t.cash} {balance.toFixed(2)} USDOG · {t.holding} {sogHolding.toFixed(2)} SOG</div>
          </div>
          <button
            onClick={instantRefill}
            title={t.refillButton}
            className="flex items-center gap-1 bg-[#131722] hover:bg-[#1a1f2b] border border-[#1a1f2b] text-[#e8b339] text-[10px] font-semibold px-2 py-1.5 rounded-lg whitespace-nowrap active:scale-95 transition-transform"
          >
            <Play size={11} /> +{START_BALANCE_USDOG}
          </button>
        </div>
      </div>

      {eventLabel && (
        <div className="bg-gradient-to-r from-[#1a1206] via-[#241708] to-[#1a1206] text-[#e8b339] text-center text-[11px] py-1.5 font-semibold border-b border-[#2a2010] animate-pulse">
          ⚡ {eventLabel}
        </div>
      )}

      {marketView === "futures" && (
        <>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#131722]">
        <div className="flex gap-2.5 text-[9.5px] font-mono text-[#5b6472] flex-wrap">
          <span className="text-[#f2c14e]">{t.ma20}</span>
          <span className="text-[#e5537a]">{t.ma50}</span>
          <span className="text-white">{t.ma200}</span>
          <span className="text-[#4a7fd6]">{t.boll}</span>
          <span className="text-[#4aa8e0]">{t.tenkan}</span>
          <span className="text-[#e07a4a]">{t.kijun}</span>
          <span className="text-[#3ea36b]">{t.cloud}</span>
        </div>
        <div className="flex gap-1 items-center">
          <span className="text-[9px] text-[#3a4658] mr-0.5">{t.horizontal}</span>
          <button onClick={zoomIn} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white"><ZoomIn size={13} /></button>
          <button onClick={zoomOut} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white"><ZoomOut size={13} /></button>
          <span className="text-[9px] text-[#3a4658] mx-0.5">{t.vertical}</span>
          <button onClick={vZoomIn} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white rotate-90"><ZoomIn size={13} /></button>
          <button onClick={vZoomOut} className="p-1.5 rounded bg-[#131722] text-[#5b6472] hover:text-white rotate-90"><ZoomOut size={13} /></button>
          <button onClick={() => { setDrawMode((d) => !d); pendingPoint.current = null; }} className={`p-1.5 rounded ml-1 ${drawMode ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}><Pencil size={13} /></button>
          <button onClick={() => setDrawings([])} className="p-1.5 rounded bg-[#131722] text-[#5b6472]"><Trash2 size={13} /></button>
        </div>
      </div>
      {drawMode && <div className="px-3 py-1 text-[10px] text-[#e8b339] bg-[#1a1206]">{t.drawHint}</div>}
      {!drawMode && <div className="px-3 py-1 text-[9px] text-[#3a4658]">🖱️ 휠: 좌우 확대 · Shift+휠: 세로 확대</div>}
      {!drawMode && !autoFollow.current && (
        <div className="px-3 py-1 text-[10px] text-[#5b6472] bg-[#0d1117] flex justify-between items-center">
          <span>{t.viewingPast}</span>
          <button onClick={() => { autoFollow.current = true; setViewStart(candles.length - viewCount); }} className="text-[#e8b339] font-semibold">{t.goLatest}</button>
        </div>
      )}

      <div className="border-b border-[#131722]" style={{ height: 400 }}>
        <TradingChart allCandles={candles} entryLines={positions.map((p) => ({ entry: p.entry, liq: p.mode === "isolated" ? calcIsolatedLiqPrice(p) : null }))} drawings={drawings} onAddPoint={handleAddPoint} drawMode={drawMode} viewStart={viewStart} viewCount={viewCount} onPan={handlePan} vZoom={vZoom} onZoomH={(dir) => (dir > 0 ? zoomIn() : zoomOut())} onZoomV={(dir) => (dir > 0 ? vZoomIn() : vZoomOut())} onSetViewCount={setViewCount} tradeMarkers={tradeMarkers} />
      </div>
      <div className="border-b border-[#131722]" style={{ height: 60 }}><VolumePanel allCandles={candles} viewStart={viewStart} viewCount={viewCount} /></div>
      <div className="border-b border-[#131722]" style={{ height: 90 }}><RsiPanel allCandles={candles} viewStart={viewStart} viewCount={viewCount} /></div>

        </>
      )}

      {marketView === "spot" && (
        <div className="pt-2">
      {/* USDOG/USD 페그 차트 — 정보용, 거래 불가 */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold text-[#8b96a5]">{t.pegChartTitle}</span>
        <span className="text-[9px] text-[#3a4658]">{t.pegChartNotice}</span>
      </div>
      <div className="border-b border-[#131722]" style={{ height: 70 }}><PegChart pegHistory={pegHistory} /></div>

      {/* SOG ↔ USDOG 컨버트 */}
      <div className="mx-3 mt-3 rounded-xl border border-[#1a1f2b] p-3">
        <div className="text-[11px] font-semibold text-[#8b96a5] mb-2">{t.convertTitle}</div>
        <div className="flex rounded-lg overflow-hidden border border-[#1a1f2b] mb-2 text-[11px] font-semibold">
          <button
            onClick={() => { setConvertMode("toSog"); setConvertInput(""); setConvertIsMax(false); }}
            className={`flex-1 py-1.5 ${convertMode === "toSog" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
          >
            {t.convertToSog}
          </button>
          <button
            onClick={() => { setConvertMode("toUsdog"); setConvertInput(""); setConvertIsMax(false); }}
            className={`flex-1 py-1.5 ${convertMode === "toUsdog" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
          >
            {t.convertToUsdog}
          </button>
        </div>
        <div className="text-[10px] text-[#5b6472] flex justify-between mb-1.5">
          <span>{t.convertHolding}: {convertMode === "toSog" ? `${balance.toFixed(2)} USDOG` : `${sogHolding.toFixed(4)} SOG`}</span>
          <span>{t.convertPrice} {formatPrice(price)}</span>
        </div>
        <div className="flex gap-2 mb-2">
          <input
            type="number"
            value={convertInput}
            onChange={(e) => handleConvertInputChange(e.target.value)}
            placeholder={convertMode === "toSog" ? t.convertPlaceholderSog : t.convertPlaceholderUsdog}
            className="flex-1 bg-[#131722] border border-[#1a1f2b] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#3a4658]"
          />
          <button
            onClick={handleConvertMax}
            className={`px-3 rounded text-xs font-bold border ${convertIsMax ? "bg-[#e8b339] text-black border-[#e8b339]" : "bg-[#131722] hover:bg-[#1a1f2b] text-[#e8b339] border-[#1a1f2b]"}`}
          >
            MAX
          </button>
        </div>
        {convertIsMax && (
          <div className="text-[9.5px] text-[#3a4658] -mt-1 mb-2">보유 전량이 선택되었습니다 (정확한 수량으로 환전됩니다)</div>
        )}
        {convertAmount > 0 && (
          <div className="text-[10.5px] text-[#8b96a5] mb-2 font-mono">
            {t.convertReceive}: <span className="text-[#e8b339] font-bold">{convertPreview.toFixed(4)} {convertMode === "toSog" ? "SOG" : "USDOG"}</span>
          </div>
        )}
        <button
          onClick={doConvert}
          disabled={convertAmount <= 0 || (convertMode === "toSog" ? convertAmount > balance : convertAmount > sogHolding)}
          className="w-full bg-[#e8b339] hover:bg-[#f0c257] disabled:opacity-30 disabled:cursor-not-allowed text-black font-bold py-2.5 rounded-lg text-sm"
        >
          {t.convertButton}
        </button>
      </div>

        </div>
      )}

      {marketView === "futures" && (
        <>
      {/* Order entry + book */}
      <div className="grid grid-cols-5 gap-0 border-b border-[#131722]">
        <div className="col-span-3 p-3 flex flex-col gap-2.5 border-r border-[#131722]">
          <div className="flex gap-2">
            <select value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="flex-1 bg-[#131722] border border-[#1a1f2b] rounded px-2 py-1.5 text-xs font-mono">
              {[1, 2, 3, 5, 10, 20, 50, 75, 100].map((l) => <option key={l} value={l}>{l}x</option>)}
            </select>
            <div className="flex-1 flex rounded overflow-hidden border border-[#1a1f2b]">
              <button
                onClick={() => setMarginMode("cross")}
                className={`flex-1 text-[11px] font-semibold ${marginMode === "cross" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
              >{t.cross}</button>
              <button
                onClick={() => setMarginMode("isolated")}
                className={`flex-1 text-[11px] font-semibold ${marginMode === "isolated" ? "bg-[#e8b339] text-black" : "bg-[#131722] text-[#5b6472]"}`}
              >{t.isolated}</button>
            </div>
          </div>

          <button
            onClick={() => setHedgeMode((v) => !v)}
            className={`flex items-center justify-between px-2.5 py-1.5 rounded border text-[10.5px] font-semibold ${hedgeMode ? "bg-[#e8b339]/15 border-[#e8b339] text-[#e8b339]" : "bg-[#131722] border-[#1a1f2b] text-[#5b6472]"}`}
          >
            <span>양방향 포지션 (헤지모드)</span>
            <span className={`w-8 h-4 rounded-full relative transition-colors ${hedgeMode ? "bg-[#e8b339]" : "bg-[#3a4658]"}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-black transition-all ${hedgeMode ? "left-4" : "left-0.5"}`} />
            </span>
          </button>

          <div className="text-[11px] text-[#5b6472] flex justify-between">
            <span>{t.available}</span>
            <span className="font-mono text-[#c9d1d9]">{balance.toFixed(2)} USDOG</span>
          </div>

          <input type="number" value={marginInput} onChange={(e) => setMarginInput(e.target.value)} placeholder={t.marginPlaceholder}
            className="w-full bg-[#131722] border border-[#1a1f2b] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#3a4658]" />
          <div className="flex gap-1.5">
            {[0.25, 0.5, 0.75, 1].map((p) => (
              <button key={p} onClick={() => setMarginInput(String(Math.min(marginCap, Math.floor(balance * p))))} className="flex-1 text-[10px] bg-[#131722] hover:bg-[#1a1f2b] rounded py-1">{p * 100}%</button>
            ))}
          </div>

          <div className="text-[10px] text-[#5b6472] flex justify-between font-mono">
            <span>레버리지 {leverage}x 최대 증거금</span>
            <span className={margin > marginCap ? "text-[#f6465d]" : "text-[#8b96a5]"}>{marginCap === Infinity ? "무제한" : `${marginCap} USDOG`}</span>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-1">
            <button
              onClick={() => openPosition("long")}
              disabled={!canOpen("long") || margin <= 0 || margin > balance || margin > marginCap}
              className={`bg-[#f6465d] hover:bg-[#e03350] disabled:opacity-30 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-95 ${clickFx === "long" ? "ring-2 ring-white" : ""}`}
            >
              <TrendingUp size={15} /> {t.long}
            </button>
            <button
              onClick={() => openPosition("short")}
              disabled={!canOpen("short") || margin <= 0 || margin > balance || margin > marginCap}
              className={`bg-[#3b82f6] hover:bg-[#2f6fd6] disabled:opacity-30 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg flex items-center justify-center gap-1.5 transition-all active:scale-95 ${clickFx === "short" ? "ring-2 ring-white" : ""}`}
            >
              <TrendingDown size={15} /> {t.short}
            </button>
          </div>
          {!hedgeMode && positions.length > 0 && (
            <div className="text-[9.5px] text-[#3a4658]">단방향 모드에서는 포지션을 하나만 보유할 수 있어요. 여러 방향을 동시에 잡으려면 위 토글을 켜세요.</div>
          )}
        </div>
        <div className="col-span-2 p-2"><OrderBook price={price} /></div>
      </div>

      <div className="mx-3 mt-2 px-3 py-2 bg-[#131722] rounded text-[10.5px] text-[#8b96a5] flex justify-between items-center">
        <span>{t.warningBanner}</span>
      </div>

      {/* Position PnL cards — one per open position */}
      {positions.map((pos) => {
        const pnlNow = positionPnl(pos, price);
        const pnlPctNow = (pnlNow / pos.margin) * 100;
        const liqP = pos.mode === "isolated" ? calcIsolatedLiqPrice(pos) : null;
        return (
          <div key={pos.id} className="mx-3 mt-3 rounded-xl border border-[#1a1f2b] overflow-hidden">
            <div className={`px-4 py-3 flex items-center justify-between ${pnlNow >= 0 ? "bg-gradient-to-r from-[#1a0a0d] to-[#0d1117]" : "bg-gradient-to-r from-[#0a1220] to-[#0d1117]"}`}>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${pos.side === "long" ? "bg-[#f6465d]/20 text-[#f6465d]" : "bg-[#3b82f6]/20 text-[#3b82f6]"}`}>
                  {pos.side === "long" ? "LONG" : "SHORT"} {pos.leverage}x
                </span>
                <span className="text-[10px] text-[#5b6472]">{pos.mode === "isolated" ? t.isolated : t.cross}</span>
              </div>
              <button onClick={() => closePosition(pos.id)} className="bg-[#1a1f2b] hover:bg-[#232a38] text-[11px] font-semibold px-3 py-1.5 rounded flex items-center gap-1"><X size={11} /> {t.close}</button>
            </div>
            <div className="px-4 py-3 flex items-center justify-between">
              <span className="text-[11px] text-[#5b6472]">{t.pnl}</span>
              <span className={`font-mono font-black text-2xl ${pnlNow >= 0 ? "text-[#f6465d]" : "text-[#3b82f6]"}`}>
                {pnlNow >= 0 ? "+" : ""}{pnlNow.toFixed(2)} <span className="text-sm">USDOG</span>
              </span>
            </div>
            <div className="px-4 pb-3 flex justify-between text-[11px]">
              <span className="text-[#5b6472]">{t.pnlPct}</span>
              <span className={`font-mono font-bold ${pnlPctNow >= 0 ? "text-[#f6465d]" : "text-[#3b82f6]"}`}>{pnlPctNow >= 0 ? "+" : ""}{pnlPctNow.toFixed(1)}%</span>
            </div>
            <div className="px-4 pb-3 flex justify-between text-[11px] font-mono">
              <span className="text-[#5b6472]">{pos.mode === "isolated" ? t.marginLiq : "증거금 / 청산조건"}</span>
              <span>
                {pos.margin.toFixed(2)} USDOG ·{" "}
                {pos.mode === "isolated" ? (
                  <span className="text-[#f6465d]">{formatPrice(liqP)}</span>
                ) : (
                  <span className="text-[#f6465d]">계좌자산 기준 실시간 판정</span>
                )}
              </span>
            </div>
            {pos.mode === "cross" && (
              <div className="px-4 pb-4 pt-1 border-t border-[#1a1f2b] flex gap-2 items-center">
                <input
                  type="number"
                  value={addMarginTargetId === pos.id ? addMarginInput : ""}
                  onChange={(e) => { setAddMarginTargetId(pos.id); setAddMarginInput(e.target.value); }}
                  placeholder={t.addMarginPlaceholder}
                  className="flex-1 bg-[#131722] border border-[#1a1f2b] rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-[#3a4658]"
                />
                <button
                  onClick={() => { setAddMarginTargetId(pos.id); addMargin(); }}
                  disabled={addMarginTargetId !== pos.id || Number(addMarginInput) <= 0 || Number(addMarginInput) > balance}
                  className="bg-[#e8b339] hover:bg-[#f0c257] disabled:opacity-30 disabled:cursor-not-allowed text-black text-xs font-bold px-3 py-1.5 rounded whitespace-nowrap"
                >
                  {t.addMarginButton}
                </button>
              </div>
            )}
            {pos.mode === "isolated" && (
              <div className="px-4 pb-3 text-[9.5px] text-[#3a4658]">{t.isolatedNotice}</div>
            )}
          </div>
        );
      })}

      <div className="flex gap-4 px-3 mt-3 border-b border-[#131722] text-[13px]">
        {["positions", "log"].map((tabKey) => (
          <button key={tabKey} onClick={() => setTab(tabKey)} className={`pb-2 ${tab === tabKey ? "text-white border-b-2 border-[#e8b339] font-semibold" : "text-[#5b6472]"}`}>
            {tabKey === "positions" ? `${t.tabPositions}(${positions.length})` : t.tabLog}
          </button>
        ))}
      </div>

      <div className="p-3">
        {tab === "positions" && positions.length === 0 && <div className="text-center text-[#3a4658] text-xs py-6">{t.noPosition}</div>}
        {tab === "log" && (
          <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
            {log.length === 0 && <div className="text-[#3a4658] text-xs py-4 text-center">{t.noLog}</div>}
            {log.map((l) => (
              <div key={l.id} className={`text-[11px] font-mono ${l.tone === "good" ? "text-[#f6465d]" : l.tone === "bad" ? "text-[#3b82f6]" : "text-[#5b6472]"}`}>{l.msg}</div>
            ))}
          </div>
        )}
      </div>

        </>
      )}

      {showInfo && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50" onClick={() => setShowInfo(false)}>
          <div className="bg-[#0d1117] border border-[#1a1f2b] rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="font-bold text-base mb-3">{t.marketInfoTitle}</div>
            <div className="space-y-3 text-[12px] font-mono">
              <div className="flex justify-between"><span className="text-[#5b6472]">{t.totalSupply}</span><span>100,000,000,000,000 SOG</span></div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">{t.reservePool}</span><span>{USDOG_POOL.toLocaleString()} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${USDOG_POOL.toLocaleString()} USD · ₩{Math.round(USDOG_POOL * KRW_PER_USDOG).toLocaleString()} KRW</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">{t.startPrice}</span><span>{formatPrice(START_PRICE)} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${formatPrice(START_PRICE)} USD · ₩{(START_PRICE * KRW_PER_USDOG).toFixed(4)} KRW</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">{t.currentPrice}</span><span className="text-[#e8b339]">{formatPrice(price)} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${formatPrice(price)} USD · ₩{(price * KRW_PER_USDOG).toFixed(4)} KRW</span>
                </div>
              </div>

              <div>
                <div className="flex justify-between"><span className="text-[#5b6472]">{t.marketCap}</span><span>{(price * SOG_TOTAL_SUPPLY).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDOG</span></div>
                <div className="flex justify-between text-[10px] text-[#5b6472] mt-0.5">
                  <span></span>
                  <span>≈ ${(price * SOG_TOTAL_SUPPLY).toLocaleString(undefined, { maximumFractionDigits: 0 })} USD · ₩{Math.round(price * SOG_TOTAL_SUPPLY * KRW_PER_USDOG).toLocaleString()} KRW</span>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-[#5b6472] mt-4 leading-relaxed">{t.marketInfoNote}</div>
            <button onClick={() => setShowInfo(false)} className="w-full mt-4 bg-[#131722] py-2 rounded text-xs">{t.closeBtn}</button>
          </div>
        </div>
      )}

      {/* 청산 시 조용히 붉은 플래시만 (모달 없음, 공포감 유지) */}
      {flashLiquidation && (
        <div className="fixed inset-0 bg-[#f6465d] opacity-20 pointer-events-none z-40 animate-pulse" />
      )}
    </div>
  );
}
