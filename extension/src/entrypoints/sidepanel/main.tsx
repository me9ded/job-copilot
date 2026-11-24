import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Panel } from '../../ui/panel/Panel';
import '../../ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
