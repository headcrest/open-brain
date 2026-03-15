<script lang="ts">
	import { getStats, getThoughts, captureThought } from '$lib/api';
	import { THOUGHT_TYPES, type Thought, type ThoughtType } from '$lib/types';
	import { onMount } from 'svelte';

	let thoughts = $state<Thought[]>([]);
	let loading = $state(true);
	let searchQuery = $state('');
	let selectedType = $state<ThoughtType | null>(null);
	let selectedTopic = $state<string | null>(null);
	let selectedPerson = $state<string | null>(null);
	let allTopics = $state<string[]>([]);
	let allPeople = $state<string[]>([]);
	let stats = $state({ total: 0, types: {} as Record<string, number> });
	let showCapture = $state(false);
	let captureContent = $state('');
	let capturing = $state(false);

	let searchTimeout: ReturnType<typeof setTimeout>;

	onMount(async () => {
		await Promise.all([loadThoughts(), loadStats()]);
		loading = false;
	});

	async function loadThoughts() {
		try {
			thoughts = await getThoughts({
				type: selectedType,
				topic: selectedTopic,
				person: selectedPerson,
				search: searchQuery.trim() || undefined,
			});
			extractFilters();
		} catch (err) {
			console.error('Failed to load thoughts:', err);
		}
	}

	async function loadStats() {
		try {
			const s = await getStats();
			stats = s;
			allTopics = Object.keys(s.topics);
			allPeople = Object.keys(s.people);
		} catch (err) {
			console.error('Failed to load stats:', err);
		}
	}

	function extractFilters() {
		const topics = new Set<string>();
		const people = new Set<string>();
		for (const t of thoughts) {
			if (t.metadata.topics) t.metadata.topics.forEach(x => topics.add(x));
			if (t.metadata.people) t.metadata.people.forEach(x => people.add(x));
		}
		allTopics = Array.from(topics).sort();
		allPeople = Array.from(people).sort();
	}

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			loadThoughts();
		}, 300);
	}

	function filterByType(type: ThoughtType | null) {
		selectedType = type;
		loadThoughts();
	}

	function filterByTopic(topic: string | null) {
		selectedTopic = topic;
		loadThoughts();
	}

	function filterByPerson(person: string | null) {
		selectedPerson = person;
		loadThoughts();
	}

	function clearFilters() {
		selectedType = null;
		selectedTopic = null;
		selectedPerson = null;
		searchQuery = '';
		loadThoughts();
	}

	function formatDate(date: string): string {
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	async function handleCapture() {
		if (!captureContent.trim()) return;
		capturing = true;
		try {
			await captureThought(captureContent);
			captureContent = '';
			showCapture = false;
			await Promise.all([loadThoughts(), loadStats()]);
		} catch (err) {
			console.error('Failed to capture:', err);
		}
		capturing = false;
	}
</script>

<svelte:head>
	<title>Open Brain</title>
	<meta name="description" content="Visualize and search your captured thoughts" />
</svelte:head>

<div class="max-w-5xl mx-auto px-6 py-8">
	<!-- Header -->
	<div class="mb-8 flex items-center justify-between">
		<div class="flex items-center gap-6 text-sm text-text-muted">
			<span class="text-2xl font-bold text-text">{stats.total}</span>
			<span>thoughts captured</span>
		</div>
		<button
			onclick={() => showCapture = !showCapture}
			class="px-4 py-2 bg-primary hover:bg-primary-light text-white rounded-lg font-medium transition-colors"
		>
			+ Capture
		</button>
	</div>

	<!-- Capture Form -->
	{#if showCapture}
		<div class="mb-6 bg-bg-card border border-white/10 rounded-xl p-5">
			<textarea
				bind:value={captureContent}
				placeholder="What's on your mind?"
				rows={3}
				class="w-full bg-transparent text-text placeholder:text-text-muted focus:outline-none resize-none"
			></textarea>
			<div class="flex justify-end gap-3 mt-3">
				<button
					onclick={() => showCapture = false}
					class="px-4 py-2 text-text-muted hover:text-text transition-colors"
				>
					Cancel
				</button>
				<button
					onclick={handleCapture}
					disabled={!captureContent.trim() || capturing}
					class="px-4 py-2 bg-primary hover:bg-primary-light disabled:opacity-50 text-white rounded-lg font-medium transition-colors"
				>
					{capturing ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	{/if}

	<!-- Search -->
	<div class="mb-6">
		<div class="relative">
			<input
				type="text"
				bind:value={searchQuery}
				oninput={handleSearch}
				placeholder="Search thoughts..."
				class="w-full bg-bg-elevated border border-white/10 rounded-xl px-5 py-3.5 pl-12 text-text placeholder:text-text-muted focus:outline-none focus:border-primary transition-colors"
			/>
			<svg class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
		</div>
	</div>

	<!-- Type Filters -->
	<div class="mb-6">
		<div class="flex flex-wrap gap-2">
			<button
				onclick={() => filterByType(null)}
				class="px-4 py-2 rounded-full text-sm font-medium transition-all {!selectedType ? 'bg-primary text-white' : 'bg-bg-elevated text-text-muted hover:text-text'}"
			>
				All
			</button>
			{#each THOUGHT_TYPES as type}
				<button
					onclick={() => filterByType(type.value)}
					class="px-4 py-2 rounded-full text-sm font-medium transition-all flex items-center gap-2 {selectedType === type.value ? `bg-${type.color} text-white` : 'bg-bg-elevated text-text-muted hover:text-text'}"
				>
					<span class="w-2 h-2 rounded-full bg-{type.color}"></span>
					{type.label}
					{#if stats.types[type.value]}
						<span class="opacity-60">({stats.types[type.value]})</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	<!-- Active Filters -->
	{#if selectedType || selectedTopic || selectedPerson}
		<div class="mb-6 flex items-center gap-2 flex-wrap">
			<span class="text-text-muted text-sm">Filters:</span>
			{#if selectedType}
				<span class="inline-flex items-center gap-2 px-3 py-1 bg-primary/20 text-primary rounded-full text-sm">
					{THOUGHT_TYPES.find(t => t.value === selectedType)?.label}
					<button onclick={() => filterByType(null)} class="hover:text-white">×</button>
				</span>
			{/if}
			{#if selectedTopic}
				<span class="inline-flex items-center gap-2 px-3 py-1 bg-accent/20 text-accent rounded-full text-sm">
					{selectedTopic}
					<button onclick={() => filterByTopic(null)} class="hover:text-white">×</button>
				</span>
			{/if}
			{#if selectedPerson}
				<span class="inline-flex items-center gap-2 px-3 py-1 bg-person-note/20 text-person-note rounded-full text-sm">
					{selectedPerson}
					<button onclick={() => filterByPerson(null)} class="hover:text-white">×</button>
				</span>
			{/if}
			<button onclick={clearFilters} class="text-text-muted text-sm hover:text-text transition-colors">
				Clear all
			</button>
		</div>
	{/if}

	<!-- Loading -->
	{#if loading}
		<div class="flex items-center justify-center py-20">
			<div class="text-text-muted">Loading thoughts...</div>
		</div>
	{:else if thoughts.length === 0}
		<div class="text-center py-20">
			<div class="text-4xl mb-4">🧠</div>
			<div class="text-text-muted">No thoughts found</div>
			{#if searchQuery || selectedType || selectedTopic || selectedPerson}
				<button onclick={clearFilters} class="mt-4 text-primary hover:text-primary-light transition-colors">
					Clear filters
				</button>
			{/if}
		</div>
	{:else}
		<!-- Thoughts Grid -->
		<div class="grid gap-4">
			{#each thoughts as thought}
				<article class="bg-bg-card border border-white/5 rounded-xl p-5 hover:border-white/10 transition-colors">
					<div class="flex items-start justify-between gap-4 mb-3">
						<span class="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium bg-{thought.metadata.type || 'observation'}/20 text-{thought.metadata.type || 'observation'}">
							<span class="w-1.5 h-1.5 rounded-full bg-{thought.metadata.type || 'observation'}"></span>
							{THOUGHT_TYPES.find(t => t.value === thought.metadata.type)?.label || 'Thought'}
						</span>
						<time class="text-text-muted text-xs">{formatDate(thought.created_at)}</time>
					</div>
					
					<p class="text-text leading-relaxed">{thought.content}</p>
					
					{#if thought.metadata.topics?.length || thought.metadata.people?.length}
						<div class="mt-4 flex flex-wrap gap-2">
							{#each thought.metadata.topics || [] as topic}
								<button
									onclick={() => filterByTopic(topic)}
									class="px-2 py-0.5 bg-white/5 hover:bg-accent/20 hover:text-accent rounded text-xs text-text-muted transition-colors"
								>
									#{topic}
								</button>
							{/each}
							{#each thought.metadata.people || [] as person}
								<button
									onclick={() => filterByPerson(person)}
									class="px-2 py-0.5 bg-white/5 hover:bg-person-note/20 hover:text-person-note rounded text-xs text-text-muted transition-colors"
								>
									@{person}
								</button>
							{/each}
						</div>
					{/if}
					
					{#if thought.metadata.action_items?.length}
						<div class="mt-4 pt-4 border-t border-white/5">
							<div class="text-xs text-text-muted mb-2">Action items:</div>
							<ul class="text-sm text-text-muted space-y-1">
								{#each thought.metadata.action_items as item}
									<li class="flex items-start gap-2">
										<span class="text-task mt-1">○</span>
										<span>{item}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</div>
