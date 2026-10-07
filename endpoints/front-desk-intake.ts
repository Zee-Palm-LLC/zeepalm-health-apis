import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";
import { CustomSchemaResult } from "@/lib/ai";
import { EMERGENCY_REPLY, detectRedFlags } from "@/lib/safety";

const Input = z.object({
  message: z.string().min(1).max(4000),
  channel: z.enum(["whatsapp", "sms", "web_chat", "voice_transcript", "email", "instagram_dm"]).default("whatsapp"),
  business: z.object({
    name: z.string(),
    type: z.enum(["clinic", "physiotherapy", "dental", "therapy", "gym", "studio", "personal_training", "spa", "nutrition", "other"]),
    timezone: z.string().default("UTC"),
    services: z.array(z.object({ name: z.string(), duration_min: z.number().optional(), price: z.string().optional() })).default([]),
    opening_hours: z.string().optional().describe('Free text, e.g. "Mon-Fri 9-19, Sat 10-14"'),
    policies: z.string().max(2000).optional().describe("Cancellation policy, FAQs, address... used to answer questions."),
  }),
  client: z
    .object({
      name: z.string().optional(),
      upcoming_bookings: z.array(z.object({ id: z.string(), service: z.string(), start: z.string() })).default([]),
    })
    .optional(),
  conversation: z.array(z.object({ role: z.enum(["client", "business"]), text: z.string() })).max(20).default([]).describe("Previous turns, oldest first."),
});

const Intent = z.enum(["book", "reschedule", "cancel", "availability", "pricing", "question", "complaint", "clinical_concern", "emergency", "feedback", "other"]);
const Urgency = z.enum(["emergency", "urgent", "routine", "admin"]);

const AIOut = z.object({
  intent: Intent,
  secondary_intents: z.array(Intent),
  urgency: Urgency,
  sentiment: z.enum(["positive", "neutral", "negative", "distressed"]),
  entities: z.object({
    service: z.string().optional().describe("Exact name from business.services when possible."),
    booking_id: z.string().optional(),
    preferred_times: z.array(z.object({ start: z.string(), end: z.string(), flexible: z.boolean() })).describe("Resolved ISO 8601 with offset, in the business timezone."),
    practitioner: z.string().optional(),
    party_size: z.number().optional(),
    client_name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
  }),
  missing_info: z.array(z.string()).describe("What still needs to be asked before the action can be completed."),
  suggested_reply: z.string(),
  handoff: z.object({ to_human: z.boolean(), reason: z.string().optional(), team: z.enum(["front_desk", "clinical", "manager", "billing"]).optional() }),
  summary: z.string().describe("One line for the CRM / inbox."),
});

const Output = AIOut.extend({
  red_flags: z.array(z.object({ category: z.string(), label: z.string(), matched: z.string() })),
});

const URGENCY_RANK = { admin: 0, routine: 1, urgent: 2, emergency: 3 } as const;

