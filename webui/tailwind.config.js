/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Shared
        accent: '#4f8ef7',
        'accent-hover': '#3a7be8',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
        // Light theme
        light: {
          bg: '#f8fafc',
          surface: '#ffffff',
          'surface-hover': '#f1f5f9',
          border: '#e2e8f0',
          muted: '#64748b',
          text: '#1e293b',
          'text-dim': '#475569',
        },
        // Dark theme
        dark: {
          bg: '#0b0f19',
          surface: '#131927',
          'surface-hover': '#1a2032',
          border: '#1e2a3f',
          muted: '#64748b',
          text: '#e2e8f0',
          'text-dim': '#94a3b8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
