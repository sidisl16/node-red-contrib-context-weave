'use strict';

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'VALIDATION' });
}

// The lexer consumes every character. Field names come only from the trusted schema,
// and values only enter SQL through bound parameters.
const token = /\s*(?:(?<quoted>"(?:[^"\\]|\\["\\])*"|'(?:[^'\\]|\\['\\])*')|(?<number>-?(?:0|[1-9]\d*)(?:\.\d+)?)|(?<word>\$?[A-Za-z_][A-Za-z0-9_.]*)|(?<op>>=|<=|!=|=|<|>|[(),\[\]]))/gy;
const ops = {
  '=': (a, b) => a === b, '!=': (a, b) => a !== b,
  '>': (a, b) => a > b, '<': (a, b) => a < b,
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b
};

function compileFilter(expression, attributes = [], claims = {}) {
  if (expression == null || expression === '') return { sql: '1', params: [], test: () => true };
  if (typeof expression !== 'string' || expression.length > 4096) invalid('Invalid metadata filter');
  const input = expression.trim();
  const tokens = [];
  for (let at = 0; at < input.length;) {
    token.lastIndex = at;
    const match = token.exec(input);
    if (!match || tokens.length >= 192) invalid('Invalid or too complex metadata filter');
    at = token.lastIndex;
    tokens.push(Object.values(match.groups).find(v => v !== undefined));
  }
  const params = [];
  let i = 0;
  const take = s => tokens[i]?.toUpperCase() === s && (++i > 0);
  function literal(type) {
    const t = tokens[i++];
    if (!t) invalid('Expected filter value');
    let v;
    if (/^['"]/.test(t)) v = t.slice(1, -1).replace(/\\(.)/g, '$1');
    else if (/^-?\d/.test(t)) v = Number(t);
    else if (/^(true|false)$/i.test(t)) v = t.toLowerCase() === 'true';
    else if (/^\$auth\.[A-Za-z_]\w*$/.test(t) && Object.hasOwn(claims, t.slice(6))) v = claims[t.slice(6)];
    else invalid('Invalid filter literal or claim');
    if (!matchesType(v, type)) invalid('Filter value does not match declared field type');
    params.push(typeof v === 'boolean' ? Number(v) : v);
    return v;
  }
  function atom() {
    if (take('(')) {
      const inner = disjunction();
      if (!take(')')) invalid('Expected closing parenthesis');
      return inner;
    }
    const field = tokens[i++];
    const attr = attributes.find(a => a.name === field);
    if (!attr || !/^[A-Za-z_]\w*$/.test(field)) invalid('Unknown filter field');
    const sql = "json_extract(d.body, '$.metadata." + field + "')";
    if (take('IN')) {
      if (!take('[')) invalid('Expected array');
      const values = [literal(attr.type)];
      while (take(',')) values.push(literal(attr.type));
      if (!take(']')) invalid('Expected closing bracket');
      return { sql: sql + ' IN (' + values.map(() => '?').join(',') + ')', test: m => values.includes(m[field]) };
    }
    const operator = tokens[i++];
    if (!Object.hasOwn(ops, operator)) invalid('Invalid filter comparison');
    const v = literal(attr.type);
    return { sql: sql + ' ' + operator + ' ?', test: m => m[field] != null && ops[operator](m[field], v) };
  }
  function combine(left, right, op) {
    return { sql: '(' + left.sql + ' ' + op + ' ' + right.sql + ')',
      test: m => op === 'AND' ? left.test(m) && right.test(m) : left.test(m) || right.test(m) };
  }
  function conjunction() {
    let result = atom();
    while (take('AND')) result = combine(result, atom(), 'AND');
    return result;
  }
  function disjunction() {
    let result = conjunction();
    while (take('OR')) result = combine(result, conjunction(), 'OR');
    return result;
  }
  const result = disjunction();
  if (i !== tokens.length) invalid('Unexpected filter token');
  return { ...result, params };
}

function matchesType(value, type) {
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number' || type === 'float') return Number.isFinite(value);
  if (type === 'date' || type === 'datetime') return typeof value === 'string' && Number.isFinite(Date.parse(value));
  return ['boolean', 'string'].includes(type) && typeof value === type;
}
module.exports = { compileFilter, invalid, matchesType };
