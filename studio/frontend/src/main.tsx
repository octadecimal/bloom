import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbench } from './app/Workbench';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);
