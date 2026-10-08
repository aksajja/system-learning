// Components for lessons written in MDX. Lessons live outside site/, so they
// import from here (e.g. '../../site/src/components/mdx') rather than from
// '@astrojs/starlight/components', which only resolves inside site/.
export { Aside, Card, CardGrid, LinkButton, LinkCard, Steps, TabItem, Tabs } from '@astrojs/starlight/components';
export { default as OpenLab } from './OpenLab.astro';
