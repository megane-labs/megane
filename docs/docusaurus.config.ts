import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import path from "path";
import { fileURLToPath } from "url";
import spectralTheme from "./src/prism/spectralTheme";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: Config = {
  title: "megane",
  tagline: "Spectacles for atomistic data",
  favicon: "logo.png",
  url: "https://megane-labs.github.io",
  baseUrl: "/megane/",
  organizationName: "megane-labs",
  projectName: "megane",
  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  staticDirectories: ["public"],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  presets: [
    [
      "classic",
      {
        docs: {
          path: "docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: "Megane",
      logo: {
        alt: "Megane",
        src: "logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "useSidebar",
          position: "left",
          label: "Use",
        },
        {
          type: "docSidebar",
          sidebarId: "buildSidebar",
          position: "left",
          label: "Build",
        },
        {
          type: "docSidebar",
          sidebarId: "developSidebar",
          position: "left",
          label: "Develop",
        },
        {
          type: "docSidebar",
          sidebarId: "referenceSidebar",
          position: "left",
          label: "Reference",
        },
        {
          type: "docSidebar",
          sidebarId: "benchSidebar",
          position: "left",
          label: "Benchmark",
        },
        { to: "/gallery", label: "Gallery", position: "left" },
        {
          href: "https://megane-labs.github.io/megane/app/",
          label: "Demo",
          position: "left",
        },
        {
          type: "docSidebar",
          sidebarId: "apiSidebar",
          position: "left",
          label: "API",
        },
        {
          href: "https://github.com/megane-labs/megane",
          label: "GitHub",
          position: "right",
        },
        {
          href: "https://pypi.org/project/megane/",
          label: "PyPI",
          position: "right",
        },
        {
          href: "https://www.npmjs.com/package/megane-viewer",
          label: "npm",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      copyright: "Released under the MIT License.",
    },
    prism: {
      // Dark code blocks on both surfaces — one spectral theme for both modes.
      theme: spectralTheme,
      darkTheme: spectralTheme,
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
    },
    zoom: {
      background: {
        light: "rgba(246, 247, 249, 0.96)",
        dark: "rgba(10, 12, 16, 0.96)",
      },
    },
  } satisfies Preset.ThemeConfig,

  themes: [
    "@docusaurus/theme-mermaid",
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      { hashed: true, language: ["en"] },
    ],
  ],

  plugins: [
    "docusaurus-plugin-image-zoom",
    function customWebpack() {
      return {
        name: "custom-webpack",
        configureWebpack() {
          return {
            resolve: {
              alias: {
                "@": path.resolve(__dirname, "../src"),
              },
            },
          };
        },
      };
    },
  ],
};

export default config;
