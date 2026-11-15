import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadPdf, renderPage, type PDFDocumentProxy } from './pdf';
import { analyzePage, pickSystemLines, type PageAnalysis } from './analysis';
import { Timeline, type SystemPos } from './timeline';
import { useAutoScroll, type ScrollDriver } from './useAutoScroll';

const SPEED_MIN = 5;
const SPEED_MAX = 300;
const BPM_MIN = 20;
const BPM_MAX = 300;
const READ_LINE = 0.35; // the system being played sits this far down the screen

// quarter notes per measure (BPM is always counted in quarter notes)
const TIME_SIGS: Record<string, number> = {
  '4/4': 4,
  '3/4': 3,
  '2/4': 2,
  '2/2': 4,
  '6/8': 3,
  '12/8': 6,
};

type Mode = 'bpm' | 'manual';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — ignore */
  }
}

interface SystemRef {
  page: number; // 0-based
  staff: number; // index into analyses[page].staves
}

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const [mode, setMode] = useState<Mode>(() => load('ts.mode', 'bpm'));
  const [speed, setSpeed] = useState(() => load('ts.speed', 40));
  const [bpm, setBpm] = useState(() => load('ts.bpm', 90));
  const [timeSig, setTimeSig] = useState(() => load('ts.timeSig', '4/4'));
  const [zoom, setZoom] = useState(() => load('ts.zoom', 100));
  const [delay, setDelay] = useState(() => load('ts.delay', 3));
  const [invert, setInvert] = useState(() => load('ts.invert', false));
  const [showAnalysis, setShowAnalysis] = useState(() => load('ts.showAnalysis', true));

  useEffect(() => save('ts.mode', mode), [mode]);
  useEffect(() => save('ts.speed', speed), [speed]);
  useEffect(() => save('ts.bpm', bpm), [bpm]);
  useEffect(() => save('ts.timeSig', timeSig), [timeSig]);
  useEffect(() => save('ts.zoom', zoom), [zoom]);
  useEffect(() => save('ts.delay', delay), [delay]);
  useEffect(() => save('ts.invert', invert), [invert]);
  useEffect(() => save('ts.showAnalysis', showAnalysis), [showAnalysis]);

  const [analyses, setAnalyses] = useState<PageAnalysis[] | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [currentSys, setCurrentSys] = useState(-1);

  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const wraps = useRef<(HTMLDivElement | null)[]>([]);

  /* ---------- systems (lines of music that drive the timing) ---------- */
  const systems = useMemo<SystemRef[]>(() => {
    if (!analyses) return [];
    const want = pickSystemLines(analyses);
    const out: SystemRef[] = [];
    analyses.forEach((pa, page) =>
      pa.staves.forEach((s, staff) => {
        if (s.lines === want) out.push({ page, staff });
      }),
    );
    return out;
  }, [analyses]);

  const bpmReady = systems.length > 0;
  const effectiveMode: Mode = mode === 'bpm' && bpmReady ? 'bpm' : 'manual';
  const totalMeasures = systems.reduce((n, r) => n + analyses![r.page].staves[r.staff].measures, 0);

  /* ---------- scroll driver (reads latest values through refs) ---------- */
  const live = useRef({ effectiveMode, speed, bpm, timeSig, systems, analyses, scroller });
  live.current = { effectiveMode, speed, bpm, timeSig, systems, analyses, scroller };

  const buildTimeline = useCallback((): Timeline => {
    const { systems, analyses } = live.current;
    const pos: SystemPos[] = [];
    for (const r of systems) {
      const w = wraps.current[r.page];
      if (!w || !analyses) continue;
      const s = analyses[r.page].staves[r.staff];
      const h = w.clientHeight;
      pos.push({ y: w.offsetTop + s.top * h, height: (s.bottom - s.top) * h, measures: s.measures });
    }
    return new Timeline(pos);
  }, []);

  const driverRef = useRef<ScrollDriver>(null!);
  if (!driverRef.current) {
    let manualPos = 0;
    let p = 0; // position in measures
    let lastSys = -1;
    driverRef.current = {
      sync(top) {
        manualPos = top;
        const sc = live.current.scroller;
        if (!sc) return;
        const tl = buildTimeline();
        const lead = sc.clientHeight * READ_LINE;
        // At (or above) the spot where the first line reaches the reading line,
        // start from measure 1 — e.g. when the page is scrolled to the very top.
        p = top <= Math.max(0, tl.yAt(0) - lead) + 3 ? 0 : tl.pAt(top + lead);
      },
      advance(dt, max) {
        const L = live.current;
        if (L.effectiveMode === 'manual') {
          manualPos += L.speed * dt;
          if (manualPos >= max) return null;
          return manualPos;
        }
        const tl = buildTimeline();
        const quarters = TIME_SIGS[L.timeSig] ?? 4;
        p += (dt * L.bpm) / 60 / quarters;
        if (p >= tl.total) {
          lastSys = -1;
          setCurrentSys(-1);
          return null;
        }
        const sys = tl.systemAt(p);
        if (sys !== lastSys) {
          lastSys = sys;
          setCurrentSys(sys);
        }
        return tl.yAt(p) - (L.scroller?.clientHeight ?? 0) * READ_LINE;
      },
    };
  }

  const { playing, countdown, toggle, stop } = useAutoScroll(scroller, driverRef, delay);
  useEffect(() => {
    if (!playing) setCurrentSys(-1);
  }, [playing]);

  /* ---------- open file ---------- */
  const openFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        setError('PDF 파일만 열 수 있어요.');
        return;
      }
      stop();
      setError('');
      try {
        const d = await loadPdf(file);
        setDoc((prev) => {
          prev?.destroy();
          return d;
        });
        setAnalyses(null);
        setFileName(file.name);
        scroller?.scrollTo({ top: 0 });
      } catch (e) {
        console.error(e);
        setError('PDF를 열지 못했어요. 파일이 손상되었거나 암호가 걸려 있을 수 있어요.');
      }
    },
    [stop, scroller],
  );

  /* ---------- analysis (once per document) ---------- */
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    setAnalyzing(true);
    (async () => {
      const out: PageAnalysis[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        try {
          out.push(await analyzePage(doc, i));
        } catch (e) {
          console.warn('analysis failed on page', i, e);
          out.push({ staves: [] });
        }
        if (cancelled) return;
      }
      setAnalyses(out);
      setAnalyzing(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const adjustMeasures = (r: SystemRef, delta: number) => {
    setAnalyses((prev) =>
      prev
        ? prev.map((pa, pi) =>
            pi !== r.page
              ? pa
              : {
                  staves: pa.staves.map((s, si) =>
                    si === r.staff ? { ...s, measures: clamp(s.measures + delta, 1, 32) } : s,
                  ),
                },
          )
        : prev,
    );
  };

  /* ---------- page rendering ---------- */
  const [pageWidth, setPageWidth] = useState(0);
  useEffect(() => {
    if (!scroller) return;
    const update = () => {
      const avail = scroller.clientWidth - 32;
      setPageWidth(Math.max(200, Math.round(Math.min(avail, 1000) * (zoom / 100))));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scroller, zoom]);

  useEffect(() => {
    if (!doc || !pageWidth) return;
    const signal = { cancelled: false };
    const t = window.setTimeout(async () => {
      // keep the same relative scroll position across re-renders (zoom/resize)
      const ratio = scroller && scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
      for (let i = 1; i <= doc.numPages; i++) {
        const c = canvases.current[i - 1];
        if (c) await renderPage(doc, i, c, pageWidth, signal);
        if (signal.cancelled) return;
      }
      if (scroller) scroller.scrollTop = ratio * scroller.scrollHeight;
    }, 120);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(t);
    };
  }, [doc, pageWidth, scroller]);

  /* ---------- tap tempo ---------- */
  const taps = useRef<number[]>([]);
  const tap = useCallback(() => {
    const now = performance.now();
    const t = taps.current;
    if (t.length && now - t[t.length - 1] > 2000) t.length = 0;
    t.push(now);
    if (t.length > 6) t.shift();
    if (t.length >= 2) {
      const avg = (t[t.length - 1] - t[0]) / (t.length - 1);
      setBpm(clamp(Math.round(60000 / avg), BPM_MIN, BPM_MAX));
      setMode('bpm');
    }
  }, []);

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const bump = (d: number) =>
        effectiveMode === 'bpm'
          ? setBpm((b) => clamp(b + d, BPM_MIN, BPM_MAX))
          : setSpeed((s) => clamp(s + d * 2.5, SPEED_MIN, SPEED_MAX));
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (doc) toggle();
          break;
        case 'ArrowUp':
          e.preventDefault();
          bump(2);
          break;
        case 'ArrowDown':
          e.preventDefault();
          bump(-2);
          break;
        case 'Home':
          e.preventDefault();
          stop();
          scroller?.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'f':
        case 'F':
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen?.();
          break;
        case 'i':
        case 'I':
          setInvert((v) => !v);
          break;
        case 'o':
        case 'O':
          fileInput.current?.click();
          break;
        case 't':
        case 'T':
          tap();
          break;
        case 'm':
        case 'M':
          setMode((m) => (m === 'bpm' ? 'manual' : 'bpm'));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, toggle, stop, scroller, tap, effectiveMode]);

  /* ---------- drag & drop ---------- */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    openFile(e.dataTransfer.files[0]);
  };

  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i) : [];

  let status = '';
  if (doc) {
    if (analyzing) status = '악보 분석 중…';
    else if (bpmReady) {
      const secs = (totalMeasures * (TIME_SIGS[timeSig] ?? 4) * 60) / bpm;
      const mm = Math.floor(secs / 60);
      const ss = String(Math.round(secs % 60)).padStart(2, '0');
      status = `${systems.length}줄 · ${totalMeasures}마디 · 약 ${mm}:${ss}`;
    } else if (analyses) status = '줄을 찾지 못해 수동 속도로 스크롤해요';
  }

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="toolbar">
        <div className="brand">🎸 Tab Scroller</div>

        <button className="btn" onClick={() => fileInput.current?.click()} title="PDF 열기 (O)">
          📂 열기
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            openFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <button
          className={`btn primary ${playing ? 'active' : ''}`}
          onClick={toggle}
          disabled={!doc}
          title="재생 / 정지 (Space)"
        >
          {playing ? '⏸ 정지' : countdown > 0 ? `취소 (${countdown})` : '▶ 재생'}
        </button>

        <div className="seg" role="group" title="스크롤 방식 (M)">
          <button
            className={effectiveMode === 'bpm' ? 'on' : ''}
            onClick={() => setMode('bpm')}
            disabled={!!analyses && !bpmReady}
          >
            BPM
          </button>
          <button className={effectiveMode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>
            수동
          </button>
        </div>

        {effectiveMode === 'bpm' ? (
          <>
            <label className="ctrl" title="템포 (↑ / ↓)">
              <span>BPM</span>
              <button className="btn small" onClick={() => setBpm((b) => clamp(b - 1, BPM_MIN, BPM_MAX))}>
                −
              </button>
              <input
                className="num"
                type="number"
                min={BPM_MIN}
                max={BPM_MAX}
                value={bpm}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) setBpm(clamp(Math.round(v), BPM_MIN, BPM_MAX));
                }}
              />
              <button className="btn small" onClick={() => setBpm((b) => clamp(b + 1, BPM_MIN, BPM_MAX))}>
                +
              </button>
            </label>
            <button className="btn" onClick={tap} title="박자에 맞춰 여러 번 누르면 BPM을 맞춰요 (T)">
              👆 탭
            </button>
            <label className="ctrl" title="박자 — BPM은 4분음표 기준">
              <span>박자</span>
              <select value={timeSig} onChange={(e) => setTimeSig(e.target.value)}>
                {Object.keys(TIME_SIGS).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="ctrl" title="스크롤 속도 (↑ / ↓)">
            <span>속도</span>
            <button className="btn small" onClick={() => setSpeed((s) => clamp(s - 5, SPEED_MIN, SPEED_MAX))}>
              −
            </button>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
            <button className="btn small" onClick={() => setSpeed((s) => clamp(s + 5, SPEED_MIN, SPEED_MAX))}>
              +
            </button>
            <output>{speed}</output>
          </label>
        )}

        <details className="more">
          <summary className="btn">⚙ 설정</summary>
          <div className="more-panel">
            <label className="ctrl" title="악보 크기">
              <span>크기</span>
              <input type="range" min={50} max={200} step={10} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
              <output>{zoom}%</output>
            </label>
            <label className="ctrl" title="재생 전 카운트다운">
              <span>준비</span>
              <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
                <option value={0}>바로</option>
                <option value={3}>3초</option>
                <option value={5}>5초</option>
                <option value={10}>10초</option>
              </select>
            </label>
            <label className="ctrl check" title="검출한 줄과 마디 수 표시">
              <input type="checkbox" checked={showAnalysis} onChange={(e) => setShowAnalysis(e.target.checked)} />
              <span>분석 표시</span>
            </label>
            <label className="ctrl check" title="야간 모드 — 악보 색 반전 (I)">
              <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
              <span>색 반전</span>
            </label>
          </div>
        </details>

        <div className="status" title={fileName}>
          {status && <span>{status}</span>}
          {fileName && <span className="filename">{fileName}</span>}
        </div>
      </header>

      <main ref={setScroller} className={`scroller ${invert ? 'invert' : ''}`}>
        {!doc && (
          <div className="empty" onClick={() => fileInput.current?.click()}>
            <div className="empty-icon">🎼</div>
            <p className="empty-title">PDF 악보를 여기로 끌어다 놓거나 클릭해서 여세요</p>
            <p className="empty-sub">파일은 서버로 올라가지 않고 브라우저 안에서만 열려요.</p>
            <ul className="keys">
              <li><kbd>Space</kbd> 재생/정지</li>
              <li><kbd>↑</kbd><kbd>↓</kbd> BPM·속도</li>
              <li><kbd>T</kbd> 탭 템포</li>
              <li><kbd>M</kbd> BPM/수동</li>
              <li><kbd>Home</kbd> 처음으로</li>
              <li><kbd>F</kbd> 전체화면</li>
              <li><kbd>I</kbd> 색 반전</li>
              <li><kbd>O</kbd> 파일 열기</li>
            </ul>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="pages">
          {pages.map((i) => (
            <div
              key={`${fileName}-${i}`}
              className="page-wrap"
              ref={(w) => {
                wraps.current[i] = w;
              }}
            >
              <canvas
                className="page"
                ref={(c) => {
                  canvases.current[i] = c;
                }}
              />
              {effectiveMode === 'bpm' &&
                systems.map((r, si) => {
                  if (r.page !== i) return null;
                  const s = analyses![r.page].staves[r.staff];
                  const active = si === currentSys;
                  if (!showAnalysis && !active) return null;
                  const pad = (s.bottom - s.top) * 0.5;
                  return (
                    <div
                      key={si}
                      className={`sys ${active ? 'active' : ''} ${showAnalysis ? 'debug' : ''}`}
                      style={{
                        top: `${(s.top - pad) * 100}%`,
                        height: `${(s.bottom - s.top + pad * 2) * 100}%`,
                        left: `${s.left * 100}%`,
                        width: `${(s.right - s.left) * 100}%`,
                      }}
                    >
                      {showAnalysis &&
                        s.bars.map((b, bi) => (
                          <span key={bi} className="bar" style={{ left: `${((b - s.left) / (s.right - s.left)) * 100}%` }} />
                        ))}
                      {showAnalysis && (
                        <span className="badge" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => adjustMeasures(r, -1)} title="마디 수 줄이기">−</button>
                          {s.measures}마디
                          <button onClick={() => adjustMeasures(r, 1)} title="마디 수 늘리기">+</button>
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
        {doc && <div className="tail" />}
      </main>

      {countdown > 0 && <div className="countdown">{countdown}</div>}
      {dragging && <div className="dropzone">여기에 놓으세요</div>}
    </div>
  );
}
