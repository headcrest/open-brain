# Open Brain User Interface

Built with SvelteKit.

## MCP endpoint settings

- Set `MCP_URL` and `MCP_KEY` for a single default MCP endpoint.
- Or set `MCP_SERVERS` with multiple MCP server entries.

Example `MCP_SERVERS` value:

```bash
MCP_SERVERS=[
  {
    "id": "primary",
    "name": "Primary MCP",
    "url": "https://your-project.supabase.co/functions/v1/open-brain-mcp",
    "key": "your-access-key",
    "captureTools": ["capture_thought", "capture_reference"],
    "captureDefaultTool": "capture_thought"
  },
  {
    "id": "analytics",
    "name": "Analytics MCP",
    "url": "https://analytics-project.supabase.co/functions/v1/open-brain-mcp",
    "key": "analytics-access-key",
    "captureTools": ["capture_thought", "capture_snapshot"],
    "captureDefaultTool": "capture_snapshot"
  }
]
```

Optional primary defaults:

- `MCP_CAPTURE_TOOLS`
- `MCP_CAPTURE_DEFAULT_TOOL`

## Capture tool selection in UI

- Open the capture panel with **+ Capture**.
- Pick the destination server from **Server**.
- Pick the tool name from **Tool**.
- The dashboard stores your selected server and tool in browser local storage for reuse.
