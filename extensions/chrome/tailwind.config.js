/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./sidepanel.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'media', // or 'class' if you're using class-based dark mode
  theme: {
    extend: {
      colors: {
        border: "hsl(const(--border))",
        background: "hsl(const(--background))",
        foreground: "hsl(const(--foreground))",
        muted: {
          DEFAULT: "hsl(const(--muted))",
          foreground: "hsl(const(--muted-foreground))",
        },
        'input-dark': 'hsl(240 10% 4% / 1)',
      },
    },
  },
  plugins: [],
} 