export default defineEndpoint({
  slug: "front-desk-intake",
  title: "AI Front-Desk Intake & Triage",
  summary: "Classify inbound WhatsApp/SMS/voice messages: intent, urgency, booking times resolved to ISO, reply draft and handoff, with an emergency safety net.",
  category: "clinic-ops",
  usesAI: true,
  zeePalmServices: ["AI Receptionist", "Voice AI Booking", "WhatsApp Automation", "Front Desk AI", "Booking System Setup", "CRM Setup"],
  input: Input,
  output: Output,
  disclaimer: "Administrative triage only, not clinical advice. Emergency detection is a safety net, not a substitute for clinical judgement.",
  exampleInput: {
    message: "Hi, can I move my physio session on Thursday to Saturday morning? My knee has been a bit more swollen since last week btw",
    channel: "whatsapp",
    business: {
      name: "MoveWell Physio",
      type: "physiotherapy",
      timezone: "Asia/Karachi",
      services: [{ name: "Physio follow-up", duration_min: 45, price: "PKR 6,000" }, { name: "Initial assessment", duration_min: 60 }],
      opening_hours: "Mon-Fri 9:00-19:00, Sat 10:00-14:00",
    },
    client: { name: "Hamza", upcoming_bookings: [{ id: "bk_8812", service: "Physio follow-up", start: "2026-10-08T17:00:00+05:00" }] },
    options: { now: "2026-10-06T11:20:00+05:00" },
  },
  async run(input, { ai, now, meta }) {
    const text = [input.message, ...input.conversation.filter((t) => t.role === "client").map((t) => t.text)].join("\n");
    const redFlags = detectRedFlags(input.message);
    meta.safety_guard = { red_flags: redFlags, escalated: redFlags.length > 0 };

    const nowLocal = new Intl.DateTimeFormat("en-GB", { timeZone: input.business.timezone, dateStyle: "full", timeStyle: "short" }).format(now);
    const flagged = redFlags.length > 0 || detectRedFlags(text).some((f) => f.category === "self_harm");
    let out: z.infer<typeof AIOut>;
    try {
      out = await ai.generate({
      system: `You are the front-desk assistant for a ${input.business.type} business called "${input.business.name}".
Classify the client's latest message and draft a reply for the ${input.channel} channel.
- Resolve relative dates ("Saturday morning", "tomorrow after 5") into ISO 8601 ranges in the ${input.business.timezone} timezone. Current local time: ${nowLocal} (${now.toISOString()}).
- Match services and bookings to the provided lists. Use booking ids when the client refers to an existing booking.
- Never give a diagnosis or treatment advice. Symptoms that are new or worsening → secondary intent clinical_concern, urgency at least "urgent", and hand off to the clinical team.
- Never confirm a booking as done; say you'll confirm availability.
- Keep replies short, warm and channel-appropriate (WhatsApp/SMS: under 60 words, no markdown).
- Only state prices, hours and policies that appear in the input.`,
      prompt: `<input>\n${JSON.stringify(input, null, 2)}\n</input>`,
      schema: AIOut,
    });
    } catch (err) {
      if (!flagged || err instanceof CustomSchemaResult) throw err;
      out = {
        intent: "emergency", secondary_intents: [], urgency: "emergency", sentiment: "distressed",
        entities: { preferred_times: [] }, missing_info: [], suggested_reply: EMERGENCY_REPLY,
        handoff: { to_human: true }, summary: "Emergency red flag detected (AI unavailable).",
      };
    }

    if (flagged) {
      const flags = redFlags.length ? redFlags : detectRedFlags(text);
      return {
        ...out,
        intent: "emergency" as const,
        secondary_intents: [...new Set([out.intent, ...out.secondary_intents])].filter((i) => i !== "emergency"),
        urgency: "emergency" as const,
        suggested_reply: EMERGENCY_REPLY,
        handoff: { to_human: true, reason: `Safety rule: ${flags.map((f) => f.label).join(", ")}`, team: "clinical" as const },
        red_flags: flags,
      };
    }
    if (URGENCY_RANK[out.urgency] >= URGENCY_RANK.urgent && !out.handoff.to_human) {
      out.handoff = { to_human: true, reason: out.handoff.reason ?? "Urgent message", team: out.handoff.team ?? "front_desk" };
    }
    return { ...out, red_flags: [] };
  },
  exampleOutput: {
    intent: "reschedule",
    secondary_intents: ["clinical_concern"],
    urgency: "urgent",
    sentiment: "neutral",
    entities: {
      service: "Physio follow-up",
      booking_id: "bk_8812",
      preferred_times: [{ start: "2026-10-10T10:00:00+05:00", end: "2026-10-10T12:00:00+05:00", flexible: true }],
      client_name: "Hamza",
    },
    missing_info: ["Exact preferred start time on Saturday"],
    suggested_reply:
      "Hi Hamza! Happy to move Thursday's follow-up to Saturday morning. We open 10-2, so I'll check slots and confirm shortly. Since your knee is more swollen, I've let your physio know so they can advise before then.",
    handoff: { to_human: true, reason: "Increased knee swelling reported", team: "clinical" },
    summary: "Reschedule bk_8812 (Thu 17:00) to Sat morning; reports increased knee swelling.",
  },
});
