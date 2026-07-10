import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const projects = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		repoUrl: z.string().url(),
		date: z.coerce.date(),
		tags: z.array(z.string()).default([]),
	}),
});

export const collections = { projects };
