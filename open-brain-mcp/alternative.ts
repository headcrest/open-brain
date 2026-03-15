import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function getEmbedding(text: string): Promise<number[]> {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
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
    const d = await r.json();
    return d.data[0].embedding;
}

function createMcpServer(): McpServer {
    const server = new McpServer({
        name: "open-brain",
        version: "1.0.0",
    });

    server.registerTool(
        "search_thoughts",
        {
            title: "Search Thoughts",
            description:
                "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
            inputSchema: {
                query: z.string().describe("What to search for"),
                limit: z.number().optional().default(10),
                threshold: z.number().optional().default(0.5),
            },
        },
        async ({ query, limit, threshold }) => {
            try {
                const qEmb = await getEmbedding(query);
                const { data, error } = await supabase.rpc("match_thoughts", {
                    query_embedding: qEmb,
                    match_threshold: threshold,
                    match_count: limit,
                    filter: {},
                });

                if (error) {
                    return {
                        content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
                        isError: true,
                    };
                }

                if (!data || data.length === 0) {
                    return {
                        content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
                    };
                }

                const results = data.map(
                    (
                        t: {
                            content: string;
                            metadata: Record<string, unknown>;
                            similarity: number;
                            created_at: string;
                        },
                        i: number
                    ) => {
                        const m = t.metadata || {};
                        const parts = [
                            `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
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
                    }
                );

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}`,
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
        async ({ limit, type, topic, person, days }) => {
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
                        return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " - " + tags
                            : ""})\n   ${t.content}`;
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
                    `Date range: ${data?.length
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
    server.registerTool(
        "capture_thought",
        {
            title: "Capture Thought",
            description:
                "Save a thought, observation, or note to the brain. Use this to capture anything worth remembering: ideas, people notes, tasks, references, or observations.",
            inputSchema: {
                content: z.string().describe("The thought to capture"),
                source: z.string().optional().default("mcp").describe("Where this came from (e.g. claude-code, claude-desktop)"),
            },
        },
        async ({ content, source }) => {
            try {
                // Extract metadata via LLM (same as ingest-thought)
                const metaResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
                                content: "Extract metadata from the user's captured thought. Return JSON with: \"people\" (array of people mentioned, empty if none), \"action_items\" (array of implied to-dos, empty if none), \"dates_mentioned\" (array of dates YYYY-MM-DD, empty if none), \"topics\" (array of 1-3 short topic tags, always at least one), \"type\" (one of observation, task, idea, reference, person_note). Only extract what is explicitly there.",
                            },
                            { role: "user", content },
                        ],
                    }),
                });
                const metaData = await metaResponse.json();
                let metadata: Record<string, unknown>;
                try {
                    metadata = JSON.parse(metaData.choices[0].message.content);
                } catch {
                    metadata = { topics: ["uncategorized"], type: "observation" };
                }

                const embedding = await getEmbedding(content);

                const { error } = await supabase.from("thoughts").insert({
                    content,
                    embedding,
                    metadata: { ...metadata, source },
                });

                if (error) {
                    return {
                        content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
                        isError: true,
                    };
                }

                let confirmation = `Captured as ${metadata.type || "thought"}`;
                if (Array.isArray(metadata.topics) && metadata.topics.length)
                    confirmation += ` — ${(metadata.topics as string[]).join(", ")}`;
                if (Array.isArray(metadata.people) && metadata.people.length)
                    confirmation += `\nPeople: ${(metadata.people as string[]).join(", ")}`;

                return { content: [{ type: "text" as const, text: confirmation }] };
            } catch (err: unknown) {
                return {
                    content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
                    isError: true,
                };
            }
        }
    );

    return server;
}

const app = new Hono();

app.all("*", async (c) => {
    if (c.req.method !== "POST") {
        return c.json({ error: "Method not allowed" }, 405);
    }

    const provided = c.req.header("x-brain-key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
        return c.json({ error: "Invalid or missing access key" }, 401);
    }

    // Ensure Accept header includes both types so StreamableHTTPTransport
    // doesn't reject clients (like mcp-remote) that omit it
    const accept = c.req.header("accept") || "";
    if (!accept.includes("text/event-stream")) {
        c.req.raw = new Request(c.req.raw, {
            headers: new Headers([
                ...Array.from(c.req.raw.headers.entries()),
                ["accept", "application/json, text/event-stream"],
            ]),
        });
    }

    const server = createMcpServer();
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
});

Deno.serve(app.fetch);

