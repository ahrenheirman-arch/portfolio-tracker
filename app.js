const { useState, useEffect, useMemo, useCallback, useRef } = React;

const BENCHMARKS = { "S&P 500": "SPY", "Nasdaq": "QQQ", "MSCI World": "URTH" };
const PERIODS = ["1W","1M","6M","1Y","All"];
const PERIOD_DAYS = { "1W":7, "1M":30, "6M":180, "1Y":365, "All":99999 };
const COLORS = { portfolio:"#4f7fdb", "S&P 500":"#e07b39", "Nasdaq":"#8b5cf6", "MSCI World":"#16a34a" };

const SAMPLE_TXNS = [
  { id:1, ticker:"AAPL", date:"2023-01-15", shares:10, price:135.94, type:"buy" },
  { id:2, ticker:"MSFT", date:"2023-03-10", shares:5,  price:276.20, type:"buy" },
  { id:3, ticker:"AAPL", date:"2024-06-01", shares:3,  price:192.35, type:"sell"},
  { id:4, ticker:"NVDA", date:"2024-09-01", shares:4,  price:116.78, type:"buy" },
];

function xirr(cashflows) {
  if (cashflows.length < 2) return null;
  const sorted = [...cashflows].sort((a,b) => a.date - b.date);
  const t0 = sorted[0].date;
  const flows = sorted.map(cf => ({ amount: cf.amount, t: (cf.date - t0) / (365*24*3600*1000) }));
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    let f = 0, df = 0;
    for (const { amount, t } of flows) {
      const v = Math.pow(1+r, t);
      f += amount / v;
      df += -t * amount / (v * (1+r));
    }
    if (Math.abs(df) < 1e-12) break;
    const nr = r - f/df;
    if (Math.abs(nr - r) < 1e-8) { r = nr; break; }
    r = nr;
  }
  return isFinite(r) ? r : null;
}

const fmtCcy = (n, d=2) => n == null ? "—" : new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:d,maximumFractionDigits:d}).format(n);
const fmtPct = (n, d=2) => n == null ? "—" : (n>=0?"+":"")+n.toFixed(d)+"%";

async function apiFetch(type, symbols, outputsize) {
  const syms = symbols.join(",");
  const qs = outputsize ? `&outputsize=${outputsize}` : "";
  const r = await fetch(`/api/prices?type=${type}&symbols=${encodeURIComponent(syms)}${qs}`);
  return r.json();
}

function useLocalStorage(key, def) {
  const [val, setVal] = useState(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : def; } catch { return def; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }, [key, val]);
  return [val, setVal];
}

