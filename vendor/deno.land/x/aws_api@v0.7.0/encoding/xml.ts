
// apparently based on segmentio xml parser
// https://github.com/nekobato/deno-xml-parser
// this is a really bad parser though, TBH

export function readXmlResult(text: string, resultWrapper?: string): XmlNode {
  const doc = parseXml(text);
  if (!doc.root) {
    console.log('Non-XML text:', text);
    throw new Error(`Response lacking XML root`);
  }

  if (resultWrapper) {
    const result = doc.root.first(resultWrapper);
    if (!result) throw new Error(`Result Wrapper ${JSON.stringify(resultWrapper)} is missing. Present keys: ${doc.root.children.map(x => x.name).join(', ')}`);
    return result;
  }
  return doc.root;
}

export interface Document {
  declaration: XmlDeclaration | null;
  root: XmlNode | null;
}
export interface XmlDeclaration {
  attributes: {[key: string]: string};
}
export class XmlNode implements Node {
  name: string;
  attributes: {[key: string]: string} = {};
  content?: string;
  children: XmlNode[] = [];
  constructor(name: string) {
    this.name = name;
  }

  first(name: string, required: true): XmlNode;
  first<T>(name: string, required: true, accessor: (node: XmlNode) => T | undefined): T;
  first(name: string, required?: false): XmlNode | undefined;
  first<T>(name: string, required: false, accessor: (node: XmlNode) => T): T | undefined;

  first<T>(name: string, required = false, accessor?: (node: XmlNode) => T): XmlNode | T | undefined {
    const node = this.children.find(x => x.name === name);
    if (!node && required) {
      this.throwMissingKeys([name]);
    } else if (accessor) {
      if (node) {
        const value = accessor(node);
        if (value != undefined) return value;
      }
      if (required) this.throwMissingKeys([name]);
    } else {
      return node;
    }
  }

  getList(...names: string[]): XmlNode[] { // you can just map this
    let listParent: XmlNode | undefined = this;
    while (names.length > 1) {
      listParent = listParent?.first(names.shift() ?? '');
    }
    return listParent?.children.filter(x => x.name === names[0]) ?? [];
  }

  strings<
    R extends {[key: string]: true},
    O extends {[key: string]: true},
  >(opts: {
    required?: R,
    optional?: O,
  }): { [key in keyof R]: string }
    & { [key in keyof O]: string | undefined }
  {
    const required: Array<keyof R> = Object.keys(opts.required ?? {});
    const optional: Array<keyof O> = Object.keys(opts.optional ?? {});
    type T = keyof R | keyof O;

    const obj = Object.create(null);
    const missing = new Set(required);
    const strings: Set<T> = new Set(new Array<keyof O|keyof R>().concat(required, optional));
    for (const child of this.children) {
      if (strings.has(child.name)) {
        obj[child.name as T] = child.content ?? '';
        missing.delete(child.name);
      }
    }
    if (missing.size > 0) this.throwMissingKeys(missing);
    return obj;
  }

  throwMissingKeys(missingKeys: Iterable<string|number|symbol>): never {
    throw new Error(`BUG: XmlNode ${JSON.stringify(this.name)
      } missing required keys ${JSON.stringify(Array.from(missingKeys))
      } - had keys ${JSON.stringify(Array.from(new Set(this.children.map(x => x.name))))}`);
  }
}

/**
 * Parse the given string of `xml`.
 *
 * @param {String} xml
 * @return {Object}
 * @api public
 */

