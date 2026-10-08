// @ts-check
import { readdirSync, readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { REPO_URL } from './src/consts';

const lessonsDir = new URL('../lessons/', import.meta.url);

/**
 * Sidebar links for one lessons/ folder, sorted by each page's `sidebar.order`.
 * Starlight's own `autogenerate` only finds pages under src/content/docs/, and
 * our lessons live in ../lessons, so we list them ourselves. Labels come from
 * each page's title.
 * @param {string} dir folder inside lessons/, e.g. "load-balancer"
 */
function lessonsIn(dir) {
	return readdirSync(new URL(`${dir}/`, lessonsDir))
		.filter((file) => /^[^_].*\.mdx?$/.test(file))
		.map((file) => {
			const source = readFileSync(new URL(`${dir}/${file}`, lessonsDir), 'utf8');
			const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
			const order = Number(frontmatter.match(/^sidebar:\n(?:\s+.*\n)*?\s+order:\s*(\d+)/m)?.[1] ?? Infinity);
			return { slug: `${dir}/${file.replace(/\.mdx?$/, '')}`, order };
		})
		.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
		.map(({ slug }) => ({ slug }));
}

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'System Design Lab',
			description: 'System design interview prep, learned by building the parts interviewers probe.',
			social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
			editLink: { baseUrl: `${REPO_URL}/edit/main/site/` },
			lastUpdated: false,
			components: { Footer: './src/components/Footer.astro' },
			sidebar: [
				{ label: 'Start here', link: '/' },
				{ label: 'Load balancer', items: lessonsIn('load-balancer') },
				{ label: 'Rate limiter', items: lessonsIn('rate-limiter') },
				{ label: 'Chat system', items: lessonsIn('chat-system') },
				{ label: 'Side topics', items: lessonsIn('misc') },
			],
		}),
	],
});
