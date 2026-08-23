import type { WorkflowStep } from '../server/linkedin/workflows';
import type { CampaignQueueSummary } from '../server/linkedin/managed-campaigns';

export const ACTION_LABEL: Record<WorkflowStep['action'], string> = {
  profile_view: 'View their profile',
  connection_request: 'Send a connection request',
  message: 'Send a message',
  manual_message: 'A message you write yourself',
  follow: 'Follow them',
  unfollow: 'Unfollow them',
  disconnect: 'Remove the connection',
  follow_company: 'Follow company',
  like_company_post: 'Like company post',
  invite_to_follow_company: 'Invite to follow company',
  invite_to_event: 'Invite to event',
  invite_to_group: 'Invite to group',
  group_message: 'Group message',
  event_message: 'Event message',
  withdraw_pending: 'Withdraw the invite if still pending',
  like_post: 'Like a recent post',
  endorse_skills: 'Endorse skills',
  wait: 'Wait',
  condition: 'Condition',
  monitor: 'Monitor',
  end: 'End',
  inmail: 'InMail',
  email: 'Email',
  find_email: 'Find email',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  manual_comment: 'Manual comment'
};

export function campaignStepProgress(
  steps: readonly WorkflowStep[],
  backlog: CampaignQueueSummary['backlogByStep']
): Array<{ stepId: string; label: string; count: number; due: number }> {
  const byStep = new Map(backlog.map((entry) => [entry.stepId, entry]));
  return steps.map((step) => {
    const entry = byStep.get(step.id);
    return {
      stepId: step.id,
      label: ACTION_LABEL[step.action],
      count: entry?.count ?? 0,
      due: entry?.due ?? 0
    };
  });
}
