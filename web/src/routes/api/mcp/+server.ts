import { json } from '@sveltejs/kit';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { RequestHandler } from './$types';

const DEFAULT_CAPTURE_TOOL = 'capture_thought';

type McpJsonRpcResponse = {
	result?: unknown;
	error?: { message?: string };
};

type McpServerConfig = {
	id: string;
	name: string;
	url: string;
	key: string;
	captureTools: string[];
	captureDefaultTool: string;
};

type McpServerSummary = {
	id: string;
	name: string;
	captureTools: string[];
	captureDefaultTool: string;
	status?: 'ok' | 'error';
	latencyMs?: number;
	message?: string;
};

type McpToolCallPayload = {
	name?: string;
	tool?: string;
	args?: Record<string, unknown>;
	serverId?: string;
	serverIds?: string[];
};

function dedupe(strings: string[]): string[] {
	const result: string[] = [];
	for (const value of strings) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		if (!result.includes(trimmed)) {
			result.push(trimmed);
		}
	}

	return result.length ? result : [DEFAULT_CAPTURE_TOOL];
}

function parseCaptureTools(raw: unknown): string[] {
	if (!raw) return [DEFAULT_CAPTURE_TOOL];

	if (Array.isArray(raw)) {
		return dedupe(raw.map((value) => String(value)));
	}

	if (typeof raw !== 'string') return [DEFAULT_CAPTURE_TOOL];

	const trimmed = raw.trim();
	if (!trimmed) return [DEFAULT_CAPTURE_TOOL];

	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return dedupe(parsed.map((value) => String(value)));
			}
		} catch {
			// fall through to CSV parsing
		}
	}

	return dedupe(trimmed.split(',').map((value) => value.replace(/^"|"$/g, '').trim()));
}

function parseCaptureToolDefault(
	raw: unknown,
	captureTools: string[],
): string {
	if (typeof raw === 'string') {
		const normalized = raw.trim();
		if (normalized && captureTools.includes(normalized)) {
			return normalized;
		}
	}

	return captureTools[0] || DEFAULT_CAPTURE_TOOL;
}

function getRawServersFromEnv(): string | undefined {
	return privateEnv.MCP_SERVERS || publicEnv.PUBLIC_MCP_SERVERS;
}

function getCaptureToolsFromPrimaryEnv(): string[] {
	return parseCaptureTools(
		privateEnv.MCP_CAPTURE_TOOLS ||
			publicEnv.PUBLIC_MCP_CAPTURE_TOOLS ||
			privateEnv.MCP_PRIMARY_CAPTURE_TOOLS ||
			publicEnv.PUBLIC_MCP_PRIMARY_CAPTURE_TOOLS,
	);
}

function getPrimaryCaptureDefaultFromEnv(captureTools: string[]): string {
	return parseCaptureToolDefault(
		privateEnv.MCP_CAPTURE_DEFAULT_TOOL ||
			publicEnv.PUBLIC_MCP_CAPTURE_DEFAULT_TOOL ||
			privateEnv.MCP_PRIMARY_CAPTURE_DEFAULT_TOOL ||
			publicEnv.PUBLIC_MCP_PRIMARY_CAPTURE_DEFAULT_TOOL,
		captureTools,
	);
}

function normalizeServer(raw: unknown, fallbackTools: string[]): McpServerConfig | null {
	if (!raw || typeof raw !== 'object') return null;

	const candidate = raw as Record<string, unknown>;
	const rawUrl =
		(typeof candidate.url === 'string' && candidate.url.trim()) ||
		(typeof candidate.mcpUrl === 'string' && candidate.mcpUrl.trim()) ||
		'';
	const rawKey =
		(typeof candidate.key === 'string' && candidate.key.trim()) ||
		(typeof candidate.mcpKey === 'string' && candidate.mcpKey.trim()) ||
		'';

	if (!rawUrl || !rawKey) return null;

	const captureTools = parseCaptureTools(
		candidate.captureTools ||
			candidate.capture_tools ||
			candidate.tools ||
			fallbackTools,
	);
	const captureDefaultTool = parseCaptureToolDefault(
		candidate.defaultCaptureTool ||
			candidate.default_capture_tool ||
			candidate.defaultTool ||
			candidate.default_tool,
		captureTools,
	);

	const id =
		(typeof candidate.id === 'string' && candidate.id.trim()) ||
		(typeof candidate.label === 'string' && candidate.label.trim()) ||
		rawUrl;
	const name =
		(typeof candidate.name === 'string' && candidate.name.trim()) ||
		(typeof candidate.label === 'string' && candidate.label.trim()) ||
		id;

	return {
		id,
		name,
		url: rawUrl,
		key: rawKey,
		captureTools,
		captureDefaultTool,
	};
}

