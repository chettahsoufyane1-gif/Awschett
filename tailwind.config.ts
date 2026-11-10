import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Cairo", "Tajawal", "Segoe UI", "Tahoma", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      colors: {
        night: {
          950: "#070a17",
          900: "#0b1020",
          850: "#0f1530",
          800: "#141b3d",
          700: "#1d2652",
        },
      },
    },
  },
  plugins: [],
};
export default config;
