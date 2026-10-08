// Checks internal links in the built site (dist/): every href="/path/#anchor"
// must point to a built page, and the anchor must exist on that page.
// Runs after `astro build` (see "postbuild" in package.json); exits 1 on any broken link.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;

function htmlFiles(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
	);
}

// Only look inside the page's main content, not the sidebar/header Starlight generates.
const mainOf = (html) => html.match(/<main[\s\S]*<\/main>/)?.[0] ?? html;
const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const pageFor = (path) => join(dist, path, path.endsWith('.html') ? '' : 'index.html');

let broken = 0;
for (const file of htmlFiles(dist)) {
	const page = '/' + relative(dist, file).replace(/index\.html$/, '');
	const html = readFileSync(file, 'utf8');
	for (const [, href] of mainOf(html).matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
		if (/^(https?:|mailto:|\/\/)/.test(href)) continue; // external
		const [path, hash] = href.split('#');
		const target = path === '' ? file : pageFor(path);
		if (!existsSync(target)) {
			console.error(`${page}: broken link ${href}`);
			broken++;
		} else if (hash && !idsOf(readFileSync(target, 'utf8')).has(decodeURIComponent(hash))) {
			console.error(`${page}: missing anchor ${href}`);
			broken++;
		}
	}
}
if (broken) {
	console.error(`\n${broken} broken link(s)`);
	process.exit(1);
}
console.log('links ok');
