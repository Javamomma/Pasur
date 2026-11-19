import { createRoot } from 'react-dom/client';
import Home from './app/page';
import { ErrorBoundary } from './app/error-boundary';
import './app/globals.css';
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <Home />
  </ErrorBoundary>,
);
