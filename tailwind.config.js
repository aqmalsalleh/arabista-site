// tailwind.config.js
module.exports = {
  content: ["./index.html", "./product-d01.html"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Cormorant Garamond"', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui'],
      },
      colors: {
        brand: { DEFAULT: '#0F0F10' },
        ink: { DEFAULT: '#111213' },
        luxe: { DEFAULT: '#C0A062' },
      },
      boxShadow: { soft: '0 10px 30px rgba(0,0,0,0.08)' },
    },
  },
  plugins: [],
};
