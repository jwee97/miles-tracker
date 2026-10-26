import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { bootstrapToken } from './api';
import './styles.css';

// Before the first render: the screens ask for their data as they mount, and
// they must ask with the token from the link just opened, not an old stored one.
bootstrapToken();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