const MCP_SERVERS: McpServerConfig[] = (() => {
	const fallbackTools = getCaptureToolsFromPrimaryEnv();
	const fallbackDefaultTool = getPrimaryCaptureDefaultFromEnv(fallbackTools);

	const legacyUrl = privateEnv.MCP_URL || publicEnv.PUBLIC_MCP_URL;
	const legacyKey = privateEnv.MCP_KEY || publicEnv.PUBLIC_MCP_KEY;

	const rawServers = getRawServersFromEnv();
	if (!rawServers) {
		if (!legacyUrl || !legacyKey) {
			return [];
		}

		return [
			{
				id: 'primary',
				name: 'Primary MCP',
				url: legacyUrl,
				key: legacyKey,
				captureTools: fallbackTools,
				captureDefaultTool: fallbackDefaultTool,
			},
		];
	}

	try {
		const parsed = JSON.parse(rawServers);
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const resolved = entries
			.map((entry) => normalizeServer(entry, fallbackTools))
			.filter((entry): entry is McpServerConfig => entry !== null);

		if (!resolved.length) {
			if (legacyUrl && legacyKey) {
				return [
					{
						id: 'primary',
						name: 'Primary MCP',
						url: legacyUrl,
						key: legacyKey,
						captureTools: fallbackTools,
						captureDefaultTool: fallbackDefaultTool,
					},
				];
			}

			return [];
		}

		return resolved;
	} catch {
		if (!legacyUrl || !legacyKey) {
			return [];
		}

		return [
			{
				id: 'primary',
				name: 'Primary MCP',
				url: legacyUrl,
				key: legacyKey,
				captureTools: fallbackTools,
				captureDefaultTool: fallbackDefaultTool,
			},
		];
	}
})();

function parseMcpResponse(body: string): McpJsonRpcResponse {
	const trimmed = body.trim();
	if (!trimmed) return {};

	if (trimmed.startsWith('{')) {
		return JSON.parse(trimmed) as McpJsonRpcResponse;
	}

	const dataLines = trimmed
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.filter((line) => line && line !== '[DONE]');

	for (let i = dataLines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(dataLines[i]) as McpJsonRpcResponse;
		} catch {
			continue;
		}
	}

	throw new Error('Unable to parse MCP response');
}

function getMcpServers(_includeHealth = false): McpServerSummary[] {
	return MCP_SERVERS.map((server) => ({
		id: server.id,
		name: server.name,
		captureTools: server.captureTools,
		captureDefaultTool: server.captureDefaultTool,
	}));
}

function resolveMcpServer(serverId?: string, serverIds?: string[]): McpServerConfig | null {
	if (serverId) {
		return MCP_SERVERS.find((server) => server.id === serverId) || MCP_SERVERS[0] || null;
	}

	if (serverIds?.length) {
		const first = serverIds[0];
		if (first) {
			return MCP_SERVERS.find((server) => server.id === first) || MCP_SERVERS[0] || null;
		}
	}

	return MCP_SERVERS[0] || null;
}

function buildToolCallPayload(toolName: string, args: Record<string, unknown>): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id: Date.now(),
		method: 'tools/call',
		params: {
			name: toolName,
			arguments: args,
		},
	});
}

export const GET: RequestHandler = ({ url }) => {
	const includeHealth = url.searchParams.get('health') === '1';
	const servers = getMcpServers(includeHealth);

	if (!servers.length) {
		return json({ error: 'No MCP servers configured' }, { status: 500 });
	}

	return json({ servers });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		if (!locals.user) {
			return json({ error: 'Unauthorized' }, { status: 401 });
		}

		const payload = (await request.json()) as McpToolCallPayload;
		const toolName = payload.tool || payload.name;

		if (!toolName) {
			return json({ error: 'Missing tool name' }, { status: 400 });
		}

		const server = resolveMcpServer(payload.serverId, payload.serverIds);
		if (!server) {
			return json({ error: 'No MCP servers configured' }, { status: 500 });
		}

		const args = payload.args || {};

		const upstream = await fetch(`${server.url}?key=${server.key}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
			},
			body: buildToolCallPayload(toolName, args),
		});

		if (!upstream.ok) {
			const text = await upstream.text().catch(() => '');
			return json({ error: `MCP upstream HTTP ${upstream.status}`, details: text }, { status: 502 });
		}

		const parsed = parseMcpResponse(await upstream.text());
		if (parsed.error) {
			return json({ error: parsed.error.message || 'MCP error' }, { status: 502 });
		}

		return json({ result: parsed.result ?? null, source: { serverId: server.id, name: server.name } });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : 'Unknown proxy error';
		return json({ error: message }, { status: 500 });
	}
};