export default function App() {
  const [txns, setTxns] = useLocalStorage("inv_txns_v2", SAMPLE_TXNS);
  const [tab, setTab] = useState("dashboard");
  const [period, setPeriod] = useState("1Y");
  const [prices, setPrices] = useState({});
  const [history, setHistory] = useState({});
  const [loading, setLoading] = useState(false);
  const [activeBench, setActiveBench] = useState(["S&P 500"]);
  const [form, setForm] = useState({ ticker:"", date:"", shares:"", price:"", type:"buy" });
  const [nextId, setNextId] = useState(200);
  const [csvErr, setCsvErr] = useState("");

  const tickers = useMemo(() => [...new Set(txns.map(t=>t.ticker))], [txns]);

  const loadPrices = useCallback(async () => {
    if (!tickers.length) return;
    setLoading(true);
    try {
      const allSyms = [...tickers, ...Object.values(BENCHMARKS)];
      const outputsize = PERIOD_DAYS[period] > 365 ? 730 : PERIOD_DAYS[period] + 10;
      const [quotes, hist] = await Promise.all([
        apiFetch("quote", allSyms),
        apiFetch("history", allSyms, outputsize),
      ]);
      setPrices(quotes);
      setHistory(hist);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, [tickers, period]);

  useEffect(() => { loadPrices(); }, [loadPrices]);

  const holdings = useMemo(() => {
    const map = {};
    for (const t of txns) {
      if (!map[t.ticker]) map[t.ticker] = { shares:0, cost:0, cashOut:0 };
      if (t.type==="buy") { map[t.ticker].shares += +t.shares; map[t.ticker].cost += +t.shares * +t.price; }
      else { map[t.ticker].shares -= +t.shares; map[t.ticker].cashOut += +t.shares * +t.price; }
    }
    return Object.entries(map).map(([ticker,h]) => {
      const cur = prices[ticker];
      const value = cur ? h.shares * cur : null;
      const gain = value != null ? value + h.cashOut - h.cost : null;
      const pct = h.cost > 0 && gain != null ? (gain/h.cost)*100 : null;
      return { ticker, ...h, currentPrice: cur, value, gain, pct };
    }).filter(h => h.shares > 0.0001);
  }, [txns, prices]);

  const totalValue = useMemo(() => holdings.reduce((s,h)=>s+(h.value||0),0), [holdings]);
  const totalCost   = useMemo(() => holdings.reduce((s,h)=>s+h.cost,0), [holdings]);
  const totalGain   = totalValue - totalCost;

  const irr = useMemo(() => {
    const flows = txns.map(t => ({ date: new Date(t.date), amount: t.type==="buy" ? -(+t.shares*+t.price) : +(+t.shares*+t.price) }));
    if (totalValue > 0) flows.push({ date: new Date(), amount: totalValue });
    return flows.length >= 2 ? xirr(flows) : null;
  }, [txns, totalValue]);

  const portfolioHistory = useMemo(() => {
    if (!Object.keys(history).length || !txns.length) return [];
    const days = PERIOD_DAYS[period];
    const cutoff = Date.now() - days * 86400000;
    const allDates = new Set();
    for (const sym of tickers) { if (history[sym]) history[sym].forEach(p=>allDates.add(p.date)); }
    return [...allDates].filter(d=>d>=cutoff).sort().map(date => {
      let val = 0;
      for (const { ticker } of holdings) {
        const hist = history[ticker];
        if (!hist) continue;
        const pt = [...hist].reverse().find(p=>p.date<=date);
        if (!pt) continue;
        const shares = txns.filter(t=>new Date(t.date).getTime()<=date && t.ticker===ticker)
          .reduce((s,t)=>s+(t.type==="buy"?+t.shares:-+t.shares),0);
        val += shares * pt.price;
      }
      return { date, value: val };
    });
  }, [history, txns, holdings, period, tickers]);

  const benchHistory = useMemo(() => {
    const out = {};
    if (!portfolioHistory.length) return out;
    const portBase = portfolioHistory[0]?.value || 1;
    for (const name of activeBench) {
      const sym = BENCHMARKS[name];
      if (!history[sym]) continue;
      const days = PERIOD_DAYS[period];
      const cutoff = Date.now() - days*86400000;
      const data = history[sym].filter(p=>p.date>=cutoff);
      if (!data.length) continue;
      const base = data[0].price;
      out[name] = data.map(p=>({ date:p.date, value: portBase*(p.price/base) }));
    }
    return out;
  }, [history, activeBench, period, portfolioHistory]);

  const portReturn = portfolioHistory.length>=2
    ? ((portfolioHistory[portfolioHistory.length-1].value - portfolioHistory[0].value)/portfolioHistory[0].value)*100
    : null;

  const addTxn = () => {
    if (!form.ticker||!form.date||!form.shares||!form.price) return;
    setTxns(prev=>[...prev,{ id:nextId, ...form, ticker:form.ticker.toUpperCase(), shares:+form.shares, price:+form.price }]);
    setNextId(n=>n+1);
    setForm({ ticker:"", date:"", shares:"", price:"", type:"buy" });
  };

  const handleCSV = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const lines = ev.target.result.split("\n").filter(l=>l.trim());
        const headers = lines[0].split(",").map(h=>h.trim().toLowerCase());
        if (!["ticker","date","shares","price","type"].every(h=>headers.includes(h))) { setCsvErr("CSV must have: ticker, date, shares, price, type"); return; }
        const newTxns = lines.slice(1).map((l,i) => {
          const vals = l.split(",").map(v=>v.trim());
          const obj = Object.fromEntries(headers.map((h,j)=>[h,vals[j]]));
          return { id:nextId+i, ticker:obj.ticker.toUpperCase(), date:obj.date, shares:+obj.shares, price:+obj.price, type:obj.type.toLowerCase() };
        });
        setTxns(prev=>[...prev,...newTxns]);
        setNextId(n=>n+newTxns.length);
        setCsvErr("");
      } catch { setCsvErr("Failed to parse CSV."); }
    };
    reader.readAsText(file);
    e.target.value="";
  };

  const Tab = ({label,k}) => <button className={`tab${tab===k?" active":""}`} onClick={()=>setTab(k)}>{label}</button>;
  const PeriodBtn = ({p}) => <button className={`period-btn${period===p?" active":""}`} onClick={()=>setPeriod(p)}>{p}</button>;

  return (
    <div>
      <div className="top-bar">
        <div>
          <h1>Portfolio tracker</h1>
          <p style={{fontSize:13,color:"var(--text2)",marginTop:2}}>IRR &amp; benchmark comparison</p>
        </div>
        <button className="refresh-btn" onClick={loadPrices} disabled={loading}>{loading?"Refreshing…":"Refresh prices"}</button>
      </div>

      <div className="tabs">
        <Tab label="Dashboard" k="dashboard"/>
        <Tab label="Transactions" k="txns"/>
        <Tab label="Analysis" k="analysis"/>
      </div>

      {tab==="dashboard" && <>
        <div className="metric-grid">
          {[
            ["Portfolio value", fmtCcy(totalValue), null],
            ["Total gain/loss", fmtCcy(totalGain), totalGain>=0?"success":"danger"],
            ["Return (cost basis)", totalCost>0?fmtPct((totalGain/totalCost)*100):"—", totalGain>=0?"success":"danger"],
            ["IRR (annualised)", irr!=null?fmtPct(irr*100):"—", irr!=null&&irr>=0?"success":"danger"],
          ].map(([label,val,cls])=>(
            <div className="metric" key={label}>
              <div className="metric-label">{label}</div>
              <div className={`metric-value${cls?" "+cls:""}`}>{val}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="chart-controls">
            <h2 style={{margin:0}}>Performance</h2>
            <div className="periods">{PERIODS.map(p=><PeriodBtn key={p} p={p}/>)}</div>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
            {Object.keys(BENCHMARKS).map(b=>(
              <button key={b} className="bench-btn"
                onClick={()=>setActiveBench(prev=>prev.includes(b)?prev.filter(x=>x!==b):[...prev,b])}
                style={{ border:`1px solid ${COLORS[b]}`, background:activeBench.includes(b)?COLORS[b]:"transparent", color:activeBench.includes(b)?"#fff":COLORS[b] }}>
                {b}
              </button>
            ))}
          </div>
          <PerfChart portfolioHistory={portfolioHistory} benchHistory={benchHistory} activeBench={activeBench} portReturn={portReturn} />
        </div>

        <div className="card">
          <h2>Holdings</h2>
          {holdings.length===0 ? <p className="empty">No holdings yet. Add transactions to get started.</p> : (
            <div style={{overflowX:"auto"}}>
              <table>
                <thead><tr><th style={{textAlign:"left"}}>Ticker</th><th>Shares</th><th>Avg cost</th><th>Current</th><th>Value</th><th>Gain/Loss</th><th>Return</th></tr></thead>
                <tbody>{holdings.map(h=>(
                  <tr key={h.ticker}>
                    <td style={{fontWeight:500}}>{h.ticker}</td>
                    <td>{(+h.shares).toFixed(4)}</td>
                    <td>{fmtCcy(h.cost/h.shares)}</td>
                    <td>{h.currentPrice?fmtCcy(h.currentPrice):"—"}</td>
                    <td>{h.value?fmtCcy(h.value):"—"}</td>
                    <td className={h.gain>=0?"success":"danger"}>{h.gain!=null?fmtCcy(h.gain):"—"}</td>
                    <td className={h.pct>=0?"success":"danger"}>{h.pct!=null?fmtPct(h.pct):"—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </>}

      {tab==="txns" && <>
        <div className="card">
          <h2>Add transaction</h2>
          <div className="form-grid">
            <input placeholder="Ticker (e.g. AAPL)" value={form.ticker} onChange={e=>setForm(f=>({...f,ticker:e.target.value.toUpperCase()}))} />
            <input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
            <input type="number" placeholder="Shares" value={form.shares} onChange={e=>setForm(f=>({...f,shares:e.target.value}))} />
            <input type="number" placeholder="Price per share" value={form.price} onChange={e=>setForm(f=>({...f,price:e.target.value}))} />
            <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </div>
          <button className="primary" onClick={addTxn}>Add transaction</button>
        </div>

        <div className="card">
          <h2>Import CSV</h2>
          <p className="info-text" style={{marginBottom:8}}>CSV must have columns: <code>ticker, date, shares, price, type</code></p>
          <input type="file" accept=".csv" onChange={handleCSV} />
          {csvErr && <p className="csv-error">{csvErr}</p>}
        </div>

        <div className="card">
          <h2>Transaction history</h2>
          <div style={{overflowX:"auto"}}>
            <table>
              <thead><tr><th style={{textAlign:"left"}}>Date</th><th style={{textAlign:"left"}}>Ticker</th><th style={{textAlign:"left"}}>Type</th><th>Shares</th><th>Price</th><th>Total</th><th></th></tr></thead>
              <tbody>{[...txns].sort((a,b)=>b.date.localeCompare(a.date)).map(t=>(
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td style={{fontWeight:500}}>{t.ticker}</td>
                  <td className={t.type==="buy"?"success":"danger"}>{t.type}</td>
                  <td style={{textAlign:"right"}}>{(+t.shares).toFixed(4)}</td>
                  <td style={{textAlign:"right"}}>{fmtCcy(+t.price)}</td>
                  <td style={{textAlign:"right"}}>{fmtCcy(+t.shares * +t.price)}</td>
                  <td style={{textAlign:"center"}}><button className="delete-btn" onClick={()=>setTxns(prev=>prev.filter(x=>x.id!==t.id))}>✕</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      </>}

      {tab==="analysis" && <>
        <div className="metric-grid">
          {[
            ["IRR (annualised)", irr!=null?fmtPct(irr*100):"Insufficient data", irr!=null&&irr>=0?"success":"danger"],
            ["Total invested", fmtCcy(txns.filter(t=>t.type==="buy").reduce((s,t)=>s+(+t.shares*+t.price),0)), null],
            ["Total sold", fmtCcy(txns.filter(t=>t.type==="sell").reduce((s,t)=>s+(+t.shares*+t.price),0)), null],
            ["Current value", fmtCcy(totalValue), null],
          ].map(([label,val,cls])=>(
            <div className="metric" key={label}>
              <div className="metric-label">{label}</div>
              <div className={`metric-value${cls?" "+cls:""}`}>{val}</div>
            </div>
          ))}
        </div>

        <div className="card">
          <h2>What is IRR?</h2>
          <p className="info-text">The Internal Rate of Return is the annualised return that makes the net present value of all your cash flows equal to zero. Unlike simple return, it accounts for <em>when</em> you invested — putting money in at a low point is worth more. Your IRR can be compared directly to benchmark returns to evaluate real performance.</p>
        </div>

        <div className="card">
          <h2>Per-holding IRR</h2>
          <div style={{overflowX:"auto"}}>
            <table>
              <thead><tr><th style={{textAlign:"left"}}>Ticker</th><th>Invested</th><th>Current value</th><th>IRR</th></tr></thead>
              <tbody>{tickers.map(ticker=>{
                const tTxns = txns.filter(t=>t.ticker===ticker);
                const hld = holdings.find(h=>h.ticker===ticker);
                const flows = tTxns.map(t=>({ date:new Date(t.date), amount:t.type==="buy"?-(+t.shares*+t.price):(+t.shares*+t.price) }));
                if (hld?.value) flows.push({ date:new Date(), amount:hld.value });
                const r = flows.length>=2?xirr(flows):null;
                const invested = tTxns.filter(t=>t.type==="buy").reduce((s,t)=>s+(+t.shares*+t.price),0);
                return (
                  <tr key={ticker}>
                    <td style={{fontWeight:500}}>{ticker}</td>
                    <td style={{textAlign:"right"}}>{fmtCcy(invested)}</td>
                    <td style={{textAlign:"right"}}>{hld?.value?fmtCcy(hld.value):"—"}</td>
                    <td style={{textAlign:"right"}} className={r!=null&&r>=0?"success":"danger"}>{r!=null?fmtPct(r*100):"—"}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      </>}
    </div>
  );
}

function PerfChart({ portfolioHistory, benchHistory, activeBench, portReturn }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !portfolioHistory.length) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }

    const allDates = new Set(portfolioHistory.map(p=>p.date));
    for (const pts of Object.values(benchHistory)) pts.forEach(p=>allDates.add(p.date));
    const sorted = [...allDates].sort();

    const portMap = Object.fromEntries(portfolioHistory.map(p=>[p.date,p.value]));
    const benchMaps = Object.fromEntries(Object.entries(benchHistory).map(([n,pts])=>[n,Object.fromEntries(pts.map(p=>[p.date,p.value]))]));

    const every = Math.max(1, Math.floor(sorted.length/8));
    const labels = sorted.map((d,i) => {
      if (i%every!==0) return "";
      const dt = new Date(d);
      return dt.toLocaleDateString("en-US",{month:"short",day:"numeric"});
    });

    const datasets = [
      { label:"Portfolio", data:sorted.map(d=>portMap[d]||null), borderColor:COLORS.portfolio, backgroundColor:"transparent", borderWidth:2, fill:false, tension:0.3, pointRadius:0, spanGaps:true },
      ...activeBench.map(name=>({ label:name, data:sorted.map(d=>benchMaps[name]?.[d]||null), borderColor:COLORS[name], backgroundColor:"transparent", borderWidth:1.5, borderDash:[4,3], fill:false, tension:0.3, pointRadius:0, spanGaps:true }))
    ];

    chartRef.current = new Chart(canvasRef.current, {
      type:"line",
      data:{ labels, datasets },
      options:{
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:"index", intersect:false },
        plugins:{
          legend:{ display:false },
          tooltip:{ callbacks:{ label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y!=null?fmtCcy(ctx.parsed.y):""}` } }
        },
        scales:{
          x:{ ticks:{ maxRotation:0, color:"#888", font:{size:11} }, grid:{ display:false } },
          y:{ ticks:{ color:"#888", font:{size:11}, callback:v=>fmtCcy(v,0) }, grid:{ color:"rgba(128,128,128,0.1)" } }
        }
      }
    });
  }, [portfolioHistory, benchHistory, activeBench]);

  if (!portfolioHistory.length) return (
    <div style={{height:220,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--text2)",fontSize:13}}>
      Loading chart data…
    </div>
  );

  return (
    <div>
      <div className="legend">
        <span className="legend-item"><span className="legend-dot" style={{background:COLORS.portfolio}}></span>Portfolio {portReturn!=null?fmtPct(portReturn):""}</span>
        {activeBench.map(b=><span key={b} className="legend-item"><span className="legend-dash" style={{background:COLORS[b]}}></span>{b}</span>)}
      </div>
      <div style={{position:"relative",height:240}}>
        <canvas ref={canvasRef} role="img" aria-label="Portfolio performance chart"></canvas>
      </div>
    </div>
  );
}
