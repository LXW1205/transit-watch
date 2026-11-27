import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import 'leaflet/dist/leaflet.css';

// Design language: neumorphism · ch-scrapbook (docs/DESIGN.md).
// Tokens first, then the recipe layers, then the product styles that consume them.
import '@fontsource/cinzel/500.css';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/600.css';
import '@fontsource/space-mono/400.css';
import './design/tokens.css';
import './design/motion.css';
import './design/charts.css';
import './styles.css';

import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root mount point in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
