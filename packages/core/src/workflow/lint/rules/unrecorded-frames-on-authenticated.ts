import type { WorkflowFile } from '@yantra/protocol';

import type { LintFinding, LintRule } from '../index.js';

export const unrecordedFramesOnAuthenticated: LintRule = {
  name: 'UnrecordedFramesOnAuthenticated',
  check(workflow: WorkflowFile): LintFinding[] {
    const findings: LintFinding[] = [];

    if (workflow._unrecorded_frames.length > 0 && workflow.security_class !== 'public') {
      findings.push({
        code: 'UnrecordedFramesOnAuthenticated',
        severity: 'warning',
        path: '_unrecorded_frames',
        message: `Workflow has ${workflow._unrecorded_frames.length} unrecorded cross-origin frame(s) but security_class is "${workflow.security_class}". Unrecorded frames may contain sensitive interactions.`,
        suggestion:
          'Review the unrecorded frames to ensure no sensitive actions were missed. Consider re-recording with proper frame instrumentation.',
      });
    }

    return findings;
  },
};
