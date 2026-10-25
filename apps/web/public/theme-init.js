// Applies the saved theme before first paint. Kept as a same-origin file so the CSP needs no 'unsafe-inline' scripts.
(() => { const t = localStorage.getItem('markroot-theme'); const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; })();
