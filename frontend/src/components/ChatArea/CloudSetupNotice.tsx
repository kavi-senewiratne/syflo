/**
 * components/ChatArea/CloudSetupNotice.tsx
 *
 * Guided empty state (ADR-0008 decision 12b, redesigned per
 * mockup-model-cost-tiers W9, 2026-07-30): the active provider has no key
 * — instead of pitching ONE provider (a fresh install has them all), the
 * card offers the three PATHS with their cost tier in the row title:
 * start for free (Gemini/Groq free tier), use your own account
 * (OpenAI/Claude/Gemini Pro), or fully private (local model). Each row
 * opens Settings with the matching provider preselected. This also fixes
 * the old copy bug: the CTA promised a "free API key" even for providers
 * that have none.
 *
 * Standard theme tokens only (bg-blue-50/60 + border-blue-100, the pattern
 * of the Settings guide block) so all five themes work unchanged.
 */

import { Cpu, Gem, Info, Zap } from 'lucide-react';
import { useStrings } from '../../strings';
import type { LLMProvider } from '../../types';

interface Props {
  // Opens Settings on the model tab with the given provider preselected.
  onOpenSettings: (provider: LLMProvider) => void;
}

export function CloudSetupNotice({ onOpenSettings }: Props) {
  const S = useStrings().chatArea.cloudSetup;
  const paths: {
    id: string;
    provider: LLMProvider;
    icon: typeof Zap;
    title: string;
    sub: string;
  }[] = [
    { id: 'free', provider: 'gemini', icon: Zap, title: S.pathFree, sub: S.pathFreeSub },
    { id: 'paid', provider: 'openai', icon: Gem, title: S.pathPaid, sub: S.pathPaidSub },
    { id: 'local', provider: 'ollama', icon: Cpu, title: S.pathLocal, sub: S.pathLocalSub },
  ];
  return (
    <div
      className="rounded-xl bg-blue-50/60 border border-blue-100 p-4 space-y-3"
      data-testid="cloud-setup-notice"
    >
      <div className="flex items-start gap-2">
        <Info size={15} className="text-blue-600 mt-0.5 shrink-0" />
        <div className="text-sm text-gray-700">
          <p className="font-semibold text-gray-900 mb-1">{S.title}</p>
          <p className="text-[13px] leading-relaxed">{S.body}</p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {paths.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpenSettings(p.provider)}
            data-testid={`setup-path-${p.id}`}
            className="w-full flex items-center gap-2.5 rounded-lg border border-blue-100 bg-white px-3 py-2 text-left transition-colors hover:bg-blue-50"
          >
            <p.icon size={14} className={`shrink-0 ${p.id === 'free' ? 'text-blue-600' : 'text-gray-400'}`} />
            <span className="text-[13px] font-semibold text-gray-900">{p.title}</span>
            <span className="text-[12px] text-gray-500">{p.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
