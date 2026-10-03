/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter Variable", "Segoe UI", "system-ui", "sans-serif"] },
      keyframes: {
        "fade-in": { from: { opacity: 0, transform: "translateY(4px)" }, to: { opacity: 1, transform: "translateY(0)" } }
      },
      animation: { "fade-in": "fade-in 0.2s ease-out" }
    }
  },
  plugins: []
}
