import { linesFromItems } from '../web/src/pdf';
import { detectBank, findStatementDate, normalise, PROFILES } from '../web/src/banks';
import { parseStatement } from '../src/statement';

let fails = 0;
const check = (l: string, c: boolean, d = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${c ? '' : `  -- ${d}`}`);
};

// --- positioned fragments back into lines ------------------------------------
// A PDF text layer has no lines: it has items with coordinates. y grows upward.
const items = [
  { str: '8.04', x: 500, y: 700 },
  { str: '26 JUL', x: 50, y: 700 },
  { str: 'WWW.TADA.G*', x: 120, y: 700.5 },
  { str: 'DATE', x: 50, y: 720 },
  { str: 'AMOUNT', x: 500, y: 720 },
  { str: '   ', x: 300, y: 690 },
  { str: 'SUB-TOTAL: 8.04', x: 50, y: 680 },
];
const lines = linesFromItems(items);
check('rows come out top of the page first', lines[0] === 'DATE AMOUNT', JSON.stringify(lines));
check('items on one row are read left to right', lines[1] === '26 JUL WWW.TADA.G* 8.04', JSON.stringify(lines[1]));
check('a half-point difference is still the same row', lines.length === 3, JSON.stringify(lines));
check('blank fragments are dropped', !lines.some((l) => l.trim() === ''), JSON.stringify(lines));

// --- the statement's own date ------------------------------------------------
check('reads a spelled-out date', findStatementDate('Statement Date August 16, 2026') === '2026-08-16', String(findStatementDate('Statement Date August 16, 2026')));
// Regression: a greedy gap ate "Aug" and captured "ust", which is not a month.
check('the month is not half-eaten', findStatementDate('Statement Date Aug 16, 2026') === '2026-08-16', String(findStatementDate('Statement Date Aug 16, 2026')));
check('reads a day-first date', findStatementDate('Statement Date 16 AUG 2026') === '2026-08-16', String(findStatementDate('Statement Date 16 AUG 2026')));
check('reads a slashed date', findStatementDate('Statement Date: 16/08/2026') === '2026-08-16', String(findStatementDate('Statement Date: 16/08/2026')));
check('and admits when there is none', findStatementDate('no date here') === null, '');
check(
  'prose about a statement date does not become one',
  findStatementDate('charges posted after this statement date. (Please refer to the back)') === null,
  String(findStatementDate('charges posted after this statement date. (Please refer to the back)'))
);

// --- recognising the bank ----------------------------------------------------
for (const [text, key] of [
  ['Citibank Singapore Ltd ... CITI REWARDS WORLD MASTERCARD ... YOUR CITI THANKYOU POINTS', 'citi'],
  ['DBS Cards P.O. Box ... DBS Points earned', 'dbs'],
  ['United Overseas Bank Limited ... UNI$ earned this month', 'uob'],
  ['Oversea-Chinese Banking Corporation ... OCBC$ balance', 'ocbc'],
  ['The Hongkong and Shanghai Banking Corporation ... HSBC Revolution', 'hsbc'],
] as const) {
  check(`recognises a ${key} statement`, detectBank(text).profile.key === key, detectBank(text).profile.key);
}
check('an unrecognised statement still returns a profile', !!detectBank('nothing familiar').profile, '');
check('with zero confidence', detectBank('nothing familiar').confidence === 0, '');
check('and the bank can be forced', detectBank('nothing familiar', 'uob').profile.key === 'uob', '');
check('every profile has a label', PROFILES.every((p) => p.label && p.key), '');

// --- a real Citi statement ----------------------------------------------------
// The lines below are what the extractor produced from an actual statement.
const citiPages = [
  {
    lines: [
      'CITI REWARDS WORLD MASTERCARD 5425 5030 0458 2929 Payment Due Date: September 10, 2026',
      'Statement Date August 16, 2026',
      'DATE DESCRIPTION AMOUNT (SGD)',
      'TRANSACTIONS FOR CITI REWARDS WORLD MASTERCARD',
      'ALL TRANSACTIONS BILLED IN SINGAPORE DOLLARS',
      'BALANCE PREVIOUS STATEMENT 259.28',
      '07 AUG MONEYSEND WEE SHING HAO, SINGAPORE SG (259.28)',
      'SUB-TOTAL: 0.00',
      '26 JUL WWW.TADA.G* N019F9C53B SINGAPORE SG 8.04',
      'SUB-TOTAL: 8.04',
      'GRAND TOTAL 8.04',
      'Please examine this statement immediately. If no discrepancy is reported within 10 days',
      'Citibank Singapore Ltd Robinson Road P. O. Box 355 S(900705)',
    ],
  },
];
const citi = normalise(citiPages);
check('the bank is recognised from the page', citi.bank === 'citi', citi.bank);
check('and its statement date found', citi.statement_date === '2026-08-16', String(citi.statement_date));
check('only the transaction rows survive', citi.text.split('\n').length === 2, JSON.stringify(citi.text));
check('a bracketed amount becomes a credit', citi.text.includes('259.28 CR'), citi.text);
check('balances and sub-totals are dropped', !/BALANCE PREVIOUS|SUB-TOTAL|GRAND TOTAL/.test(citi.text), citi.text);
check('and so is the legal text', !/discrepancy|Robinson Road/.test(citi.text), citi.text);
check('what was dropped is counted', citi.dropped === 11, String(citi.dropped));

const rows = parseStatement(citi.text, '2026-09-15', citi.statement_date);
check('the rows parse', rows.rows.length === 2, JSON.stringify(rows.rows));
check('the refund is negative', rows.rows[0].amount_cents === -25928, String(rows.rows[0].amount_cents));
check('a July row on an August statement stays in that year', rows.rows[1].occurred_at === '2026-07-26', rows.rows[1].occurred_at);
check('and nothing is left unexplained', rows.skipped.length === 0, JSON.stringify(rows.skipped));

// A December row on a January statement belongs to the year before.
const janPages = [{ lines: ['Citibank Singapore Ltd', 'Statement Date January 16, 2027', '28 DEC SOMETHING SG 12.00'] }];
const jan = normalise(janPages);
const janRows = parseStatement(jan.text, '2027-01-20', jan.statement_date);
check('an unprinted year is taken from the statement', janRows.rows[0].occurred_at === '2026-12-28', janRows.rows[0].occurred_at);

// --- the other four layouts ---------------------------------------------------
// Constructed from the shapes each bank prints, not from real statements.
const dbs = normalise([
  {
    lines: [
      'DBS Cards P.O. Box 360 Singapore',
      'Statement Date 16 AUG 2026',
      'NEW TRANSACTIONS',
      '05 AUG 06 AUG NTUC FAIRPRICE SINGAPORE SG 23.45',
      '07 AUG 08 AUG PAYMENT - THANK YOU 500.00',
      'TOTAL BALANCE 123.45',
    ],
  },
]);
check('a DBS statement is recognised', dbs.bank === 'dbs', dbs.bank);
check('its two dates are kept', dbs.text.includes('05 AUG 06 AUG'), dbs.text);
check('and its payment line dropped', !/PAYMENT - THANK YOU/.test(dbs.text), dbs.text);
const dbsRows = parseStatement(dbs.text, '2026-09-15', dbs.statement_date);
check('DBS rows carry a posting date', dbsRows.rows[0].posted_at === '2026-08-06', String(dbsRows.rows[0].posted_at));

const uob = normalise([
  {
    lines: [
      'United Overseas Bank Limited',
      'Statement Date 16 AUG 2026',
      '05 AUG COLD STORAGE SINGAPORE SG 45.60',
      '06 AUG REFUND SHOPEE 12.30 CR',
      'PREVIOUS BALANCE 200.00',
    ],
  },
]);
check('a UOB statement is recognised', uob.bank === 'uob', uob.bank);
check('a CR suffix survives', uob.text.includes('12.30 CR'), uob.text);
check('UOB credits parse as refunds', parseStatement(uob.text, '2026-09-15', uob.statement_date).rows[1].amount_cents === -1230, '');

const ocbc = normalise([
  {
    lines: ['Oversea-Chinese Banking Corporation', 'Statement Date 16/08/2026', '05/08 GIANT SUPERMARKET 31.20', 'TOTAL 31.20'],
  },
]);
check('an OCBC statement is recognised', ocbc.bank === 'ocbc', ocbc.bank);
const ocbcRows = parseStatement(ocbc.text, '2026-09-15', ocbc.statement_date);
check('a DD/MM date takes its year from the statement', ocbcRows.rows[0].occurred_at === '2026-08-05', ocbcRows.rows[0].occurred_at);

const hsbc = normalise([
  {
    lines: ['The Hongkong and Shanghai Banking Corporation', 'Statement Date 16 AUG 2026', '5 AUG WATSONS SINGAPORE 18.90', 'PREVIOUS BALANCE 0.00'],
  },
]);
check('an HSBC statement is recognised', hsbc.bank === 'hsbc', hsbc.bank);
check('a single-digit day is padded', hsbc.text.startsWith('05 AUG'), hsbc.text);
check('and parses', parseStatement(hsbc.text, '2026-09-15', hsbc.statement_date).rows[0].amount_cents === 1890, '');

// --- nothing usable ----------------------------------------------------------
const empty = normalise([{ lines: ['Some marketing page', 'with no transactions at all'] }]);
check('a PDF with no rows returns none', empty.text === '', JSON.stringify(empty.text));
check('and counts what it looked at', empty.dropped === 2, String(empty.dropped));

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
