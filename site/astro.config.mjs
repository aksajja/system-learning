// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { REPO_URL } from './src/consts';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'System Design Lab',
			description: 'System design interview prep, learned by building the parts interviewers probe.',
			social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
			editLink: { baseUrl: `${REPO_URL}/edit/main/site/` },
			lastUpdated: false,
			sidebar: [
				{ label: 'Start here', link: '/' },
				{ label: 'Load balancer', items: [{ autogenerate: { directory: 'load-balancer' } }] },
				{ label: 'Rate limiter', items: [{ autogenerate: { directory: 'rate-limiter' } }] },
				{ label: 'Chat system', items: [{ autogenerate: { directory: 'chat-system' } }] },
				{ label: 'Side topics', items: [{ autogenerate: { directory: 'misc' } }] },
			],
		}),
	],
});
