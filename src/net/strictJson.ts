const MAX_JSON_DEPTH = 16;

class StrictJsonScanner {
  private index = 0;
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  scanTopLevelObject(): boolean {
    try {
      this.skipWhitespace();
      if (this.peek() !== "{") return false;
      this.parseObject(0);
      this.skipWhitespace();
      return this.index === this.text.length;
    } catch {
      return false;
    }
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new Error("json depth");
    const char = this.peek();
    if (char === "{") {
      this.parseObject(depth);
      return;
    }
    if (char === "[") {
      this.parseArray(depth);
      return;
    }
    if (char === '"') {
      this.parseString();
      return;
    }
    if (char === "t") {
      this.consumeLiteral("true");
      return;
    }
    if (char === "f") {
      this.consumeLiteral("false");
      return;
    }
    if (char === "n") {
      this.consumeLiteral("null");
      return;
    }
    this.parseNumber();
  }

  private parseObject(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new Error("json depth");
    this.consume("{");
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.peek() === "}") {
      this.index++;
      return;
    }
    while (true) {
      if (this.peek() !== '"') throw new Error("object key");
      const key = this.parseString();
      if (keys.has(key)) throw new Error("duplicate key");
      keys.add(key);
      this.skipWhitespace();
      this.consume(":");
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.peek();
      if (delimiter === "}") {
        this.index++;
        return;
      }
      this.consume(",");
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new Error("json depth");
    this.consume("[");
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index++;
      return;
    }
    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.peek();
      if (delimiter === "]") {
        this.index++;
        return;
      }
      this.consume(",");
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.consume('"');
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index++;
        const value = JSON.parse(this.text.slice(start, this.index)) as string;
        if (!hasValidSurrogates(value)) throw new Error("invalid surrogate");
        return value;
      }
      if (code < 0x20) throw new Error("control character");
      if (code === 0x5c) {
        this.index++;
        const escape = this.peek();
        if (escape === "u") {
          this.index++;
          for (let count = 0; count < 4; count++) {
            if (!isHex(this.peek())) throw new Error("unicode escape");
            this.index++;
          }
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) throw new Error("string escape");
        this.index++;
        continue;
      }
      this.index++;
    }
    throw new Error("unterminated string");
  }

  private parseNumber(): void {
    if (this.peek() === "-") this.index++;
    if (this.peek() === "0") {
      this.index++;
      if (isDigit(this.peek())) throw new Error("leading zero");
    } else {
      if (!isNonZeroDigit(this.peek())) throw new Error("number");
      while (isDigit(this.peek())) this.index++;
    }
    if (this.peek() === ".") {
      this.index++;
      if (!isDigit(this.peek())) throw new Error("fraction");
      while (isDigit(this.peek())) this.index++;
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.index++;
      if (this.peek() === "+" || this.peek() === "-") this.index++;
      if (!isDigit(this.peek())) throw new Error("exponent");
      while (isDigit(this.peek())) this.index++;
    }
  }

  private consumeLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error("literal");
    }
    this.index += literal.length;
  }

  private consume(char: string): void {
    if (this.peek() !== char) throw new Error("token");
    this.index++;
  }

  private skipWhitespace(): void {
    while (true) {
      const char = this.peek();
      if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") return;
      this.index++;
    }
  }

  private peek(): string {
    return this.text[this.index] ?? "";
  }
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isNonZeroDigit(char: string): boolean {
  return char >= "1" && char <= "9";
}

function isHex(char: string): boolean {
  return (char >= "0" && char <= "9")
    || (char >= "a" && char <= "f")
    || (char >= "A" && char <= "F");
}

function hasValidSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isStrictJsonObject(text: string): boolean {
  return new StrictJsonScanner(text).scanTopLevelObject();
}
