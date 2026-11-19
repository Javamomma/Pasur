import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

type State = { failed: boolean };

/** Safety net: a render error shows a plain message and a Reload button instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Pasur render error', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-shell">
        <div className="error-fallback" role="alert">
          <p>Something went wrong on this page.</p>
          <Button type="button" variant="secondary" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </main>
    );
  }
}
