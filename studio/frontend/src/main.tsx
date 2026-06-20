import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './app/AppContext';
import { Workbench } from './app/Workbench';
import { Toaster } from './components/ui/sonner';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <Toaster />
      <Workbench />
    </AppProvider>
  </StrictMode>,
);
