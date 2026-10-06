import { endpoints } from "@/endpoints";
import Playground, { type EndpointInfo } from "./playground";

export default function Home() {
  const list: EndpointInfo[] = endpoints.map((e) => ({
    slug: e.slug,
    title: e.title,
    summary: e.summary,
    usesAI: e.usesAI,
    services: e.zeePalmServices,
    example: JSON.stringify(e.exampleInput, null, 2),
    disclaimer: e.disclaimer,
  }));
  return (
    <main className="wrap">
      <header className="hero">
        <p className="eyebrow">Zee Palm Labs · open source</p>
        <h1>Health APIs you can ship today</h1>
        <p className="lede">
          10 production-ready endpoints for healthcare, fitness and wellness products: 5 deterministic, 5 AI-powered. Deploy to Vercel, bring your own
          Claude, OpenAI or Gemini key, and edit any schema in one file.
        </p>
        <div className="links">
          <a href="/api/v1">/api/v1</a>
          <a href="/api/openapi">OpenAPI spec</a>
        </div>
      </header>
      <Playground endpoints={list} />
      <footer className="foot">
        Built by <a href="https://www.zeepalm.com">Zee Palm</a>. MIT licensed. Not a medical device: outputs support, never replace, professional judgement.
      </footer>
    </main>
  );
}
