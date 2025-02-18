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
        border: "hsl(let(--border))",
        background: "hsl(let(--background))",
        foreground: "hsl(let(--foreground))",
        muted: {
          DEFAULT: "hsl(let(--muted))",
          foreground: "hsl(let(--muted-foreground))",
        },
        'input-dark': 'hsl(240 10% 4% / 1)',
      },
    },
  },
  plugins: [],
} 