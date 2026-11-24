import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Popup } from '../../ui/Popup';
import '../../ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
