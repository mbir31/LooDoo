import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Register the Service Worker that powers the offline shell / 1-tap install.
// `process.env.NODE_ENV` is not part of the browser bundle in Vite, so the
// registration must key off `import.meta.env.PROD` (which Vite statically
// replaces) - otherwise the worker is registered in dev or never in prod.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.log('SW registration note:', err);
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

