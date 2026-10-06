"use client";

import { useEffect, useMemo, useState } from "react";

export interface EndpointInfo {
  slug: string;
  title: string;
  summary: string;
  usesAI: boolean;
  services: string[];
  example: string;
  disclaimer?: string;
}

type Provider = "mock" | "server" | "anthropic" | "openai" | "gemini";

export default function Playground({ endpoints }: { endpoints: EndpointInfo[] }) {
  const [slug, setSlug] = useState(endpoints[0].slug);
  const current = endpoints.find((e) => e.slug === slug)!;
  const [bodies, setBodies] = useState<Record<string, string>>(() => Object.fromEntries(endpoints.map((e) => [e.slug, e.example])));
  const [provider, setProvider] = useState<Provider>("mock");
  const [key, setKey] = useState("");
  const [result, setResult] = useState<{ status: number; ms: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("https://your-app.vercel.app");
  useEffect(() => setOrigin(window.location.origin), []);

  const headers = useMemo(() => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (current.usesAI && provider !== "server") h["x-ai-provider"] = provider;
    if (current.usesAI && provider !== "server" && provider !== "mock" && key) h["x-ai-key"] = key;
    return h;
  }, [current.usesAI, provider, key]);

  const curl = useMemo(() => {
    const hs = Object.entries(headers)
      .map(([k, v]) => `  -H '${k}: ${k === "x-ai-key" ? "$AI_KEY" : v}'`)
      .join(" \\\n");
    let compact = bodies[slug];
    try {
      compact = JSON.stringify(JSON.parse(bodies[slug]));
    } catch {}
    return `curl -X POST ${origin}/api/v1/${slug} \\\n${hs} \\\n  -d '${compact.replace(/'/g, "'\\''")}'`;
  }, [headers, bodies, slug, origin]);

  async function send() {
    setBusy(true);
    setResult(null);
    const t = performance.now();
    try {
      const res = await fetch(`/api/v1/${slug}`, { method: "POST", headers, body: bodies[slug] });
      setResult({ status: res.status, ms: Math.round(performance.now() - t), text: JSON.stringify(await res.json(), null, 2) });
    } catch (e) {
      setResult({ status: 0, ms: 0, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pg">
      <nav className="list" aria-label="Endpoints">
        {endpoints.map((e, i) => (
          <button key={e.slug} className={`item ${e.slug === slug ? "on" : ""}`} onClick={() => { setSlug(e.slug); setResult(null); }}>
            <span className="num">{String(i + 1).padStart(2, "0")}</span>
            <span className="name">{e.title}</span>
            <span className={`tag ${e.usesAI ? "ai" : ""}`}>{e.usesAI ? "AI" : "No key"}</span>
          </button>
        ))}
      </nav>

      <div className="panel">
        <div className="head">
          <h2>{current.title}</h2>
          <code className="route">POST /api/v1/{current.slug}</code>
          <p>{current.summary}</p>
          <p className="svc">Zee Palm services: {current.services.join(" · ")}</p>
          {current.disclaimer && <p className="warn">{current.disclaimer}</p>}
        </div>

        {current.usesAI && (
          <div className="ai">
            <label>
              Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
                <option value="mock">Mock (free sample response)</option>
                <option value="server">Server default (env key)</option>
                <option value="anthropic">Claude (your key)</option>
                <option value="openai">OpenAI (your key)</option>
                <option value="gemini">Gemini (your key)</option>
              </select>
            </label>
            {provider !== "mock" && provider !== "server" && (
              <label className="grow">
                API key <span className="hint">(sent only to this server, never stored)</span>
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-..." autoComplete="off" />
              </label>
            )}
          </div>
        )}

        <div className="grid">
          <div className="col">
            <div className="bar">
              <span>Request body</span>
              <button className="ghost" onClick={() => setBodies((b) => ({ ...b, [slug]: current.example }))}>Reset</button>
            </div>
            <textarea spellCheck={false} value={bodies[slug]} onChange={(e) => setBodies((b) => ({ ...b, [slug]: e.target.value }))} />
            <button className="send" onClick={send} disabled={busy}>
              {busy ? "Running…" : "Send request"}
            </button>
          </div>
          <div className="col">
            <div className="bar">
              <span>Response</span>
              {result && (
                <span className={`status ${result.status >= 200 && result.status < 300 ? "good" : "bad"}`}>
                  {result.status} · {result.ms} ms
                </span>
              )}
            </div>
            <pre className="out">{result ? result.text : "Send a request to see the response."}</pre>
          </div>
        </div>

        <div className="bar">
          <span>cURL</span>
          <button
            className="ghost"
            onClick={() => {
              navigator.clipboard?.writeText(curl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="curl">{curl}</pre>
        <p className="tip">
          Tip: add <code>{'"options": { "fields": ["..."], "language": "Urdu", "instructions": "...", "response_schema": {...} }'}</code> to any request to reshape the response.
        </p>
      </div>
    </section>
  );
}
