import { defineConfig } from 'vite';

// BASE_PATH задаёт CI: на GitHub Pages сайт живёт по подпути /dottony/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
});
