import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Lessons live in the repo root (../lessons), not in src/content/docs,
// so they sit next to the experiments they describe.
export const collections = {
	docs: defineCollection({
		loader: glob({ base: '../lessons', pattern: '**/[^_]*.{md,mdx}' }),
		schema: docsSchema(),
	}),
};
