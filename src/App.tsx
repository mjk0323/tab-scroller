import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPdf, renderPage, type PDFDocumentProxy } from './pdf';
import { useAutoScroll } from './useAutoScroll';

const SPEED_MIN = 5;
const SPEED_MAX = 300;
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

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const [speed, setSpeed] = useState(() => load('ts.speed', 40));
  const [zoom, setZoom] = useState(() => load('ts.zoom', 100));
  const [delay, setDelay] = useState(() => load('ts.delay', 3));
  const [invert, setInvert] = useState(() => load('ts.invert', false));

  useEffect(() => save('ts.speed', speed), [speed]);
  useEffect(() => save('ts.zoom', zoom), [zoom]);
  useEffect(() => save('ts.delay', delay), [delay]);
  useEffect(() => save('ts.invert', invert), [invert]);

  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { playing, countdown, toggle, stop } = useAutoScroll(scroller, speed, delay);

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
        setFileName(file.name);
        scroller?.scrollTo({ top: 0 });
      } catch (e) {
        console.error(e);
        setError('PDF를 열지 못했어요. 파일이 손상되었거나 암호가 걸려 있을 수 있어요.');
      }
    },
    [stop, scroller],
  );

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

  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
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

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (doc) toggle();
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSpeed((s) => clamp(s + 5, SPEED_MIN, SPEED_MAX));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSpeed((s) => clamp(s - 5, SPEED_MIN, SPEED_MAX));
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, toggle, stop, scroller]);

  /* ---------- drag & drop ---------- */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    openFile(e.dataTransfer.files[0]);
  };

  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i) : [];

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

        <label className="ctrl check" title="야간 모드 — 악보 색 반전 (I)">
          <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
          <span>반전</span>
        </label>

        {fileName && <div className="filename" title={fileName}>{fileName}</div>}
      </header>

      <main ref={setScroller} className={`scroller ${invert ? 'invert' : ''}`}>
        {!doc && (
          <div className="empty" onClick={() => fileInput.current?.click()}>
            <div className="empty-icon">🎼</div>
            <p className="empty-title">PDF 악보를 여기로 끌어다 놓거나 클릭해서 여세요</p>
            <p className="empty-sub">파일은 서버로 올라가지 않고 브라우저 안에서만 열려요.</p>
            <ul className="keys">
              <li><kbd>Space</kbd> 재생/정지</li>
              <li><kbd>↑</kbd><kbd>↓</kbd> 속도</li>
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
            <canvas
              key={`${fileName}-${i}`}
              className="page"
              ref={(c) => {
                canvases.current[i] = c;
              }}
            />
          ))}
        </div>
        {doc && <div className="tail" />}
      </main>

      {countdown > 0 && <div className="countdown">{countdown}</div>}
      {dragging && <div className="dropzone">여기에 놓으세요</div>}
    </div>
  );
}
