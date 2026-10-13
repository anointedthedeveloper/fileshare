/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Inter Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        paper: '#fafaf9',
        ink: { DEFAULT: '#1c1917', soft: '#44403c', muted: '#78716c', faint: '#a8a29e' },
        line: { DEFAULT: '#e7e5e4', strong: '#d6d3d1' },
        accent: { DEFAULT: '#2f6f73', hover: '#265b5f', soft: '#eef5f5', ring: '#b9d6d7' },
        warn: { DEFAULT: '#a16207', soft: '#fefce8', line: '#fde68a' },
        danger: { DEFAULT: '#b42318', soft: '#fef3f2', line: '#fecdca' },
        ok: { DEFAULT: '#2f7d4f', soft: '#f0f8f3' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(28,25,23,0.04), 0 1px 1px rgba(28,25,23,0.03)',
        pop: '0 8px 24px -6px rgba(28,25,23,0.12), 0 2px 6px rgba(28,25,23,0.05)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(8px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'draw': { '0%': { 'stroke-dashoffset': '48' }, '100%': { 'stroke-dashoffset': '0' } },
        'pop-in': { '0%': { opacity: '0', transform: 'scale(0.9)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        'sheen': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(250%)' } },
        'breathe': { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-3px)' } },
        'toast': { '0%': { opacity: '0', transform: 'translateY(8px)' }, '10%,85%': { opacity: '1', transform: 'translateY(0)' }, '100%': { opacity: '0', transform: 'translateY(4px)' } },
      },
      animation: {
        'fade-up': 'fade-up .5s cubic-bezier(.2,.7,.2,1) both',
        'fade-in': 'fade-in .4s ease both',
        draw: 'draw .55s .15s cubic-bezier(.6,0,.2,1) both',
        'pop-in': 'pop-in .35s cubic-bezier(.2,.8,.2,1) both',
        sheen: 'sheen 1.8s ease-in-out infinite',
        breathe: 'breathe 3.2s ease-in-out infinite',
        toast: 'toast 2.2s ease both',
      },
    },
  },
  plugins: [],
};
