// -------------------------------------------------------
// PASTE YOUR NEW API KEY ON THE LINE BELOW (between the quotes)
const TWELVE_DATA_API_KEY = "5f1b16a20a6a455aa9623ee2da1d812f";
// -------------------------------------------------------

const BENCHMARK_MAP = {
  "S&P 500":   "SPY",
  "Nasdaq":    "QQQ",
  "MSCI World":"URTH",
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbols, type } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols required" });

  const syms = symbols.split(",").map(s => s.trim()).filter(Boolean);

  try {
    if (type === "quote") {
      const results = await Promise.all(syms.map(async sym => {
        const url = `https://api.twelvedata.com/price?symbol=${sym}&apikey=${TWELVE_DATA_API_KEY}`;
        const r = await fetch(url);
        const d = await r.json();
        return { sym, price: d.price ? parseFloat(d.price) : null };
      }));
      const out = Object.fromEntries(results.map(r => [r.sym, r.price]));
      return res.status(200).json(out);
    }

    if (type === "history") {
      const outputsize = req.query.outputsize || 365;
      const results = await Promise.all(syms.map(async sym => {
        const url = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=${outputsize}&apikey=${TWELVE_DATA_API_KEY}`;
        const r = await fetch(url);
        const d = await r.json();
        if (!d.values) return { sym, data: [] };
        const data = d.values.map(v => ({ date: new Date(v.datetime).getTime(), price: parseFloat(v.close) })).reverse();
        return { sym, data };
      }));
      const out = Object.fromEntries(results.map(r => [r.sym, r.data]));
      return res.status(200).json(out);
    }

    return res.status(400).json({ error: "type must be quote or history" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
