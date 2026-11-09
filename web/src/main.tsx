import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root mount point in index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
