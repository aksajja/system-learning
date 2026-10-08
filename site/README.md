# Site

The [Astro Starlight](https://starlight.astro.build) site for this repo. It has no content of its own: pages come from [`../lessons`](../lessons) (see `src/content.config.ts`).

```sh
npm install
npm run dev       # http://localhost:4321, reloads as you edit lessons
npm run build     # static site in dist/
```

- `src/consts.ts`: the GitHub repo name (used for the "Open this lab" and "Edit page" links).
- `src/components/OpenLab.astro`: the "Open this lab" button (GitHub Codespaces).
- `src/components/mdx.ts`: components lessons can import in `.mdx` files.

## Deploying (Cloudflare Workers)

`wrangler.jsonc` deploys `dist/` as static files. Cloudflare build settings: root directory `site`, build command `npm run build`, deploy command `npx wrangler deploy`. The Worker's name in the dashboard must match `name` in `wrangler.jsonc`.
