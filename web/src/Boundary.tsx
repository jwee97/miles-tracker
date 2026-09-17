import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * What a crash should look like.
 *
 * React unmounts the whole tree when a render throws, so one bad date in one
 * list takes the entire app with it and the result is a blank page — the single
 * least diagnosable failure there is, for the person using it and for whoever
 * has to fix it. This turns that into a message with the error in it, and
 * leaves the tab bar alone so the rest of the app is still reachable.
 */
export default class Boundary extends Component<
  { children: ReactNode; where: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.where} failed to render`, error, info.componentStack);
  }

  // A different tab is a different screen: coming back to a broken one should
  // try again rather than stay broken for the rest of the session.
  componentDidUpdate(prev: { where: string }) {
    if (prev.where !== this.props.where && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card">
        <h2>This screen could not be drawn</h2>
        <p className="sub">
          Something in {this.props.where} threw while rendering. The rest of the app still works — the tabs above are
          fine.
        </p>
        <p className="err-text mono">{this.state.error.message}</p>
        <div className="entry-foot">
          <button className="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </section>
    );
  }
}
