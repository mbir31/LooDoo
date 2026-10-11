import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Last line of defence for a production game: a render crash must never leave
 * players staring at a blank white page. Shows a friendly bilingual recovery
 * screen instead, with one-tap reload / hard-reset.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[loodoo] render crash:', error, info?.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-[100dvh] bg-black text-neutral-100 flex flex-col items-center justify-center p-6 text-center gap-4 selection:bg-amber-500 selection:text-neutral-950"
      >
        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-red-500 via-amber-500 to-emerald-500 p-1 flex items-center justify-center shadow-2xl shadow-amber-500/20">
          <div className="w-full h-full bg-black rounded-[18px] flex items-center justify-center text-4xl">
            🎲
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-black bg-gradient-to-r from-red-400 via-amber-300 to-emerald-400 bg-clip-text text-transparent">
            Oops! কিছু একটা সমস্যা হয়েছে
          </h1>
          <p className="text-sm text-neutral-400 mt-2 max-w-sm">
            The game hit an unexpected error, but your match is safe. Reload to jump
            right back in.
          </p>
          <p className="text-xs text-neutral-500 mt-1 max-w-sm">
            একটি অপ্রত্যাশিত ত্রুটি ঘটেছে। ম্যাচ সুরক্ষিত আছে — রিলোড করে আবার খেলুন।
          </p>
        </div>

        {this.state.error?.message && (
          <code className="text-[10px] text-neutral-500 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-1.5 max-w-md truncate">
            {this.state.error.message}
          </code>
        )}

        <div className="flex items-center gap-2.5 mt-1">
          <button
            onClick={this.handleReset}
            className="px-5 py-3 rounded-2xl bg-neutral-950 hover:bg-neutral-900 border border-neutral-800 text-neutral-200 font-bold text-sm flex items-center gap-2 cursor-pointer transition-all active:scale-95"
          >
            Try Again / আবার চেষ্টা
          </button>
          <button
            onClick={this.handleReload}
            className="px-5 py-3 rounded-2xl bg-gradient-to-r from-red-600 via-amber-500 to-emerald-600 hover:brightness-110 text-white font-black text-sm flex items-center gap-2 cursor-pointer transition-all active:scale-95 shadow-lg shadow-amber-500/25"
          >
            Reload Game / রিলোড
          </button>
        </div>
      </div>
    );
  }
}
