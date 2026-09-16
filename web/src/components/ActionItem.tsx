import { money, type ActionItem } from '../api';

const ICON: Record<string, string> = {
  minimum_spend: '◎',
  signup_deadline: '◎',
  transaction_count: '#',
  cap_nearly_gone: '▣',
  points_expiring: '⏳',
  unreviewed_import: '?',
  unknown_code: '?',
};

/**
 * One thing worth doing, with the action in the headline.
 *
 * The number is secondary here on purpose. "Spend another $164 on One" is
 * something you can act on at a till; "$436 / $600, 72%" is something you have
 * to do arithmetic on first, and the arithmetic is the app's job.
 */
export default function Action({ a, onGo }: { a: ActionItem; onGo?: (target: string) => void }) {
  return (
    <li className={`action ${a.urgency}`}>
      <span className="action-icon" aria-hidden>
        {ICON[a.kind] ?? '·'}
      </span>
      <div className="action-body">
        <p className="action-title">{a.title}</p>
        <p className="action-detail">{a.detail}</p>
      </div>
      <div className="action-side">
        {a.days_left !== null && (
          <span className={`chip ${a.urgency === 'now' ? 'critical' : a.urgency === 'soon' ? 'soon' : 'never'}`}>
            {a.days_left <= 0 ? 'today' : `${a.days_left}d`}
          </span>
        )}
        {a.amount_cents !== null && <span className="action-amount mono">${money(a.amount_cents)}</span>}
        {onGo && (
          <button type="button" className="link-btn" onClick={() => onGo(a.target)}>
            Open
          </button>
        )}
      </div>
    </li>
  );
}
