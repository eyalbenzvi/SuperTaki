import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { initialiseAppearance } from './features/game/state/store.ts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/cards.css';
import './styles/screens.css';

initialiseAppearance();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container missing');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
