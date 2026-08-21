export type ActivationStepId = 'agent' | 'source' | 'policy' | 'work';

export interface ActivationSignals {
  agent: boolean | null;
  source: boolean | null;
  policy: boolean | null;
  work: boolean | null;
}

export interface ActivationStep {
  id: ActivationStepId;
  title: string;
  detail: string;
  action: string;
  href: string | null;
}

export const ACTIVATION_STEPS: readonly ActivationStep[] = [
  {
    id: 'agent',
    title: 'Connect an agent',
    detail: 'Give Claude Code, Codex, or Trevra’s hosted agent access to this workspace.',
    action: 'Connect an agent',
    href: '/setup'
  },
  {
    id: 'source',
    title: 'Connect a source',
    detail: 'Connect a commercial data source or a LinkedIn seat so work can use real evidence.',
    action: 'Connect a source',
    href: '/setup/workspace'
  },
  {
    id: 'policy',
    title: 'Set the approval boundary',
    detail: 'Enable at least one policy that says what must stop for your decision.',
    action: 'Set approval boundary',
    href: '/setup/workspace'
  },
  {
    id: 'work',
    title: 'Plan the first job',
    detail:
      'Describe one bounded GTM outcome. Trevra will show the plan before preparing anything.',
    action: 'Plan first job',
    href: null
  }
];

export type ActivationResolution =
  | { state: 'unknown'; step: ActivationStep }
  | { state: 'next'; step: ActivationStep }
  | { state: 'complete'; step: null };

export function nextActivationStep(signals: ActivationSignals): ActivationResolution {
  for (const step of ACTIVATION_STEPS) {
    const value = signals[step.id];
    if (value === null) return { state: 'unknown', step };
    if (!value) return { state: 'next', step };
  }
  return { state: 'complete', step: null };
}
