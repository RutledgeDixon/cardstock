import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './style.css';

createRoot(document.getElementById('root')!).render(
  // StrictMode double-invokes effects in development; the boot effect guards on
  // core.current so the viewer and worker are created exactly once.
  <StrictMode>
    <App />
  </StrictMode>,
);
