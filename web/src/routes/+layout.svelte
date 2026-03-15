<script>
	import '../app.css';
	
	let { children } = $props();
</script>

<div class="min-h-screen flex flex-col">
	<header class="border-b border-white/10 bg-bg-elevated/50 backdrop-blur-sm sticky top-0 z-50">
		<div class="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
			<a href="/" class="flex items-center gap-3">
				<span class="text-2xl">🧠</span>
				<h1 class="text-xl font-bold">Open Brain</h1>
			</a>
			<a href="https://github.com/headcrest/open-brain" target="_blank" rel="noopener" class="text-text-muted hover:text-text transition-colors text-sm">
				GitHub
			</a>
		</div>
	</header>
	
	<main class="flex-1">
		{@render children()}
	</main>
	
	<footer class="border-t border-white/10 py-6 text-center text-text-muted text-sm">
		<p>Open Brain • Capture and search your thoughts</p>
	</footer>
</div>
