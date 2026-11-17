// Applies the saved light/dark choice before the page paints.
try { var t = localStorage.getItem('kt-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
