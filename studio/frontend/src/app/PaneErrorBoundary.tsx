import { Component, type ReactNode } from 'react';

interface IPaneErrorBoundaryProps {
  children: ReactNode;
}
interface IPaneErrorBoundaryState {
  error: Error | null;
}

export class PaneErrorBoundary extends Component<
  IPaneErrorBoundaryProps,
  IPaneErrorBoundaryState
> {
  state: IPaneErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div data-testid="pane-error" style={{ padding: 12 }}>
          This pane failed to render.
        </div>
      );
    }
    return this.props.children;
  }
}
