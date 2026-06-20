import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './app/AppContext';
import { SessionProvider } from './session/SessionContext';
import { AppRoutes } from './app/routes/AppRoutes';
import { Toaster } from './components/ui/sonner';
import { SessionSync } from './app/SessionSync';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <SessionProvider>
        <SessionSync />
        <Toaster />
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </SessionProvider>
    </AppProvider>
  </StrictMode>,
);
