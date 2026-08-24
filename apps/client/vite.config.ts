import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// BASE_PATH задаёт CI: на GitHub Pages сайт живёт по подпути /dottony/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  build: {
    rollupOptions: {
      /*
       * Две страницы: сам прибор и служебный пульт.
       *
       * Пульт живёт отдельной страницей, а не разделом кабинета: это
       * инструмент за столом — поиск, списки, журнал, — и в окуляр шириной
       * с телефон он не влезает. Заодно игровая сборка от него не толстеет:
       * общий у них только каталог из ядра и отрисовка шильдиков.
       */
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});
