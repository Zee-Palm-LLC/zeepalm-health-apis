# Zee Palm Health APIs

**10 open-source APIs for healthcare, fitness and wellness products**, from [Zee Palm Labs](https://www.zeepalm.com).

Deploy to Vercel in one click and add your Claude, OpenAI or Gemini key. Each API lives in one file, so you can change its request and response shape without touching anything else.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhiba0900%2Fzeepalm-health-apis&env=ANTHROPIC_API_KEY&envDescription=Only%20needed%20for%20the%205%20AI%20endpoints.%20OPENAI_API_KEY%20or%20GEMINI_API_KEY%20also%20work.&project-name=health-apis)

| # | Endpoint | What it does | AI | Built for |
|---|---|---|---|---|
| 1 | `POST /api/v1/wearables-normalize` | Apple Health, Health Connect, Fitbit, Garmin, Oura and WHOOP payloads → one daily schema | No | Wearable integrations, dashboards |
| 2 | `POST /api/v1/recovery-readiness` | 0-100 readiness from HRV, resting HR, sleep, ACWR training load and how the user feels | No | Coaching and gym apps |
| 3 | `POST /api/v1/nutrition-targets` | BMR, TDEE, calorie target, macros, fibre, hydration, BMI/FFMI | No | Coaching platforms |
| 4 | `POST /api/v1/member-churn-risk` | Explainable churn score, drivers, retention actions and revenue at risk for up to 1,000 members | No | Gyms, studios, memberships |
| 5 | `POST /api/v1/mental-health-screening` | PHQ-9, PHQ-2, GAD-7, GAD-2 and WHO-5 scoring with change tracking and self-harm escalation | No | Mental-health MVPs |
| 6 | `POST /api/v1/workout-program` | Injury-aware program: week template + weekly progression | Yes | AI coach assistants |
| 7 | `POST /api/v1/meal-plan` | Macro-matched meal plan + grocery list, checked against allergies in code | Yes | Nutrition and coaching apps |
| 8 | `POST /api/v1/front-desk-intake` | WhatsApp/SMS/voice message → intent, urgency, ISO booking times, reply, human handoff | Yes | AI receptionist, voice booking |
| 9 | `POST /api/v1/label-scan` | Supplement/nutrition label photo → JSON, plus upper-limit, caffeine and allergen flags | Yes (vision) | Supplement brands, e-commerce |
| 10 | `POST /api/v1/session-notes` | Session transcript → SOAP / DAP / BIRP / GROW note, action items, client recap | Yes | Clinics, therapists, coaches |

The 5 deterministic endpoints need no key and return in milliseconds. The AI endpoints add code-based guardrails on top of the model, so the model can't skip them:

- `front-desk-intake`: an emergency (chest pain, stroke signs, suicidal language…) is always escalated, even if the model says "routine" or the provider is down.
- `meal-plan`: daily totals are recalculated in code and every ingredient is checked against the client's allergies.
- `label-scan`: doses are compared against adult tolerable upper limits.
- `session-notes`: the transcript is scanned for crisis language.

## Quick start

```bash
git clone https://github.com/hiba0900/zeepalm-health-apis && cd zeepalm-health-apis
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY (or OPENAI / GEMINI), optional
npm run dev                  # http://localhost:3000 → interactive playground
```

Try it without any key:

```bash
curl -X POST http://localhost:3000/api/v1/nutrition-targets \
  -H 'content-type: application/json' \
  -d '{"sex":"female","age":32,"height_cm":165,"weight_kg":72,"goal":"lose"}'
```

AI endpoints accept `x-ai-provider: mock`, which returns a realistic sample at no cost. It's handy while you build your front end:

```bash
curl -X POST http://localhost:3000/api/v1/front-desk-intake \
  -H 'content-type: application/json' -H 'x-ai-provider: mock' \
  -d '{"message":"Can I move Thursday to Saturday morning?","business":{"name":"MoveWell","type":"physiotherapy"}}'
```

## Discoverability

- `GET /`: playground for every endpoint, with a cURL generator
- `GET /api/v1`: list of endpoints
- `GET /api/v1/<slug>`: input schema, output schema and an example request
- `GET /api/openapi`: OpenAPI 3.1 spec, generated from the code. Import it into Postman, Insomnia or Swagger.

## Response format

```json
{
  "ok": true,
  "data": { "...": "endpoint output" },
  "meta": { "endpoint": "meal-plan", "request_id": "…", "latency_ms": 8421, "ai": { "provider": "anthropic", "model": "claude-opus-5-5" }, "disclaimer": "…" }
}
```

Errors use `{ "ok": false, "error": { "code", "message", "details" } }` with a meaningful HTTP status: `422` validation (with field paths), `401` missing key, `429` rate limit, `502` provider error.

## Customise requests and responses

There are three levels, from no code at all to a full fork.

**1. Per request, no code.** Add `options` to any request body:

```json
{
  "...": "normal input",
  "options": {
    "fields": ["score", "components.hrv"],
    "language": "Urdu",
    "instructions": "Use our brand voice: upbeat, no emojis. Always sign off as 'Team MoveWell'.",
    "response_schema": { "type": "object", "properties": { "reply": { "type": "string" }, "needs_human": { "type": "boolean" } }, "required": ["reply", "needs_human"], "additionalProperties": false },
    "model": "claude-sonnet-5-5",
    "now": "2026-10-06T09:00:00Z"
  }
}
```

