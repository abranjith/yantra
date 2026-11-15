import type { ConfirmationDecidedBy, DecisionResponse } from '@yantra/protocol';

export function decisionMessage(response: DecisionResponse): string {
  switch (response.status) {
    case 'accepted':
      return response.decision.decision === 'granted' ? 'Approved' : 'Denied';
    case 'already_decided':
      return `Already ${response.decision} by ${provenance(response.decided_by)} at ${response.decided_at}`;
    case 'expired':
      return `Too late: the request timed out at ${response.decided_at}`;
    case 'stale':
      return 'This run is no longer waiting for this approval';
  }
}

function provenance(value: ConfirmationDecidedBy): string {
  switch (value) {
    case 'user_app':
      return 'the app';
    case 'user_cli_confirm':
      return 'yantra confirm';
    case 'user_interactive':
      return 'this terminal';
    case 'timeout':
      return 'timeout';
  }
}