export function parseXml(xml: string, inline = false): Document {
  xml = xml.trim();

  // strip comments
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');

  return {
    declaration: declaration(),
    root: tag(),
  };

  /** Declaration. */
  function declaration(): XmlDeclaration | null {
    var m = match(/^<\?xml\s*/);
    if (!m) return null;

    // tag
    var node: XmlDeclaration = {
      attributes: {},
    };

    // attributes
    while (!(eos() || is('?>'))) {
      var attr = attribute();
      if (!attr) return node;
      node.attributes[attr.name] = attr.value;
    }

    match(/\?>\s*/);

    return node;
  }

  /** Tag. */
  function tag(): XmlNode | null {
    var m = match(/^<([\w-:.]+)\s*/);
    if (!m) return null;

    // name
    var node = new XmlNode(m[1]);

    // attributes
    while (!(eos() || is('>') || is('?>') || is('/>'))) {
      var attr = attribute();
      if (!attr) return node;
      node.attributes[attr.name] = attr.value;
    }

    if (inline) {
      // self closing tag
      if (match(/^\s*\/>/)) {
        return node;
      }

      match(/\??>/);

      const first = content();
      if (first) {
        const textNode = new XmlNode('');
        textNode.content = first;
        node.children.push(textNode);
      }

      let any: boolean;
      do {
        any = false;

        const text = content();
        if (text) {
          const textNode = new XmlNode('');
          textNode.content = text;
          node.children.push(textNode);
          any = true;
        }

        var child;
        while ((child = tag())) {
          node.children.push(child);
          any = true;
        }
      } while (any);

      // closing
      match(/^<\/[\w-:.]+>/);

    } else {
      // self closing tag
      if (match(/^\s*\/>\s*/)) {
        return node;
      }

      match(/\??>\s*/);

      // content
      node.content = content();

      // children
      var child;
      while ((child = tag())) {
        node.children.push(child);
      }

      // closing
      match(/^<\/[\w-:.]+>\s*/);
    }

    return node;
  }

  /** Text content. */
  function content() {
    var m = match(/^([^<]*)/);
    if (m) return decodeXmlEntities(m[1]);
    return '';
  }

  /** Attribute. */
  function attribute() {
    var m = match(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|\w+)\s*/);
    if (!m) return;
    return { name: m[1], value: strip(m[2]) };
  }

  /** Strip quotes from `val`. */
  function strip(val: string) {
    return val.replace(/^['"]|['"]$/g, '');
  }

  /** Match `re` and advance the string. */
  function match(re: RegExp) {
    var m = xml.match(re);
    if (!m) return;
    xml = xml.slice(m[0].length);
    return m;
  }

  /** End-of-source. */
  function eos() {
    return 0 == xml.length;
  }

  /** Check for `prefix`. */
  function is(prefix: string) {
    return xml.startsWith(prefix);
  }
}


// XML entity code is based on /x/html_entities:
// https://deno.land/x/html_entities@v1.0/lib/xml-entities.js

const ALPHA_INDEX: Record<string,string> = {
  "&lt;":   "<",     "&gt;":   ">",
  "&quot;": '"',     "&apos;": "'",
  "&amp;": "&",
};
const CHAR_S_INDEX: Record<string,string> = {
  "<": "&lt;",       ">": "&gt;",
  '"': "&quot;",     "'": "&apos;",
  "&": "&amp;",
};

export function encodeXmlEntities(str: string) {
  return str.replace(/<|>|"|'|&/g, function(s) {
    return CHAR_S_INDEX[s];
  });
}

export function decodeXmlEntities(str: string) {
  return str.replace(/&#?[0-9a-zA-Z]+;?/g, function(s) {
    if (s.charAt(1) === "#") {
      const code = s.charAt(2).toLowerCase() === "x"
        ? parseInt(s.substr(3), 16)
        : parseInt(s.substr(2));

      if (isNaN(code) || code < -32768 || code > 65535) {
        return "";
      }
      return String.fromCharCode(code);
    }
    return ALPHA_INDEX[s] || s;
  });
}

export function readXmlMap<K extends string,T>(entries: XmlNode[], valMapper: (node: XmlNode) => T, {keyName='key', valName='value'}: {keyName?: string, valName?: string}): Record<K, T> {
  const obj: Record<K, T> = Object.create(null);
  for (const entry of entries) {
    obj[entry.first(keyName, true, x => (x.content ?? '') as K)] = entry.first(valName, true, valMapper);
  }
  return obj;
}

export function emitMap<K extends string,V>(obj: Record<K,V> | null | undefined, entryName: string, keyName: string, valEncoder: (val: V) => Node): Partial<Node> {
  if (obj == null) return {};
  if (typeof obj !== 'object') throw new Error(`emitMap got type ${typeof obj}`);
  const pairs = new Array<Node>();
  for (const [key, val] of Object.entries<V>(obj)) {
    pairs.push({name: entryName, children: [
      {name: keyName, content: key},
      valEncoder(val),
    ]});
  }
  return {children: pairs};
}

export function parseTimestamp(str: string | undefined): Date {
  if (str?.includes('T')) return new Date(str);
  if (str?.length === 10) return new Date(parseInt(str) * 1000)
  throw new Error(`Timestamp from server is unparsable: '${str}'`);
}


export interface Node {
  name: string;
  attributes?: {[key: string]: string | undefined};
  content?: string | null;
  children?: Node[];
}

export function stringify(root: Node): string {
  const attrs = root.attributes
    ? Object.entries(root.attributes)
      .filter(x => x[1] !== undefined)
      .map(x => ` ${x[0]}="${encodeXmlEntities(x[1]!)}"`)
      .join('')
    : '';

  if (root.children && !root.content) {
    const contents = root.children.map(x => stringify(x)).filter(x => x);
    if (contents.length < 1) {
      // if (!attrs) return '';
      return `<${root.name}${attrs} />`;
    }
    return `<${root.name}${attrs}>${contents.join('')}</${root.name}>`;

  } else {
    const contents = root.content !== undefined
      ? [encodeXmlEntities(root.content ?? '')]
      : [];

    if (contents.length < 1) {
      if (!attrs) return '';
      return `<${root.name}${attrs} />`;
    }
    return `<${root.name}${attrs}>${contents.join('')}</${root.name}>`;
  }
}
