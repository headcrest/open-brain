import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

type ThoughtRow = {
  id?: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  created_at: string;
};

// --- Helper Functions for REST API ---

async function listThoughts(params: {
  limit?: number;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
}): Promise<ThoughtRow[]> {
  let q = supabase
    .from("thoughts")
    .select("id, content, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(params.limit || 50);

  if (params.type) q = q.contains("metadata", { type: params.type });
  if (params.topic) q = q.contains("metadata", { topics: [params.topic] });
  if (params.person) q = q.contains("metadata", { people: [params.person] });
  if (params.days) {
    const since = new Date();
    since.setDate(since.getDate() - params.days);
    q = q.gte("created_at", since.toISOString());
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as ThoughtRow[];
}

async function searchThoughts(query: string, limit: number, threshold: number): Promise<ThoughtRow[]> {
  const embedding = await getEmbedding(query);
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: limit,
    filter: {},
  });
  if (error) throw new Error(error.message);
  return (data || []) as ThoughtRow[];
}

async function getStats(): Promise<{
  total: number;
  types: Record<string, number>;
  topics: Record<string, number>;
  people: Record<string, number>;
}> {
  const { count } = await supabase
    .from("thoughts")
    .select("*", { count: "exact", head: true });

  const { data } = await supabase
    .from("thoughts")
    .select("metadata");

  const types: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const people: Record<string, number> = {};

  for (const r of data || []) {
    const m = (r.metadata || {}) as Record<string, unknown>;
    if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
    if (Array.isArray(m.topics))
      for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
    if (Array.isArray(m.people))
      for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
  }

  return { total: count || 0, types, topics, people };
}

async function captureThought(content: string): Promise<ThoughtRow> {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractMetadata(content),
  ]);

  const { data, error } = await supabase
    .from("thoughts")
    .insert({
      content,
      embedding,
      metadata: { ...metadata, source: "web" },
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as ThoughtRow;
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// MCP Tools (keeping existing implementations)

server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. The user is Norwegian but stores thoughts in both Norwegian and English. Always search with queries in both languages when results are empty or uncertain. If still no results, retry with a lower threshold (e.g. 0.3) before giving up.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }: { query: string; limit: number; threshold: number }) => {
    try {
      const results = await searchThoughts(query, limit || 10, threshold || 0.5);
      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
        };
      }
      const text = results
        .map((t, i) => {
          const m = t.metadata || {};
          const sim = typeof t.similarity === "number" ? ` (${(t.similarity * 100).toFixed(1)}% match)` : "";
          return `--- Result ${i + 1}${sim} ---\nCaptured: ${new Date(t.created_at).toLocaleDateString()}\nType: ${m.type || "unknown"}\nTopics: ${(m.topics as string[] || []).join(", ")}\n\n${t.content}`;
        })
        .join("\n\n");
      return { content: [{ type: "text" as const, text: `Found ${results.length} thought(s):\n\n${text}` }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async (params: { limit?: number; type?: string; topic?: string; person?: string; days?: number }) => {
    try {
      const results = await listThoughts(params);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }
      const text = results
        .map((t, i) => {
          const m = t.metadata || {};
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"})\n   ${t.content}`;
        })
        .join("\n\n");
      return { content: [{ type: "text" as const, text: `${results.length} recent thought(s):\n\n${text}` }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const stats = await getStats();
      const lines = [
        `Total thoughts: ${stats.total}`,
        "",
        "Types:",
        ...Object.entries(stats.types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(stats.topics).length) {
        lines.push("", "Top topics:");
        lines.push(...Object.entries(stats.topics).slice(0, 10).map(([k, v]) => `  ${k}: ${v}`));
      }
      if (Object.keys(stats.people).length) {
        lines.push("", "People mentioned:");
        lines.push(...Object.entries(stats.people).map(([k, v]) => `  ${k}: ${v}`));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
    inputSchema: {
      content: z.string().describe("The thought to capture"),
    },
  },
  async ({ content }: { content: string }) => {
    try {
      const result = await captureThought(content);
      const meta = result.metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with REST API + MCP ---

const app = new Hono();

// CORS for web app
app.use(
  "/api/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-brain-key"],
  })
);

// Auth middleware for REST API
const checkAuth = (c: any): boolean => {
  const provided = c.req.header("x-brain-key") || c.req.query("key");
  return provided && provided === MCP_ACCESS_KEY;
};

// REST API: Get stats
app.get("/api/stats", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const stats = await getStats();
    return c.json(stats);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// REST API: List thoughts
app.get("/api/thoughts", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const params = {
      limit: parseInt(c.req.query("limit") || "50"),
      type: c.req.query("type") || undefined,
      topic: c.req.query("topic") || undefined,
      person: c.req.query("person") || undefined,
      days: c.req.query("days") ? parseInt(c.req.query("days")) : undefined,
    };
    const thoughts = await listThoughts(params);
    return c.json(thoughts);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// REST API: Search thoughts
app.get("/api/search", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "Missing query parameter 'q'" }, 400);
    const limit = parseInt(c.req.query("limit") || "10");
    const threshold = parseFloat(c.req.query("threshold") || "0.5");
    const results = await searchThoughts(query, limit, threshold);
    return c.json(results);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// REST API: Capture thought
app.post("/api/thoughts", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  try {
    const body = await c.req.json();
    if (!body.content) return c.json({ error: "Missing 'content' field" }, 400);
    const result = await captureThought(body.content);
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// MCP endpoint (catches all other requests)
app.all("*", async (c: any) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
