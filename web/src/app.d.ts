/// <reference types="@sveltejs/kit" />

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	interface ImportMetaEnv {
		PUBLIC_MCP_URL: string;
		PUBLIC_MCP_KEY: string;
	}

	interface ImportMeta {
		env: ImportMetaEnv;
	}
}

export {};
