/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0d1117',
        surface: '#161b22',
        border: '#30363d',
        muted: '#8b949e',
        accent: '#58a6ff',
        success: '#3fb950',
        warning: '#d29922',
        error: '#f85149',
        text: '#c9d1d9',
        'text-bright': '#f0f6fc',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
