import { Component, type ErrorInfo, type ReactNode } from 'react';

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
        <div className="error" role="alert">
          Something went wrong on this page.
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}
