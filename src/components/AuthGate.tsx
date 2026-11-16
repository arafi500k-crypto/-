import { useState } from 'react';
import { AlertCircle, Check, Copy, Lock, ShieldCheck } from 'lucide-react';
import { FIREBASE_PROJECT_ID } from '../lib/firebase';
import { MoonLogo } from './MoonLogo';

interface AuthGateProps {
  onSignIn: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function AuthGate({ onSignIn, loading, error }: AuthGateProps) {
  const [copiedHost, setCopiedHost] = useState(false);
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const isDomainError = Boolean(error && error.includes('Authorized domains'));

  const handleCopyHost = async () => {
    if (!currentHost || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(currentHost);
      setCopiedHost(true);
      setTimeout(() => setCopiedHost(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  return (
    <div className="min-h-screen bg-[#09090D] flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-lg glass-panel rounded-2xl p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-3.5">
          <MoonLogo className="w-11 h-11 shrink-0" />
          <div>
            <h1 className="font-display text-xl sm:text-2xl font-semibold text-zinc-100 tracking-tight">
              MoonLight Gang Analytics
            </h1>
            <p className="text-sm text-zinc-400">
              TikTok Group Chat Message Monitoring · Asia/Dhaka
            </p>
          </div>
        </div>

        <div className="space-y-3 text-sm text-zinc-300 leading-relaxed border-t border-b border-violet-300/10 py-5">
          <p>
            Sign in with your verified Google account to access real-time message counts, member activity rankings, historical logs, and the Admin Panel.
          </p>
          <div className="flex items-start gap-2.5 text-xs text-zinc-400">
            <ShieldCheck className="w-4 h-4 text-violet-300 shrink-0 mt-0.5" />
            <span>
              Protected by Firebase Authentication and Cloud Firestore security rules. Only authorized message events or admin-verified entries are counted.
            </span>
          </div>
          <div className="flex items-start gap-2.5 text-xs text-zinc-400">
            <Lock className="w-4 h-4 text-violet-300 shrink-0 mt-0.5" />
            <span>
              No scraping or unofficial TikTok APIs are used. Metadata-only storage preserves group privacy.
            </span>
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-400/25 p-3.5 text-xs text-red-200 space-y-2.5">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            {isDomainError && currentHost && (
              <div className="pl-6 flex flex-wrap items-center gap-2">
                <code className="px-2 py-1 rounded bg-black/40 border border-red-400/20 font-mono-tabular text-red-100 select-all">
                  {currentHost}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyHost()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100 transition-colors"
                >
                  {copiedHost ? <Check className="w-3 h-3 text-emerald-300" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedHost ? 'Copied' : 'Copy domain'}</span>
                </button>
                <a
                  href={`https://console.firebase.google.com/project/${FIREBASE_PROJECT_ID}/authentication/settings`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-violet-300 hover:text-violet-200"
                >
                  Open Firebase Auth Settings
                </a>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => void onSignIn()}
          disabled={loading}
          className="w-full min-h-[44px] py-3 px-5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white font-medium text-sm transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
        >
          {loading ? 'Signing in...' : 'Sign in with Google'}
        </button>
      </div>
    </div>
  );
}
