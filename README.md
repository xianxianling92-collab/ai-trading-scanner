# AI Trading Scanner

Versi standalone dari artifact Claude, siap di-deploy ke Netlify.

## Yang berubah dari versi artifact
- `window.storage` (khusus Claude) → diganti `localStorage` biasa.
- Panggilan langsung ke `https://api.anthropic.com` (yang hanya jalan tanpa API key di dalam Claude.ai) → diganti panggilan ke Netlify Function `/.netlify/functions/claude-proxy`, yang menyimpan API key Anthropic dengan aman di server (env var), bukan di browser.

## Cara jalan di komputer sendiri
```bash
npm install
npm run dev
```
Fitur "AI Web Search" dan "Analisis AI" butuh function Netlify, jadi untuk tes penuh lokal pakai:
```bash
npm install -g netlify-cli
netlify dev
```

## Deploy ke Netlify
1. Push folder ini ke repo GitHub (atau pakai `netlify deploy` dari CLI langsung tanpa Git).
2. Di Netlify: **Add new site → Import an existing project**, pilih repo ini.
   - Build command: `npm run build` (sudah diatur di `netlify.toml`)
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
3. Di **Site settings → Environment variables**, tambahkan:
   - `ANTHROPIC_API_KEY` = API key Anthropic kamu (dari console.anthropic.com)
4. Deploy. Fitur "AI Web Search" dan "Analisis AI" akan otomatis lewat function tadi.

Kalau kamu tidak mau pakai fitur AI, tinggal matikan provider "AI Web Search (Claude)" di panel Sumber Data dalam aplikasi, dan jangan pakai tombol "Analisis AI" — sisanya (Yahoo Finance, Finnhub, Alpha Vantage, Polygon) jalan langsung dari browser tanpa perlu API key Anthropic.

## Catatan tentang proxy CORS publik
Data historis (Yahoo/Finnhub/dst) lewat proxy CORS publik (allorigins, codetabs, dst) karena situs sumbernya tidak mengizinkan fetch langsung dari browser. Proxy publik ini kadang down/limit — kalau semua provider gagal, cek panel "Diagnostik Koneksi" di dalam app, atau pertimbangkan pasang API key sendiri (Finnhub/Alpha Vantage/Polygon punya tier gratis).

## Struktur
```
├── src/
│   ├── App.jsx          # komponen utama (scanner)
│   ├── main.jsx         # entry point React
│   └── index.css        # Tailwind directives
├── netlify/functions/
│   └── claude-proxy.js  # proxy aman ke Anthropic API
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── netlify.toml
```

Disclaimer: aplikasi ini alat bantu analisis teknikal otomatis, bukan nasihat keuangan. Selalu riset & kelola risiko sendiri.
