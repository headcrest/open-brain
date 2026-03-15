import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEB_API_KEY = Deno.env.get("WEB_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = new Hono();

// CORS for web app
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-brain-key"],
  })
);

// Auth check
const checkAuth = (c: any): boolean => {
  const provided = c.req.header("x-brain-key") || c.req.query("key");
  return provided && provided === WEB_API_KEY;
};

// GET /stats - Get statistics
app.get("/stats", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  
  try {
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

    return c.json({ total: count || 0, types, topics, people });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /thoughts - List thoughts with filters
app.get("/thoughts", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  
  try {
    const limit = parseInt(c.req.query("limit") || "50");
    const type = c.req.query("type");
    const topic = c.req.query("topic");
    const person = c.req.query("person");
    const days = c.req.query("days") ? parseInt(c.req.query("days")) : undefined;

    let query = supabase
      .from("thoughts")
      .select("id, content, metadata, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (type) query = query.contains("metadata", { type });
    if (topic) query = query.contains("metadata", { topics: [topic] });
    if (person) query = query.contains("metadata", { people: [person] });
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      query = query.gte("created_at", since.toISOString());
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    
    return c.json(data || []);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /thoughts - Capture a new thought
app.post("/thoughts", async (c: any) => {
  if (!checkAuth(c)) return c.json({ error: "Unauthorized" }, 401);
  
  try {
    const body = await c.req.json();
    if (!body.content) return c.json({ error: "Missing 'content' field" }, 400);

    // Simple insert without embedding (the ingest-thought function handles that)
    const { data, error } = await supabase
      .from("thoughts")
      .insert({
        content: body.content,
        metadata: { type: "observation", topics: [], people: [], source: "web" },
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return c.json(data, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

Deno.serve(app.fetch);
