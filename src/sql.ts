/**
 * Splits a SQL script into statements, on semicolons that actually terminate
 * one — not those inside a string literal or a line comment. Both have broken
 * naive splitters in this project before, so the Worker and the tests share
 * this single implementation.
 */
export function statements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inStr = false;
  let inComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (inComment) {
      if (c === '\n') {
        inComment = false;
        buf += c;
      }
      continue;
    }

    if (inStr) {
      buf += c;
      if (c === "'") {
        if (sql[i + 1] === "'") buf += sql[++i]; // escaped quote, stay inside
        else inStr = false;
      }
      continue;
    }

    if (c === '-' && sql[i + 1] === '-') {
      inComment = true;
      i++;
      continue;
    }
    if (c === "'") {
      inStr = true;
      buf += c;
      continue;
    }
    if (c === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += c;
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}
