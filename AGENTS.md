# AGENTS.md
Repository guide for coding agents working in this project.

## Scope and structure
- Root workspace: `functions/`
- Main code root: `supabase/`
- Edge function: `supabase/open-brain-mcp/`
- Edge function: `supabase/ingest-thought/`
- Runtime: TypeScript on Deno, deployed with Supabase Edge Functions

## Rule sources checked
- `.cursor/rules/`: not present
- `.cursorrules`: not present
- `.github/copilot-instructions.md`: not present
- No Cursor/Copilot-specific rule files are currently in this repository

## Working directory conventions
- Run Deno commands inside each function directory so local `deno.json` import maps are active
- If running from repo root, pass `--config` explicitly
- Example from repo root:
  - `deno lint --config supabase/open-brain-mcp/deno.json supabase/open-brain-mcp/index.ts`

## Build, run, lint, and test commands

### Supabase local serve
- `supabase functions serve open-brain-mcp --no-verify-jwt`
- `supabase functions serve ingest-thought --no-verify-jwt`

### Deploy
- Confirmed in repo README:
  - `supabase functions deploy open-brain-mcp --no-verify-jwt`
- Matching deploy pattern for the second function:
  - `supabase functions deploy ingest-thought --no-verify-jwt`

### Deno formatting (run per function directory)
- Check only: `deno fmt --check`
- Apply format: `deno fmt`

### Deno lint (run per function directory)
- Lint all local files: `deno lint`
- Lint one file: `deno lint index.ts`

### Type-check (run per function directory)
- Check all TS files: `deno check *.ts`
- Check one file: `deno check index.ts`

### Tests (Deno)
No `*_test.ts` files are currently committed, but use these commands when adding tests.
- Run all tests in current directory: `deno test`
- Run one test file: `deno test my_feature_test.ts`
- Run one test by name: `deno test --filter "captures metadata"`
- Run one test name in one file: `deno test my_feature_test.ts --filter "captures metadata"`

### Practical single-test examples
- Single file in MCP function:
  - `cd supabase/open-brain-mcp && deno test search_thoughts_test.ts`
- Single case in MCP function:
  - `cd supabase/open-brain-mcp && deno test search_thoughts_test.ts --filter "falls back to lexical"`
- Single case in ingest function:
  - `cd supabase/ingest-thought && deno test ingest_test.ts --filter "ignores bot events"`

## Fast pre-PR checklist
For each touched function directory (`supabase/open-brain-mcp` and/or `supabase/ingest-thought`):
1. `deno fmt --check`
2. `deno lint`
3. `deno check *.ts`
4. `deno test` (if tests exist)

## Code style and conventions

### Formatting and syntax
- Use Deno formatter output (`deno fmt`) as source of truth
- Use 2-space indentation
- Use semicolons
- Use double-quoted strings
- Keep trailing commas where formatter inserts them
- Break long literals/chains for readability instead of dense one-liners

### Imports
- Keep side-effect imports first (edge runtime bootstrap)
  - `import "jsr:@supabase/functions-js/edge-runtime.d.ts";`
- Then regular imports from packages/modules
- Prefer import-map aliases from local `deno.json` when available
- `ingest-thought` currently uses `https://esm.sh/...`; preserve file-local style unless refactoring intentionally
- Remove unused imports

### Types
- Add explicit parameter/return types for exported and non-trivial functions
- Use named narrow types for DB rows and tool payloads (example: `ThoughtRow`)
- Prefer `Record<string, unknown>` over `any` for flexible metadata
- In `catch`, use `unknown` and narrow before reading `.message`
- Avoid `any`; if needed, keep scope local and explain briefly

### Naming
- `camelCase` for variables/functions
- `PascalCase` for types/interfaces
- `UPPER_SNAKE_CASE` for env constants
- Keep public tool and RPC identifiers stable (`search_thoughts`, `capture_thought`, `match_thoughts`)

### Error handling
- Check `response.ok` for external HTTP calls before trusting response bodies
- Return user-safe messages; do not expose secrets/tokens
- For MCP tool failures, return structured error text and `isError: true`
- Keep fallback behavior for model/JSON parsing failures
- Prefer early returns for auth and validation failures

### Async and concurrency
- Use `Promise.all` for independent calls (for example embedding + metadata extraction)
- Keep sequential `await` when one step depends on previous output
- Keep async helpers focused and small

### Supabase data access
- Reuse module-level Supabase client
- Keep query chains readable (one method per line when long)
- Handle `{ data, error }` explicitly for RPC/query results
- Keep insert/update payloads explicit; avoid spreading unknown objects into DB writes

### API behavior contracts
- Preserve auth flow in MCP endpoint (`x-brain-key`, with query fallback already used in current code)
- Preserve Slack ingestion filters (channel check, ignore bot/subtype events)
- Preserve MCP response shape (`content` blocks and `isError` usage)
- Do not rename public tool IDs without coordinating downstream clients

### Environment variables
Required env vars currently used:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `MCP_ACCESS_KEY` (MCP function)
- `SLACK_BOT_TOKEN` (ingest function)
- `SLACK_CAPTURE_CHANNEL` (ingest function)

Rules for env handling:
- Read env vars once at module scope
- Fail fast if critical vars are missing
- Never log secret values

## Editing expectations for agents
- Make minimal, targeted changes
- Preserve existing behavior unless task explicitly requires behavior changes
- Match the style of the file you are editing
- Update this `AGENTS.md` when command workflows or conventions change
