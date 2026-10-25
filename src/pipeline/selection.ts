/**
 * Selection query parser and evaluator.
 * Supports Python-like expressions for filtering atoms by properties.
 *
 * Grammar:
 *   Query      := OrExpr
 *   OrExpr     := AndExpr ("or" AndExpr)*
 *   AndExpr    := NotExpr ("and" NotExpr)*
 *   NotExpr    := "not" NotExpr | Atom
 *   Atom       := Comparison | Within | "(" OrExpr ")" | "all" | "none"
 *   Within     := "within" Number "of" Atom
 *   Comparison := Field Op Value
 *   Field      := "element" | "index" | "x" | "y" | "z" | "resname" | "resid"
 *               | "chain" | "mass" | "molecule_id"
 *   Op         := "==" | "!=" | ">" | "<" | ">=" | "<="
 *   Value      := QuotedString | Number
 *
 * Field semantics:
 *   "molecule_id": 0-based ID of the connected component (via bond
 *   connectivity) that the atom belongs to. Atoms with no bonds form their
 *   own single-atom molecule. IDs are assigned in order of the smallest atom
 *   index in each component (the component containing atom 0 gets 0, etc.).
 *   "chain": per-atom chain ID as a single character (e.g. "A"), derived from
 *   `snapshot.atomChainIds`. Atoms without chain info compare as "".
 *   "resname": residue name, the leading letters of the atom label (e.g.
 *   "ALA42" → "ALA"). Labels glue the name to the sequence number, so a name
 *   that itself contains a digit (indinavir's "MK1", "1PE") cannot be split
 *   back out; `resname == "MK1"` / `!=` therefore also match a label that
 *   starts with the queried name and continues with the sequence number
 *   ("MK1902"). See `labelMatchesResname`.
 *   "resid": residue sequence number parsed from the trailing digits of the
 *   atom label (e.g. "ALA42" → 42). Atoms whose label has no trailing number
 *   compare as NaN (never match a numeric comparison).
 *   "within R of (SEL)": atoms lying within distance R (Å) of ANY atom
 *   selected by the inner expression SEL (the selected atoms themselves are
 *   included, being at distance 0).
 */

import type { Snapshot } from "../types";
import { getElementSymbol, getAtomicMass } from "../constants";

// --- Molecule (connected-component) IDs ---

const moleculeIdCache = new WeakMap<Uint32Array, Int32Array>();

/** Find the largest atom index referenced by a flat bond-pair array, or -1 if empty. */
function maxAtomIndex(bondPairs: Uint32Array): number {
  let max = -1;
  for (let i = 0; i < bondPairs.length; i++) {
    if (bondPairs[i] > max) max = bondPairs[i];
  }
  return max;
}

/**
 * Compute a stable 0-based "molecule ID" (connected-component index) for
 * each index 0..n-1, based on the bond graph `bondPairs` (pairs
 * [a0,b0,a1,b1,...]).
 *
 * IDs are assigned in order of the smallest index in each component: the
 * component containing index 0 gets molecule_id 0, the component containing
 * the next-lowest unvisited index gets 1, etc. Indices with no bonds are
 * each their own single-element molecule.
 *
 * Results are memoized per `bondPairs` array identity, since `snapshot.bonds`
 * / `bond.bondIndices` are typically stable across trajectory frames (only
 * positions change) and selection queries may be evaluated every frame.
 */
export function computeMoleculeIds(bondPairs: Uint32Array, n: number): Int32Array {
  const cached = moleculeIdCache.get(bondPairs);
  if (cached && cached.length === n) return cached;

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };

  for (let i = 0; i < bondPairs.length; i += 2) {
    const a = bondPairs[i];
    const b = bondPairs[i + 1];
    if (a >= n || b >= n) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  const idMap = new Int32Array(n).fill(-1);
  const result = new Int32Array(n);
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (idMap[root] === -1) idMap[root] = nextId++;
    result[i] = idMap[root];
  }

  moleculeIdCache.set(bondPairs, result);
  return result;
}

// --- Tokenizer ---

type TokenType =
  | "field"
  | "op"
  | "number"
  | "string"
  | "and"
  | "or"
  | "not"
  | "within"
  | "of"
  | "lparen"
  | "rparen"
  | "all"
  | "none"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
}

