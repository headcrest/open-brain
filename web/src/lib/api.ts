import { PUBLIC_MCP_URL, PUBLIC_MCP_KEY } from '$env/static/public';
import type { Thought, ThoughtType } from './types';

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
	similarity?: number;
}

interface Stats {
	total: number;
	types: Record<string, number>;
	topics: Record<string, number>;
	people: Record<string, number>;
}

async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
	const url = `${PUBLIC_MCP_URL}/api${endpoint}`;
	const res = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			'x-brain-key': PUBLIC_MCP_KEY,
			...options.headers,
		},
	});
	
	if (!res.ok) {
		const error = await res.json().catch(() => ({ error: 'Unknown error' }));
		throw new Error(error.error || `HTTP ${res.status}`);
	}
	
	return res.json();
}

export async function getStats(): Promise<Stats> {
	return fetchApi<Stats>('/api/stats');
}

export async function getThoughts(params: {
	limit?: number;
	type?: ThoughtType | null;
	topic?: string | null;
	person?: string | null;
	days?: number;
	search?: string;
}): Promise<Thought[]> {
	const searchParams = new URLSearchParams();
	if (params.limit) searchParams.set('limit', params.limit.toString());
	if (params.type) searchParams.set('type', params.type);
	if (params.topic) searchParams.set('topic', params.topic);
	if (params.person) searchParams.set('person', params.person);
	if (params.days) searchParams.set('days', params.days.toString());
	
	let endpoint = `/api/thoughts?${searchParams}`;
	
	if (params.search) {
		searchParams.set('q', params.search);
		endpoint = `/api/search?${searchParams}`;
	}
	
	const data = await fetchApi<ApiThought[]>(endpoint);
	return data.map(t => ({
		id: t.id,
		content: t.content,
		metadata: t.metadata,
		created_at: t.created_at,
	}));
}

export async function captureThought(content: string): Promise<Thought> {
	return fetchApi<Thought>('/api/thoughts', {
		method: 'POST',
		body: JSON.stringify({ content }),
	});
}
