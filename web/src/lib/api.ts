import { PUBLIC_MCP_URL, PUBLIC_MCP_KEY } from '$env/static/public';
import type { Thought, ThoughtType } from './types';

interface McpToolResult {
	content: { type: string; text: string }[];
}

interface ApiThought {
	id: string;
	content: string;
	metadata: {
		type: ThoughtType;
		topics: string[];
		people: string[];
		action_items?: string[];
	};
	created_at: string;
}

let requestId = 0;

async function callMcpTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
	const url = `${PUBLIC_MCP_URL}?key=${PUBLIC_MCP_KEY}`;
	
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++requestId,
			method: 'tools/call',
			params: {
				name,
				arguments: args
			}
		})
	});
	
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}
	
	const result = await response.json();
	
	if (result.error) {
		throw new Error(result.error.message || 'MCP error');
	}
	
	return result.result;
}

function parseThoughtsFromText(text: string): ApiThought[] {
	// Parse the formatted text response from list_thoughts
	const thoughts: ApiThought[] = [];
	const lines = text.split('\n');
	
	for (const line of lines) {
		// Format: "1. [Mar 15, 2026] (observation - topic1, topic2)\n   Content here"
		const match = line.match(/^(\d+)\.\s*\[([^\]]+)\]\s*\(([^)]+)\)\s*\n?\s*(.+)$/);
		if (match) {
			const [, , dateStr, metaStr, content] = match;
			const [type, topicsStr] = metaStr.split(' - ');
			
			thoughts.push({
				id: crypto.randomUUID(),
				content: content.trim(),
				metadata: {
					type: type.trim() as ThoughtType,
					topics: topicsStr ? topicsStr.split(', ').map(t => t.trim()) : [],
					people: [],
				},
				created_at: new Date(dateStr).toISOString(),
			});
		}
	}
	
	return thoughts;
}

function parseStatsFromText(text: string): {
	total: number;
	types: Record<string, number>;
	topics: Record<string, number>;
	people: Record<string, number>;
} {
	const lines = text.split('\n');
	const stats = {
		total: 0,
		types: {} as Record<string, number>,
		topics: {} as Record<string, number>,
		people: {} as Record<string, number>,
	};
	
	let section = '';
	for (const line of lines) {
		if (line.startsWith('Total thoughts:')) {
			stats.total = parseInt(line.match(/\d+/)?.[0] || '0');
		} else if (line === 'Types:') {
			section = 'types';
		} else if (line === 'Top topics:') {
			section = 'topics';
		} else if (line === 'People mentioned:') {
			section = 'people';
		} else if (line.trim().startsWith('  ')) {
			const match = line.trim().match(/^([^:]+):\s*(\d+)/);
			if (match) {
				const [, key, value] = match;
				if (section === 'types') stats.types[key] = parseInt(value);
				else if (section === 'topics') stats.topics[key] = parseInt(value);
				else if (section === 'people') stats.people[key] = parseInt(value);
			}
		}
	}
	
	return stats;
}

export async function getStats(): Promise<{
	total: number;
	types: Record<string, number>;
	topics: Record<string, number>;
	people: Record<string, number>;
}> {
	const result = await callMcpTool('thought_stats');
	const text = result.content[0]?.text || '';
	return parseStatsFromText(text);
}

export async function getThoughts(params: {
	limit?: number;
	type?: ThoughtType | null;
	topic?: string | null;
	person?: string | null;
	search?: string;
}): Promise<Thought[]> {
	// If searching, use search_thoughts, otherwise use list_thoughts
	if (params.search) {
		const result = await callMcpTool('search_thoughts', {
			query: params.search,
			limit: params.limit || 50,
		});
		// Parse search results - different format
		const text = result.content[0]?.text || '';
		return parseSearchResults(text);
	}
	
	const args: Record<string, unknown> = {
		limit: params.limit || 50,
	};
	if (params.type) args.type = params.type;
	if (params.topic) args.topic = params.topic;
	if (params.person) args.person = params.person;
	
	const result = await callMcpTool('list_thoughts', args);
	const text = result.content[0]?.text || '';
	return parseListResults(text);
}

function parseSearchResults(text: string): Thought[] {
	const thoughts: Thought[] = [];
	const blocks = text.split(/--- Result \d+/);
	
	for (const block of blocks) {
		if (!block.trim() || block.includes('No thoughts found')) continue;
		
		const lines = block.trim().split('\n');
		let content = '';
		let createdAt = '';
		let type: ThoughtType = 'observation';
		const topics: string[] = [];
		const people: string[] = [];
		
		for (const line of lines) {
			if (line.startsWith('Captured:')) {
				createdAt = line.replace('Captured:', '').trim();
			} else if (line.startsWith('Type:')) {
				type = line.replace('Type:', '').trim() as ThoughtType;
			} else if (line.startsWith('Topics:')) {
				topics.push(...line.replace('Topics:', '').trim().split(', '));
			} else if (line.startsWith('People:')) {
				people.push(...line.replace('People:', '').trim().split(', '));
			} else if (line.trim() && !line.includes('% match)')) {
				content += (content ? '\n' : '') + line;
			}
		}
		
		if (content) {
			thoughts.push({
				id: crypto.randomUUID(),
				content,
				metadata: { type, topics, people },
				created_at: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(),
			});
		}
	}
	
	return thoughts;
}

function parseListResults(text: string): Thought[] {
	const thoughts: Thought[] = [];
	const lines = text.split('\n');
	
	for (const line of lines) {
		// Format: "1. [Mar 15, 2026] (type - topic)\n   content"
		const match = line.match(/^\d+\.\s*\[([^\]]+)\]\s*\(([^)]+)\)\s*(.+)$/);
		if (match) {
			const [, dateStr, metaStr, content] = match;
			const [type, ...topicParts] = metaStr.split(' - ');
			
			thoughts.push({
				id: crypto.randomUUID(),
				content: content.trim(),
				metadata: {
					type: type.trim() as ThoughtType,
					topics: topicParts.join(' - ').split(', ').map(t => t.trim()).filter(Boolean),
					people: [],
				},
				created_at: new Date(dateStr).toISOString(),
			});
		}
	}
	
	return thoughts;
}

export async function captureThought(content: string): Promise<Thought> {
	const result = await callMcpTool('capture_thought', { content });
	const text = result.content[0]?.text || '';
	
	// Response: "Captured as observation — topic1, topic2"
	const match = text.match(/Captured as (\w+)/);
	
	return {
		id: crypto.randomUUID(),
		content,
		metadata: {
			type: (match?.[1] || 'observation') as ThoughtType,
			topics: [],
			people: [],
		},
		created_at: new Date().toISOString(),
	};
}