const FIELDS = new Set([
  "element",
  "index",
  "x",
  "y",
  "z",
  "resname",
  "resid",
  "chain",
  "mass",
  "molecule_id",
]);

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    // Skip whitespace
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }

    // Parentheses
    if (query[i] === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (query[i] === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }

    // Operators (multi-char first)
    if (query.startsWith("==", i)) {
      tokens.push({ type: "op", value: "==" });
      i += 2;
      continue;
    }
    if (query.startsWith("!=", i)) {
      tokens.push({ type: "op", value: "!=" });
      i += 2;
      continue;
    }
    if (query.startsWith(">=", i)) {
      tokens.push({ type: "op", value: ">=" });
      i += 2;
      continue;
    }
    if (query.startsWith("<=", i)) {
      tokens.push({ type: "op", value: "<=" });
      i += 2;
      continue;
    }
    if (query[i] === ">") {
      tokens.push({ type: "op", value: ">" });
      i++;
      continue;
    }
    if (query[i] === "<") {
      tokens.push({ type: "op", value: "<" });
      i++;
      continue;
    }

    // Quoted string
    if (query[i] === '"' || query[i] === "'") {
      const quote = query[i];
      let j = i + 1;
      while (j < query.length && query[j] !== quote) j++;
      if (j >= query.length) throw new Error(`Unterminated string at position ${i}`);
      tokens.push({ type: "string", value: query.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    // Number (including negative and decimal)
    if (
      /[\d.]/.test(query[i]) ||
      (query[i] === "-" && i + 1 < query.length && /[\d.]/.test(query[i + 1]))
    ) {
      let j = i;
      if (query[j] === "-") j++;
      while (j < query.length && /[\d.]/.test(query[j])) j++;
      tokens.push({ type: "number", value: query.slice(i, j) });
      i = j;
      continue;
    }

    // Keywords and field names
    if (/[a-zA-Z_]/.test(query[i])) {
      let j = i;
      while (j < query.length && /[a-zA-Z_0-9]/.test(query[j])) j++;
      const word = query.slice(i, j);
      if (word === "and") tokens.push({ type: "and", value: word });
      else if (word === "or") tokens.push({ type: "or", value: word });
      else if (word === "not") tokens.push({ type: "not", value: word });
      else if (word === "within") tokens.push({ type: "within", value: word });
      else if (word === "of") tokens.push({ type: "of", value: word });
      else if (word === "all") tokens.push({ type: "all", value: word });
      else if (word === "none") tokens.push({ type: "none", value: word });
      else if (FIELDS.has(word)) tokens.push({ type: "field", value: word });
      else throw new Error(`Unknown identifier: "${word}"`);
      i = j;
      continue;
    }

    throw new Error(`Unexpected character: "${query[i]}" at position ${i}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

// --- AST ---

type ASTNode =
  | { kind: "comparison"; field: string; op: string; value: string | number }
  | { kind: "within"; radius: number; operand: ASTNode }
  | { kind: "and"; left: ASTNode; right: ASTNode }
  | { kind: "or"; left: ASTNode; right: ASTNode }
  | { kind: "not"; operand: ASTNode }
  | { kind: "all" }
  | { kind: "none" };

// --- Parser ---

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new Error(`Expected ${type}, got ${t.type} ("${t.value}")`);
    }
    return this.advance();
  }

  parse(): ASTNode {
    const node = this.parseOr();
    if (this.peek().type !== "eof") {
      throw new Error(`Unexpected token: "${this.peek().value}"`);
    }
    return node;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.peek().type === "or") {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseNot();
    while (this.peek().type === "and") {
      this.advance();
      const right = this.parseNot();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseNot(): ASTNode {
    if (this.peek().type === "not") {
      this.advance();
      const operand = this.parseNot();
      return { kind: "not", operand };
    }
    return this.parseAtom();
  }

  private parseAtom(): ASTNode {
    const t = this.peek();

    if (t.type === "all") {
      this.advance();
      return { kind: "all" };
    }

    if (t.type === "none") {
      this.advance();
      return { kind: "none" };
    }

    if (t.type === "lparen") {
      this.advance();
      const node = this.parseOr();
      this.expect("rparen");
      return node;
    }

    if (t.type === "within") {
      this.advance();
      const radiusToken = this.expect("number");
      const radius = parseFloat(radiusToken.value);
      if (isNaN(radius)) throw new Error("Invalid radius after 'within'");
      this.expect("of");
      const operand = this.parseAtom();
      return { kind: "within", radius, operand };
    }

    if (t.type === "field") {
      const field = this.advance().value;
      const op = this.expect("op").value;
      const valToken = this.peek();
      let value: string | number;
      if (valToken.type === "string") {
        value = this.advance().value;
      } else if (valToken.type === "number") {
        value = parseFloat(this.advance().value);
        if (isNaN(value)) throw new Error(`Invalid number`);
      } else {
        throw new Error(`Expected value after operator, got ${valToken.type}`);
      }
      return { kind: "comparison", field, op, value };
    }

    throw new Error(`Unexpected token: "${t.value}" (${t.type})`);
  }
}

// --- Evaluator ---

/** Extract residue name from atom label (e.g., "ALA42" → "ALA"). */
export function parseResname(label: string): string {
  const match = label.match(/^([A-Za-z]+)/);
  return match ? match[1] : label;
}

/**
 * Whether an atom label ("<resName><resSeq>", e.g. "ALA42") belongs to residue
 * `name` — the `resname ==` test.
 *
 * `parseResname` keeps only the leading letters, which is right for the
 * alphabetic names that make up nearly every residue but loses names that
 * contain a digit: "MK1902" (indinavir, residue 902) reads as "MK". A label
 * cannot be split unambiguously ("NA12" is sodium 12, not "NA1" 2), so the
 * prefix match only kicks in when the *queried* name contains a digit — a
 * query `parseResname` could never have satisfied — and existing alphabetic
 * queries keep their exact-match meaning.
 */
export function labelMatchesResname(label: string, name: string): boolean {
  if (parseResname(label) === name) return true;
  if (!/\d/.test(name) || !label.startsWith(name)) return false;
  return /^-?\d/.test(label.slice(name.length));
}

/**
 * Extract a residue sequence number from an atom label by reading the last run
 * of digits (e.g. "ALA42" → 42, "HOH" → NaN). Returns NaN when the label has no
 * trailing number, so a numeric `resid` comparison never matches those atoms.
 *
 * Implemented as a linear back-to-front scan rather than a regex: atom labels
 * come from parsed files (untrusted input), and a lookahead like
 * `/(\d+)(?!.*\d)/` has polynomial worst-case matching time (ReDoS).
 */
export function parseResid(label: string): number {
  const isDigit = (c: string) => c >= "0" && c <= "9";
  let end = label.length;
  while (end > 0 && !isDigit(label[end - 1])) end--;
  let start = end;
  while (start > 0 && isDigit(label[start - 1])) start--;
  return start === end ? NaN : parseInt(label.slice(start, end), 10);
}

/**
 * Build a predicate selecting atoms within `radius` (Å) of any atom matched by
 * `inner`. Uses a uniform spatial grid (cell size = radius) so the cost scales
 * with local density rather than O(nAtoms · nSelected). The selected atoms
 * themselves satisfy the predicate (distance 0). An empty inner selection
 * yields a predicate that matches nothing.
 */
function buildWithinPredicate(
  inner: (index: number) => boolean,
  snapshot: Snapshot,
  radius: number,
): (index: number) => boolean {
  const { positions, nAtoms } = snapshot;
  const seeds: number[] = [];
  for (let i = 0; i < nAtoms; i++) if (inner(i)) seeds.push(i);
  if (seeds.length === 0) return () => false;

  const r = radius;
  const r2 = r * r;

  // Radii <= 0 (or non-finite) can't drive a spatial grid; fall back to a
  // direct scan over the (usually small) seed set.
  if (!(r > 0)) {
    return (i) => {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      for (const j of seeds) {
        const dx = x - positions[j * 3];
        const dy = y - positions[j * 3 + 1];
        const dz = z - positions[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz <= r2) return true;
      }
      return false;
    };
  }

  const grid = new Map<string, number[]>();
  const cellKey = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`;
  for (const j of seeds) {
    const cx = Math.floor(positions[j * 3] / r);
    const cy = Math.floor(positions[j * 3 + 1] / r);
    const cz = Math.floor(positions[j * 3 + 2] / r);
    const key = cellKey(cx, cy, cz);
    const cell = grid.get(key);
    if (cell) cell.push(j);
    else grid.set(key, [j]);
  }

  return (i) => {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const bx = Math.floor(x / r);
    const by = Math.floor(y / r);
    const bz = Math.floor(z / r);
    for (let cx = bx - 1; cx <= bx + 1; cx++) {
      for (let cy = by - 1; cy <= by + 1; cy++) {
        for (let cz = bz - 1; cz <= bz + 1; cz++) {
          const cell = grid.get(cellKey(cx, cy, cz));
          if (!cell) continue;
          for (const j of cell) {
            const dx = x - positions[j * 3];
            const dy = y - positions[j * 3 + 1];
            const dz = z - positions[j * 3 + 2];
            if (dx * dx + dy * dy + dz * dz <= r2) return true;
          }
        }
      }
    }
    return false;
  };
}

function compileAST(
  ast: ASTNode,
  snapshot: Snapshot,
  atomLabels: string[] | null,
): (index: number) => boolean {
  switch (ast.kind) {
    case "all":
      return () => true;
    case "none":
      return () => false;
    case "not": {
      const fn = compileAST(ast.operand, snapshot, atomLabels);
      return (i) => !fn(i);
    }
    case "and": {
      const left = compileAST(ast.left, snapshot, atomLabels);
      const right = compileAST(ast.right, snapshot, atomLabels);
      return (i) => left(i) && right(i);
    }
    case "or": {
      const left = compileAST(ast.left, snapshot, atomLabels);
      const right = compileAST(ast.right, snapshot, atomLabels);
      return (i) => left(i) || right(i);
    }
    case "within": {
      const inner = compileAST(ast.operand, snapshot, atomLabels);
      return buildWithinPredicate(inner, snapshot, ast.radius);
    }
    case "comparison": {
      const { field, op, value } = ast;
      let moleculeIds: Int32Array | null = null;
      return (i) => {
        if (field === "resname" && (op === "==" || op === "!=") && typeof value === "string") {
          const label = atomLabels?.[i];
          const match = label ? labelMatchesResname(label, value) : value === "";
          return op === "==" ? match : !match;
        }
        let fieldValue: string | number;
        switch (field) {
          case "element":
            fieldValue = getElementSymbol(snapshot.elements[i]);
            break;
          case "index":
            fieldValue = i;
            break;
          case "x":
            fieldValue = snapshot.positions[i * 3];
            break;
          case "y":
            fieldValue = snapshot.positions[i * 3 + 1];
            break;
          case "z":
            fieldValue = snapshot.positions[i * 3 + 2];
            break;
          case "resname":
            fieldValue = atomLabels?.[i] ? parseResname(atomLabels[i]) : "";
            break;
          case "resid":
            fieldValue = atomLabels?.[i] != null ? parseResid(atomLabels[i]) : NaN;
            break;
          case "chain": {
            const code = snapshot.atomChainIds?.[i] ?? 0;
            fieldValue = code === 0 ? "" : String.fromCharCode(code);
            break;
          }
          case "mass":
            fieldValue = getAtomicMass(snapshot.elements[i]);
            break;
          case "molecule_id":
            if (moleculeIds === null) {
              moleculeIds = computeMoleculeIds(snapshot.bonds, snapshot.nAtoms);
            }
            fieldValue = moleculeIds[i];
            break;
          default:
            return false;
        }

        switch (op) {
          case "==":
            return fieldValue === value;
          case "!=":
            return fieldValue !== value;
          case ">":
            return fieldValue > value;
          case "<":
            return fieldValue < value;
          case ">=":
            return fieldValue >= value;
          case "<=":
            return fieldValue <= value;
          default:
            return false;
        }
      };
    }
  }
}

/**
 * Evaluate a selection query against a snapshot.
 * Returns null for empty query or "all" (meaning all atoms selected).
 * Returns a Set of matching atom indices otherwise.
 */
export function evaluateSelection(
  query: string,
  snapshot: Snapshot,
  atomLabels: string[] | null,
): Set<number> | null {
  const trimmed = query.trim();
  if (trimmed === "" || trimmed === "all") return null;

  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  const ast = parser.parse();

  if (ast.kind === "all") return null;
  if (ast.kind === "none") return new Set();

  const predicate = compileAST(ast, snapshot, atomLabels);
  const result = new Set<number>();
  for (let i = 0; i < snapshot.nAtoms; i++) {
    if (predicate(i)) result.add(i);
  }
  return result;
}

/**
 * Validate a query string without evaluating it.
 * Returns { valid: true } or { valid: false, error: "..." }.
 */
export function validateQuery(query: string): { valid: boolean; error?: string } {
  const trimmed = query.trim();
  if (trimmed === "" || trimmed === "all" || trimmed === "none") {
    return { valid: true };
  }
  try {
    const tokens = tokenize(trimmed);
    const parser = new Parser(tokens);
    parser.parse();
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

// ─── Bond Selection Query ──────────────────────────────────────────────────────
//
// Grammar:
//   Query      := OrExpr
//   OrExpr     := AndExpr ("or" AndExpr)*
//   AndExpr    := NotExpr ("and" NotExpr)*
//   NotExpr    := "not" NotExpr | Atom
//   Atom       := "both" Comparison | Comparison | "(" OrExpr ")" | "all" | "none"
//   Comparison := Field Op Value
//   Field      := "bond_index" | "atom_index" | "element" | "molecule_id"
//   Op         := "==" | "!=" | ">" | "<" | ">=" | "<="
//   Value      := QuotedString | Number
//
// Semantics:
//   "both" prefix: both atoms of the bond must satisfy the condition
//   Without "both": either atom satisfies the condition (OR semantics)
//   "bond_index": the 0-based sequential index of the bond
//   "atom_index": index of an atom endpoint
//   "element": element symbol of an atom endpoint
//   For both, a PBC ghost / Drawing Boundary copy endpoint reads as the
//   structural atom it copies (see `bondEndpointResolver`).
//   "molecule_id": 0-based ID of the connected component (via bond
//   connectivity, including this bond) that the bond's endpoints belong to.
//   Both endpoints of a bond are always in the same component, so
//   "both molecule_id == N" and "molecule_id == N" are equivalent; "both" is
//   accepted for grammar consistency but has no additional effect. Numbering
//   matches the atom query's molecule_id for the same underlying atoms (the
//   component containing atom 0 gets molecule_id 0, etc.).

const BOND_FIELDS = new Set(["bond_index", "atom_index", "element", "molecule_id"]);

type BondTokenType =
  | "bond_field"
  | "op"
  | "number"
  | "string"
  | "and"
  | "or"
  | "not"
  | "both"
  | "lparen"
  | "rparen"
  | "all"
  | "none"
  | "eof";

interface BondToken {
  type: BondTokenType;
  value: string;
}

function tokenizeBond(query: string): BondToken[] {
  const tokens: BondToken[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }
    if (query[i] === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (query[i] === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }
    if (query.startsWith("==", i)) {
      tokens.push({ type: "op", value: "==" });
      i += 2;
      continue;
    }
    if (query.startsWith("!=", i)) {
      tokens.push({ type: "op", value: "!=" });
      i += 2;
      continue;
    }
    if (query.startsWith(">=", i)) {
      tokens.push({ type: "op", value: ">=" });
      i += 2;
      continue;
    }
    if (query.startsWith("<=", i)) {
      tokens.push({ type: "op", value: "<=" });
      i += 2;
      continue;
    }
    if (query[i] === ">") {
      tokens.push({ type: "op", value: ">" });
      i++;
      continue;
    }
    if (query[i] === "<") {
      tokens.push({ type: "op", value: "<" });
      i++;
      continue;
    }
    if (query[i] === '"' || query[i] === "'") {
      const quote = query[i];
      let j = i + 1;
      while (j < query.length && query[j] !== quote) j++;
      if (j >= query.length) throw new Error(`Unterminated string at position ${i}`);
      tokens.push({ type: "string", value: query.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (
      /[\d.]/.test(query[i]) ||
      (query[i] === "-" && i + 1 < query.length && /[\d.]/.test(query[i + 1]))
    ) {
      let j = i;
      if (query[j] === "-") j++;
      while (j < query.length && /[\d.]/.test(query[j])) j++;
      tokens.push({ type: "number", value: query.slice(i, j) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(query[i])) {
      let j = i;
      while (j < query.length && /[a-zA-Z_0-9]/.test(query[j])) j++;
      const word = query.slice(i, j);
      if (word === "and") tokens.push({ type: "and", value: word });
      else if (word === "or") tokens.push({ type: "or", value: word });
      else if (word === "not") tokens.push({ type: "not", value: word });
      else if (word === "all") tokens.push({ type: "all", value: word });
      else if (word === "none") tokens.push({ type: "none", value: word });
      else if (word === "both") tokens.push({ type: "both", value: word });
      else if (BOND_FIELDS.has(word)) tokens.push({ type: "bond_field", value: word });
      else throw new Error(`Unknown identifier: "${word}"`);
      i = j;
      continue;
    }
    throw new Error(`Unexpected character: "${query[i]}" at position ${i}`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

type BondASTNode =
  | { kind: "comparison"; field: string; op: string; value: string | number; both: boolean }
  | { kind: "and"; left: BondASTNode; right: BondASTNode }
  | { kind: "or"; left: BondASTNode; right: BondASTNode }
  | { kind: "not"; operand: BondASTNode }
  | { kind: "all" }
  | { kind: "none" };

class BondParser {
  private tokens: BondToken[];
  private pos = 0;

  constructor(tokens: BondToken[]) {
    this.tokens = tokens;
  }

  private peek(): BondToken {
    return this.tokens[this.pos];
  }
  private advance(): BondToken {
    return this.tokens[this.pos++];
  }

  private expect(type: BondTokenType): BondToken {
    const t = this.peek();
    if (t.type !== type) throw new Error(`Expected ${type}, got ${t.type} ("${t.value}")`);
    return this.advance();
  }

  parse(): BondASTNode {
    const node = this.parseOr();
    if (this.peek().type !== "eof") throw new Error(`Unexpected token: "${this.peek().value}"`);
    return node;
  }

  private parseOr(): BondASTNode {
    let left = this.parseAnd();
    while (this.peek().type === "or") {
      this.advance();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): BondASTNode {
    let left = this.parseNot();
    while (this.peek().type === "and") {
      this.advance();
      left = { kind: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): BondASTNode {
    if (this.peek().type === "not") {
      this.advance();
      return { kind: "not", operand: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): BondASTNode {
    const t = this.peek();
    if (t.type === "all") {
      this.advance();
      return { kind: "all" };
    }
    if (t.type === "none") {
      this.advance();
      return { kind: "none" };
    }
    if (t.type === "lparen") {
      this.advance();
      const node = this.parseOr();
      this.expect("rparen");
      return node;
    }
    if (t.type === "both") {
      this.advance();
      return this.parseComparison(true);
    }
    if (t.type === "bond_field") {
      return this.parseComparison(false);
    }
    throw new Error(`Unexpected token: "${t.value}" (${t.type})`);
  }

  private parseComparison(both: boolean): BondASTNode {
    const field = this.expect("bond_field").value;
    const op = this.expect("op").value;
    const valToken = this.peek();
    let value: string | number;
    if (valToken.type === "string") {
      value = this.advance().value;
    } else if (valToken.type === "number") {
      value = parseFloat(this.advance().value);
      if (isNaN(value as number)) throw new Error("Invalid number");
    } else {
      throw new Error(`Expected value after operator, got ${valToken.type}`);
    }
    return { kind: "comparison", field, op, value, both };
  }
}

function applyOp(fieldValue: string | number, op: string, value: string | number): boolean {
  switch (op) {
    case "==":
      return fieldValue === value;
    case "!=":
      return fieldValue !== value;
    case ">":
      return fieldValue > value;
    case "<":
      return fieldValue < value;
    case ">=":
      return fieldValue >= value;
    case "<=":
      return fieldValue <= value;
    default:
      return false;
  }
}

/**
 * Map a bond endpoint to the structural atom it stands for. Endpoints past the
 * structure's own atoms (PBC half-bond ghosts, Drawing Boundary copies) are
 * looked up in `ghostSourceIndices`, whose entry `k` is the source of endpoint
 * `nAtoms - ghostSourceIndices.length + k` (see `BondData`); every other
 * endpoint is its own source.
 */
export function bondEndpointResolver(
  nAtoms: number,
  ghostSourceIndices: Uint32Array | null | undefined,
): (endpoint: number) => number {
  if (!ghostSourceIndices || ghostSourceIndices.length === 0) return (endpoint) => endpoint;
  const nBase = nAtoms - ghostSourceIndices.length;
  return (endpoint) =>
    endpoint < nBase ? endpoint : (ghostSourceIndices[endpoint - nBase] ?? endpoint);
}

function compileBondAST(
  ast: BondASTNode,
  bondIndices: Uint32Array,
  elements: Uint8Array,
  nAtoms: number,
  sourceOf: (endpoint: number) => number,
): (bondIdx: number) => boolean {
  switch (ast.kind) {
    case "all":
      return () => true;
    case "none":
      return () => false;
    case "not": {
      const fn = compileBondAST(ast.operand, bondIndices, elements, nAtoms, sourceOf);
      return (i) => !fn(i);
    }
    case "and": {
      const left = compileBondAST(ast.left, bondIndices, elements, nAtoms, sourceOf);
      const right = compileBondAST(ast.right, bondIndices, elements, nAtoms, sourceOf);
      return (i) => left(i) && right(i);
    }
    case "or": {
      const left = compileBondAST(ast.left, bondIndices, elements, nAtoms, sourceOf);
      const right = compileBondAST(ast.right, bondIndices, elements, nAtoms, sourceOf);
      return (i) => left(i) || right(i);
    }
    case "comparison": {
      const { field, op, value, both } = ast;
      let moleculeIds: Int32Array | null = null;
      return (i) => {
        const atomA = bondIndices[i * 2];
        const atomB = bondIndices[i * 2 + 1];
        switch (field) {
          case "bond_index":
            return applyOp(i, op, value);
          case "atom_index": {
            const srcA = sourceOf(atomA);
            const srcB = sourceOf(atomB);
            if (both) return applyOp(srcA, op, value) && applyOp(srcB, op, value);
            return applyOp(srcA, op, value) || applyOp(srcB, op, value);
          }
          case "element": {
            const elemA = getElementSymbol(elements[sourceOf(atomA)] ?? 0);
            const elemB = getElementSymbol(elements[sourceOf(atomB)] ?? 0);
            if (both) return applyOp(elemA, op, value) && applyOp(elemB, op, value);
            return applyOp(elemA, op, value) || applyOp(elemB, op, value);
          }
          case "molecule_id": {
            if (moleculeIds === null) {
              const n = nAtoms > 0 ? nAtoms : maxAtomIndex(bondIndices) + 1;
              moleculeIds = computeMoleculeIds(bondIndices, n);
            }
            // atomA and atomB are always in the same component (they're
            // directly connected by this bond), so "both" is a no-op here.
            return applyOp(moleculeIds[atomA], op, value);
          }
          default:
            return false;
        }
      };
    }
  }
}

/**
 * Evaluate a bond selection query.
 * Returns null for empty/"all" (all bonds selected).
 * Returns a Set of matching bond indices (0-based) otherwise.
 *
 * `elements` are the structure's own atoms; `ghostSourceIndices` (see
 * `bondEndpointResolver`) lets `atom_index` / `element` read a ghost or image
 * endpoint as the structural atom it copies, so both half-bonds of a
 * boundary-crossing bond match the same queries.
 */
export function evaluateBondSelection(
  query: string,
  bondIndices: Uint32Array,
  elements: Uint8Array,
  nBonds: number,
  nAtoms?: number,
  ghostSourceIndices?: Uint32Array | null,
): Set<number> | null {
  const trimmed = query.trim();
  if (trimmed === "" || trimmed === "all") return null;

  const tokens = tokenizeBond(trimmed);
  const parser = new BondParser(tokens);
  const ast = parser.parse();

  if (ast.kind === "all") return null;
  if (ast.kind === "none") return new Set();

  const sourceOf = bondEndpointResolver(nAtoms ?? 0, ghostSourceIndices);
  const predicate = compileBondAST(ast, bondIndices, elements, nAtoms ?? 0, sourceOf);
  const result = new Set<number>();
  for (let i = 0; i < nBonds; i++) {
    if (predicate(i)) result.add(i);
  }
  return result;
}

/**
 * Validate a bond query string without evaluating it.
 */
export function validateBondQuery(query: string): { valid: boolean; error?: string } {
  const trimmed = query.trim();
  if (trimmed === "" || trimmed === "all" || trimmed === "none") return { valid: true };
  try {
    const tokens = tokenizeBond(trimmed);
    const parser = new BondParser(tokens);
    parser.parse();
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}
