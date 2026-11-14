import type { BriefAction } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { Button } from '../primitives/Button.js';

import { ProtectedValue } from './ProtectedValue.js';

/**
 * ActionEvidence (FEAT-066): the action mode of the evidence pane.
 *
 * Shows the action kind, its label with where the label came from and how
 * confident the engine was, the form section, the value-free target identity
 * (host, element ref, page epoch, tool call), and the verification verdict:
 * the `resolution` word verbatim, or for a withheld fill a ProtectedValue
 * with its reason and safe verdict. A refused submit shows its `signal`; a
 * capture links to its files. An action the run did not record says so.
 */

/** Shown when the run has no evidence for an action id. */
export const ACTION_NOT_RECORDED = 'Action evidence not recorded for this run';

function Field({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="type-label text-ink-2">{term}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

function Engine({ children }: { readonly children: ReactNode }) {
  return <span className="type-engine">{children}</span>;
}

export interface ActionEvidenceProps {
  /** The recorded action, or null when the run has none for this id. */
  readonly action: BriefAction | null;
  /** Opens the capture gallery at one file. */
  readonly onShowCapture?: (path: string) => void;
}

/** See the module comment. */
export function ActionEvidence({ action, onShowCapture }: ActionEvidenceProps): ReactNode {
  if (action === null) {
    return (
      <p data-evidence="action-missing" className="text-ink-2">
        {ACTION_NOT_RECORDED}
      </p>
    );
  }
  const verification = action.verification;
  return (
    <div data-evidence="action" data-action-id={action.id} className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        <Field term="Action">
          <Engine>{action.kind}</Engine>
        </Field>
        <Field term="Label">
          {action.label ?? 'No label recorded'}
          {action.label_origin === undefined ? null : (
            <span className="text-ink-2">
              {' '}
              (from <Engine>{action.label_origin}</Engine>
              {action.confidence === undefined ? null : (
                <>
                  , confidence <Engine>{action.confidence}</Engine>
                </>
              )}
              )
            </span>
          )}
        </Field>
        {action.section === undefined ? null : <Field term="Section">{action.section}</Field>}
        <Field term="Target">
          <span className="flex flex-wrap gap-x-3">
            <span>
              host <Engine>{action.host ?? 'not recorded'}</Engine>
            </span>
            <span>
              ref <Engine>{action.ref ?? 'not recorded'}</Engine>
            </span>
            <span>
              epoch <Engine>{action.epoch === null ? 'not recorded' : String(action.epoch)}</Engine>
            </span>
            <span>
              call <Engine>{action.call_id ?? 'not recorded'}</Engine>
            </span>
          </span>
        </Field>
        {verification === undefined ? null : (
          <Field term="Verification">
            {'withheld' in verification ? (
              <ProtectedValue
                reason={verification.withheld.reason}
                verdict={verification.withheld.verdict}
              />
            ) : (
              <Engine>{verification.resolution}</Engine>
            )}
          </Field>
        )}
        {action.signal === undefined ? null : (
          <Field term="Refused because">
            <Engine>{action.signal}</Engine>
          </Field>
        )}
      </dl>
      {action.artifacts === undefined ? null : (
        <ul aria-label="Captures" className="flex flex-col gap-1">
          {action.artifacts.map((artifact) => (
            <li key={artifact.path}>
              <Button
                variant="quiet"
                size="sm"
                icon="glyph.capture"
                onPress={() => onShowCapture?.(artifact.path)}
              >
                Show capture {artifact.path}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
