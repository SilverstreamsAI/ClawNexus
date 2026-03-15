import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  esbuild: {
    jsxFactory: "h",
    jsxFragment: "Fragment",
  },
  server: {
    port: 3001,
    proxy: {
      "/instances": "http://localhost:17890",
      "/agent": "http://localhost:17890",
      "/diagnostics": "http://localhost:17890",
      "/scan": "http://localhost:17890",
      "/health": "http://localhost:17890",
      "/a2a": "http://localhost:17890",
      "/whoami": "http://localhost:17890",
      "/registry": "http://localhost:17890",
      "/relay": "http://localhost:17890",
      "/resolve": "http://localhost:17890",
    },
  },
});