| Option | Applies to | Effect |
|---|---|---|
| `fields` | all | Return only these (dot-path) fields of `data` |
| `language` | AI | Write all human-readable text in this language |
| `instructions` | AI | Extra rules appended to the system prompt |
| `response_schema` | AI | The model returns **your** JSON Schema instead of the default output (built-in post-processing is skipped; safety results still go in `meta`) |
| `model` | AI | Override the model for this call |
| `now` | all | Fix the current time (tests, backfills, timezone-relative booking) |

**2. Edit one file.** Each endpoint is a single file in [`endpoints/`](endpoints). Change its Zod `input` or `output` schema. Validation, the AI's JSON Schema, the playground and the OpenAPI spec all update from it. Tunable constants sit at the top of each file: macro coefficients, churn weights and retention playbook, readiness weights, allergen keywords, upper limits, equipment presets.

**3. Add your own endpoint.** Create `endpoints/my-endpoint.ts`:

```ts
import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";

export default defineEndpoint({
  slug: "hydration-reminder",
  title: "Hydration Reminder",
  summary: "…",
  category: "nutrition",
  usesAI: true,
  zeePalmServices: ["AI Coach Assistant"],
  input: z.object({ name: z.string(), drank_ml: z.number() }),
  output: z.object({ message: z.string() }),
  exampleInput: { name: "Sara", drank_ml: 900 },
  exampleOutput: { message: "Sara, you're at 900 ml. Two more glasses before 3pm!" },
  run: (input, { ai }) =>
    ai.generate({ system: "You are a friendly hydration coach.", prompt: JSON.stringify(input), schema: z.object({ message: z.string() }) }),
});
```

Then add it to [`endpoints/index.ts`](endpoints/index.ts). The route, validation, docs and OpenAPI entry are created for you.

## Chain them

The endpoints are designed to feed into each other:

- `wearables-normalize` → `data.days` → `recovery-readiness` (`days`) → `score` → `workout-program` (`readiness_score`)
- `nutrition-targets` → `target_kcal` + `macros` → `meal-plan` (`targets`)
- `front-desk-intake` → `entities.preferred_times` → your booking system → `member-churn-risk` (visits)

## AI providers

| Provider | Env var | Default model | Notes |
|---|---|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | Official SDK, structured outputs, server-side refusal fallback |
| OpenAI | `OPENAI_API_KEY` | `gpt-5` | Strict JSON Schema. `OPENAI_BASE_URL` works with Groq, OpenRouter, Together, Ollama |
| Google Gemini | `GEMINI_API_KEY` | `gemini-flash-latest` | `responseJsonSchema` |
| Mock | none | none | Returns each endpoint's sample output |

Set `AI_MODEL` to change the default model. **Bring your own key:** callers can send `x-ai-provider`, `x-ai-key` and `x-ai-model` headers. That makes a public demo deployment free to host. Set `ALLOW_BYOK=false` when the deployment uses your own server-side key.

## Deploy to Vercel

1. Push this repo to GitHub, then click **Deploy with Vercel** above (or run `vercel`).
2. Add `ANTHROPIC_API_KEY` (or OpenAI or Gemini) in Project → Settings → Environment Variables. Skip this if you only use the deterministic endpoints or BYOK.
3. Recommended for production: set `API_ACCESS_KEYS`, `ALLOW_BYOK=false` and `CORS_ORIGIN=https://your-app.com`.

AI routes allow up to 300 s (`maxDuration`). Long workout programs on large models can take 30-90 s.

## Wearable payload shapes

`wearables-normalize` accepts what each vendor actually returns:

| `source` | `data` |
|---|---|
| `apple_health` | HealthKit samples `[{ type: "HKQuantityTypeIdentifierStepCount", value, unit, startDate, endDate }]`, including `SleepAnalysis` stages |
| `health_connect` | Records `[{ recordType: "StepsRecord", count, startTime }, { recordType: "SleepSessionRecord", stages: [...] }]` |
| `fitbit` | Web API responses merged: `{ "activities-steps", "activities-heart", sleep, hrv, spo2, br }` |
| `garmin` | Health API summaries: `{ dailies, sleeps, hrv, pulseox }` |
| `oura` | API v2: `{ daily_activity, sleep, daily_readiness, daily_spo2 }` (each `{ data: [...] }` or an array) |
| `whoop` | API v2: `{ recovery, sleep, cycle }` (each `{ records: [...] }` or an array) |

Note: Apple Health exports HRV as SDNN. It's used as an RMSSD proxy, and the response includes a warning saying so.

## Tests

```bash
npm test         # 34 tests: every example, safety rules, calculations, provider wire formats
npm run build
```

## Safety, privacy and compliance

- These APIs **support** professionals. They don't diagnose, and they aren't medical devices. Every response carries a disclaimer in `meta`.
- Nothing is stored or logged. Error logs record only the endpoint and request id, never request bodies.
- If you send identifiable health data to an AI provider, make sure you have the right agreements in place (e.g. a HIPAA BAA, a GDPR DPA), and use a zero-retention option where available.
- Crisis resources default to international lines. Set `CRISIS_RESOURCES_JSON` for your country.
- The red-flag rules in [`lib/safety.ts`](lib/safety.ts) are a safety net, not a clinical protocol. Review and extend them with your clinical lead.

## Need it production-grade?

Zee Palm builds healthcare, mental-health, gym and coaching products: MVPs, wearable integrations, AI receptionists, churn prediction and more. [zeepalm.com](https://www.zeepalm.com)

MIT © Zee Palm
