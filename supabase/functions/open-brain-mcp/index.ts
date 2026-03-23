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
  content: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  created_at: string;
};

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

function buildQueryVariants(q: string): string[] {
  const original = q.trim();
  const base = normalizeQuery(q);
  const variants = new Set<string>([original]);

  const relationshipAliases = [
    "wife",
    "spouse",
    "partner",
    "girlfriend",
    "cohabitant",
    "husband",
    "kone",
    "ektefelle",
    "samboer",
    "kjareste",
    "kj\u00e6reste",
    "mann",
  ];

  const hasRelationshipTerm = relationshipAliases.some((term) => base.includes(term));

  if (hasRelationshipTerm) {
    for (const term of relationshipAliases) {
      variants.add(term);
      variants.add(`${original} ${term}`.trim());
    }
  } else {
    variants.add(`${original} wife`.trim());
    variants.add(`${original} spouse`.trim());
    variants.add(`${original} kone`.trim());
    variants.add(`${original} samboer`.trim());
  }

  return Array.from(variants).slice(0, 8);
}

async function runSemanticSearch(query: string, limit: number, threshold: number): Promise<ThoughtRow[]> {
  const qEmb = await getEmbedding(query);
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: qEmb,
    match_threshold: threshold,
    match_count: limit,
    filter: {},
  });

  if (error) throw new Error(error.message);
  return (data || []) as ThoughtRow[];
}

async function runLexicalFallback(query: string, limit: number): Promise<ThoughtRow[]> {
  const { data, error } = await supabase
    .from("thoughts")
    .select("content, metadata, created_at")
    .ilike("content", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data || []) as ThoughtRow[];
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// Tool 1: Semantic Search
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
      const safeLimit = Math.max(1, limit ?? 10);
      const primaryThreshold = threshold ?? 0.5;
      const lowerThreshold = Math.min(primaryThreshold, 0.35);

      const queriesTried: string[] = [];
      const thresholdsTried: number[] = [];
      const collected: ThoughtRow[] = [];
      const seen = new Set<string>();

      const addRows = (rows: ThoughtRow[]) => {
        for (const r of rows) {
          const key = `${r.content}::${r.created_at}`;
          if (!seen.has(key)) {
            seen.add(key);
            collected.push(r);
          }
        }
      };

      queriesTried.push(query);
      thresholdsTried.push(primaryThreshold);
      addRows(await runSemanticSearch(query, safeLimit, primaryThreshold));

      const variants = buildQueryVariants(query).filter((v) => v !== query);

      if (collected.length === 0) {
        for (const v of variants) {
          queriesTried.push(v);
          thresholdsTried.push(primaryThreshold);
          addRows(await runSemanticSearch(v, safeLimit, primaryThreshold));
          if (collected.length >= safeLimit) break;
        }
      }

      if (collected.length === 0 && lowerThreshold < primaryThreshold) {
        queriesTried.push(query);
        thresholdsTried.push(lowerThreshold);
        addRows(await runSemanticSearch(query, safeLimit, lowerThreshold));

        if (collected.length === 0) {
          for (const v of variants) {
            queriesTried.push(v);
            thresholdsTried.push(lowerThreshold);
            addRows(await runSemanticSearch(v, safeLimit, lowerThreshold));
            if (collected.length >= safeLimit) break;
          }
        }
      }

      let strategyUsed = "semantic";
      if (collected.length === 0) {
        strategyUsed = "lexical_fallback";
        addRows(await runLexicalFallback(query, safeLimit));
      }

      if (collected.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No thoughts found matching "${query}" after semantic+lexical fallback.\n` +
                `Search strategy: ${strategyUsed}\n` +
                `Queries tried: ${queriesTried.join(" | ")}\n` +
                `Thresholds tried: ${Array.from(new Set(thresholdsTried)).join(", ")}\n` +
                "Best score: n/a",
            },
          ],
        };
      }

      collected.sort((a, b) => {
        const sa = typeof a.similarity === "number" ? a.similarity : -1;
        const sb = typeof b.similarity === "number" ? b.similarity : -1;
        if (sa !== sb) return sb - sa;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      const top = collected.slice(0, safeLimit);

      const results = top.map((t: ThoughtRow, i: number) => {
          const m = t.metadata || {};
          const similarityLabel =
            typeof t.similarity === "number"
              ? ` (${(t.similarity * 100).toFixed(1)}% match)`
              : " (lexical)";

          const parts = [
            `--- Result ${i + 1}${similarityLabel} ---`,
            `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
            `Type: ${m.type || "unknown"}`,
          ];
          if (Array.isArray(m.topics) && m.topics.length)
            parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
          if (Array.isArray(m.people) && m.people.length)
            parts.push(`People: ${(m.people as string[]).join(", ")}`);
          if (Array.isArray(m.action_items) && m.action_items.length)
            parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
          parts.push(`\n${t.content}`);
          return parts.join("\n");
        });

      const bestScore = top.find((r) => typeof r.similarity === "number")?.similarity;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Found ${top.length} thought(s):\n\n${results.join("\n\n")}\n\n` +
              `Search strategy: ${strategyUsed}\n` +
              `Queries tried: ${queriesTried.join(" | ")}\n` +
              `Thresholds tried: ${Array.from(new Set(thresholdsTried)).join(", ")}\n` +
              `Best score: ${typeof bestScore === "number" ? bestScore.toFixed(3) : "n/a"}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: List Recent
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
  async ({
    limit,
    type,
    topic,
    person,
    days,
  }: {
    limit: number;
    type?: string;
    topic?: string;
    person?: string;
    days?: number;
  }) => {
    try {
      let q = supabase
        .from("thoughts")
        .select("content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || !data.length) {
        return { content: [{ type: "text" as const, text: "No thoughts found." }] };
      }

      const results = data.map(
        (
          t: { content: string; metadata: Record<string, unknown>; created_at: string },
          i: number
        ) => {
          const m = t.metadata || {};
          const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
          return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags : ""})\n   ${t.content}`;
        }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${data.length} recent thought(s):\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

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

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const lines: string[] = [
        `Total thoughts: ${count}`,
        `Date range: ${
          data?.length
            ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
              " → " +
              new Date(data[0].created_at).toLocaleDateString()
            : "N/A"
        }`,
        "",
        "Types:",
        ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];

      if (Object.keys(topics).length) {
        lines.push("", "Top topics:");
        for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
      }

      if (Object.keys(people).length) {
        lines.push("", "People mentioned:");
        for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
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

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems. At natural breakpoints in business conversations, proactively suggest saving key contacts, decisions, and action items using a multi-select picker. Don't wait for the user to ask.",
    inputSchema: {
      content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
    },
  },
  async ({ content }: { content: string }) => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { error } = await supabase.from("thoughts").insert({
        content,
        embedding,
        metadata: { ...metadata, source: "mcp" },
      });

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
          isError: true,
        };
      }

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length)
        confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length)
        confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length)
        confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return {
        content: [{ type: "text" as const, text: confirmation }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);

// --- Hono App with Auth Check ---

const app = new Hono();

// CORS for browser clients (web app)
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "x-brain-key"],
}));

app.all("*", async (c: any) => {
  // Accept access key via header OR URL query parameter
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
