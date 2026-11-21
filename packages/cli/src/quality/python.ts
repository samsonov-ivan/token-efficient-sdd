interface Scope {
  kind: 'class' | 'def';
  name: string;
  indent: number;
  start: number;
}

// Python changes indentation only between logical statements. Physical lines
// within a string, bracketed expression or explicit continuation cannot dedent.
function* pythonStatements(lines: string[], end: number) {
  let quote = '';
  let depth = 0;
  let continued = false;
  for (let index = 0; index <= end; index++) {
    const line = lines[index];
    const text = line.trimStart();
    if (!quote && depth === 0 && !continued && text && !text.startsWith('#')) {
      let indent = 0;
      for (const char of line.slice(0, line.length - text.length)) {
        if (char === '\t') indent += 8 - (indent % 8);
        else if (char === '\f') indent = 0;
        else indent++;
      }
      yield { index, text, indent };
    }
    continued = false;
    for (let column = 0; column < line.length; column++) {
      const char = line[column];
      if (quote) {
        if (char === '\\') column++;
        else if (line.startsWith(quote, column)) {
          column += quote.length - 1;
          quote = '';
        }
      } else if (char === '#') break;
      else if (char === '"' || char === "'") {
        const triple = char.repeat(3);
        quote = line.startsWith(triple, column) ? triple : char;
        column += quote.length - 1;
      } else if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) depth--;
      else if (char === '\\' && column === line.length - 1) continued = true;
    }
  }
}

export function pythonTestContext(lines: string[], line: number, test: string, module: string) {
  const [classname, name] = test.split('::');
  const testName = name?.split('[')[0];
  const scopes: Scope[] = [];
  let decorators: number | undefined;
  for (const { index, text, indent } of pythonStatements(lines, line - 1)) {
    while ((scopes.at(-1)?.indent ?? -1) >= indent) scopes.pop();
    if (index === line - 1) {
      const owner = scopes.at(-1);
      if (owner?.kind !== 'def' || owner.name !== testName) return;
      const containers = scopes.slice(0, -1);
      if (containers.some(({ kind }) => kind === 'def')) return;
      const qualifiedClass = [module, ...containers.map(({ name }) => name)].join('.');
      if (classname !== qualifiedClass && !classname.endsWith(`.${qualifiedClass}`)) return;
      return lines.slice(owner.start, index + 1).join('\n');
    }
    if (text.startsWith('@')) {
      decorators ??= index;
      continue;
    }
    const declaration = /^(?:async[ \t]+)?(class|def)[ \t]+([_\p{ID_Start}]\p{ID_Continue}*)/u.exec(
      text,
    );
    if (declaration) {
      const kind = declaration[1] === 'class' ? 'class' : 'def';
      scopes.push({ kind, name: declaration[2], indent, start: decorators ?? index });
    }
    decorators = undefined;
  }
}
